// ============================================================
// IO 监测（项目自带探针）：真实读写速率 + 按来源**与调用点**归因
//
// 为什么需要（2026-10-11/12 实测驱动）：
//   磁盘被大量读写时，日志里往往只看到「某类操作在连刷」，看不出到底是谁在占 IO——
//   排查只能靠外部 strace/iotop（NAS 上还没有）。本模块把两件事做进项目：
//     ① 采样 /proc/self/io 拿**进程真实**读写字节数 → 算出速率（每 intervalMs 一次，超阈值打日志）
//     ② 提供计数接口让各读写点**自报用量** → 归因表直接回答「谁在读/谁在写」
//
// 2026-10-12 扩展：从「按 label」细化到「**按调用点**」（file:line）——
//   起因：写盘 120MB/s 时只看得出 label（如 index-read / task-write），定位不到具体是哪一行在写；
//   实际排查中真正省时间的是「哪个函数、哪一行」。
//
// 用法（两种，按调用频率选）：
//   // ① 热路径（每次调用都要便宜）：meter 在**创建时**抓一次栈拿站点，之后每次只做 Map 累加
//   const hashIo = ioMonitor.meter("hash");     // 模块级创建一次
//   stream.on("data", (c) => { hashIo(c.length); });
//
//   // ② 低频/临时（兼容旧写法）：站点记为 "(未标注)"
//   ioMonitor.count("task-write", bytes);
//   ioMonitor.count("task-write", bytes, "download-task-store.js:83");   // 也可显式给站点
//
//   io.start({ intervalMs: 10000, logThresholdMBps: 2 });   // 启动时调用一次
//   io.snapshot()                                           // → 速率 + 累计 + byLabel + bySite（/api/io 用它）
//
// ⚠️ 性能红线：**禁止在热路径里抓栈**。`count`/`meter` 返回的函数在下载分块（stream data）里被
//   逐块调用（47k 文件 ⇒ 百万级调用），每次 new Error().stack 会直接拖垮下载。
//   故站点只在 meter() 创建时捕获一次；count() 的站点要么显式传，要么记 "(未标注)"。
//
// 兼容：非 Linux（无 /proc/self/io）自动降级为「只统计自报归因」，不影响任何功能。
// ============================================================
"use strict";

const fs = require("fs");

const PROC_IO = "/proc/self/io";
let started = false;
let intervalMs = 10000;
let logThresholdMBps = 2;
let timer = null;
let startedAt = 0;
let prev = null;          // 上一次采样 { t, readBytes, writeBytes, syscr, syscw }
let last = null;          // 最近一次采样（同上）
const byLabel = new Map(); // label -> 累计字节（由各读写点自报）
const bySite = new Map();  // label -> Map(site -> { bytes, calls })

function readProcIo() {
  try {
    const txt = fs.readFileSync(PROC_IO, "utf8");
    const get = (k) => {
      const m = txt.match(new RegExp("^" + k + ":\\s*(\\d+)", "m"));
      return m ? Number(m[1]) : 0;
    };
    return { t: Date.now(), readBytes: get("read_bytes"), writeBytes: get("write_bytes"), syscr: get("syscr"), syscw: get("syscw") };
  } catch (_) {
    return null; // 非 Linux 或无权限 → 降级
  }
}

/** 人类可读体积（B/KB/MB/GB，1 位小数） */
function human(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(2) + " GB";
}

/**
 * 捕获调用点（file:line）。
 * **只允许在 meter() 创建时调用**——它内部会 new Error()，属昂贵操作，热路径禁用。
 * @returns {string} 形如 "downloader.js:69"；拿不到时返回 "(未知)"
 */
function captureSite() {
  const stack = String((new Error().stack) || "").split("\n");
  // [0]=Error [1]=captureSite [2]=meter [3]=真正的调用方（再往外是模块加载栈，跳过）
  for (let i = 3; i < stack.length; i += 1) {
    const m = stack[i].match(/\(?([^()\s]+):(\d+):\d+\)?\s*$/);
    if (!m) continue;
    const file = m[1].replace(/^.*[\\/]/, "");
    if (file === "io-monitor.js") continue;   // 跳过本模块自身的包装层
    return `${file}:${m[2]}`;
  }
  return "(未知)";
}

/** 取得某 label 的站点表（无则建） */
function siteTable(label) {
  if (!bySite.has(label)) bySite.set(label, new Map());
  return bySite.get(label);
}

/** 记一笔（内部用）：累计到 label 总量与站点格子 */
function add(label, bytes, site) {
  const n = Number(bytes) || 0;
  byLabel.set(label, (byLabel.get(label) || 0) + n);
  const table = siteTable(label);
  if (!table.has(site)) table.set(site, { bytes: 0, calls: 0 });
  const cell = table.get(site);
  cell.bytes += n;
  cell.calls += 1;
}

/**
 * 建一个「绑定到当前调用点」的计数函数（**热路径首选**）。
 * 站点在创建时抓一次栈，返回的函数每次只做一次 Map 累加 —— 零 per-call 开销。
 * @param {string} label 归因标签（自定，如 "hash" / "download-write"）
 * @returns {(bytes:number)=>void}
 */
function meter(label, site) {
  const k = String(label || "other");
  // site 可显式给（模块级创建时更稳：不依赖抓栈能否解析出行号）；不给则抓一次栈
  const at = site ? String(site) : captureSite();
  return function report(bytes) { add(k, bytes, at); };
}

/**
 * 各读写点自报用量（兼容写法；低频调用用，热路径请用 meter）。
 * @param {string} label 归因标签
 * @param {number} bytes 字节数（或条目数，仅用于对比）
 * @param {string} [site] 调用点；不传记 "(未标注)"（**不要为了填它而在热路径抓栈**）
 */
function count(label, bytes, site) {
  add(String(label || "other"), bytes, String(site || "(未标注)"));
}

/** 归因表（按用量降序） */
function topLabels(limit) {
  const arr = [...byLabel.entries()].map(([label, bytes]) => ({ label, bytes, human: human(bytes) }));
  arr.sort((a, b) => b.bytes - a.bytes);
  return limit ? arr.slice(0, limit) : arr;
}

/** 调用点归因表（按用量降序，带 label/site/字节/次数） */
function topSites(limit) {
  const arr = [];
  for (const [label, table] of bySite) {
    for (const [site, cell] of table) {
      arr.push({ label, site, bytes: cell.bytes, calls: cell.calls, human: human(cell.bytes) });
    }
  }
  arr.sort((a, b) => b.bytes - a.bytes);
  return limit ? arr.slice(0, limit) : arr;
}

function sample(doLog) {
  const cur = readProcIo();
  if (!cur) return;
  if (last) prev = last;
  last = cur;
  if (!doLog || !prev) return;
  const dt = Math.max(1, (cur.t - prev.t) / 1000);
  const rMB = (cur.readBytes - prev.readBytes) / 1048576 / dt;
  const wMB = (cur.writeBytes - prev.writeBytes) / 1048576 / dt;
  if (rMB >= logThresholdMBps || wMB >= logThresholdMBps) {
    // 2026-10-12：日志同时给出「最热调用点」——只报 label 时定位不到具体哪一行
    const hot = topSites(1)[0];
    console.log(`[io] 读 ${rMB.toFixed(2)} MB/s · 写 ${wMB.toFixed(2)} MB/s｜自上次采样新增读写调用 ${cur.syscr - prev.syscr}/${cur.syscw - prev.syscw}` +
      (byLabel.size ? "｜归因: " + topLabels(3).map((x) => `${x.label} ${human(x.bytes)}`).join(" / ") : "") +
      (hot ? `｜最热调用点: ${hot.label}@${hot.site} ${hot.human} ×${hot.calls}` : ""));
  }
}

/** 启动周期采样（幂等；无 /proc/self/io 时只启用归因统计） */
function start(opts = {}) {
  if (started) return { ok: true, already: true };
  started = true;
  startedAt = Date.now();
  if (opts.intervalMs) intervalMs = opts.intervalMs;
  if (opts.logThresholdMBps != null) logThresholdMBps = opts.logThresholdMBps;
  const probe = readProcIo();
  if (!probe) return { ok: true, enabled: false, reason: "无 /proc/self/io（非 Linux？）" };
  last = probe;
  timer = setInterval(() => sample(true), intervalMs);
  if (timer.unref) timer.unref();
  return { ok: true, enabled: true, intervalMs };
}

/** 快照：真实速率 + 累计 + 按 label / 按调用点归因表（供 GET /api/io） */
function snapshot() {
  if (!last) last = readProcIo();
  const out = {
    ok: true,
    enabled: !!last,
    intervalMs,
    uptimeMs: startedAt ? Date.now() - startedAt : 0,
    byLabel: topLabels(20),
    bySite: topSites(20)          // 2026-10-12 新增：站点表（增量字段，旧消费方不受影响）
  };
  if (last) {
    out.self = { readBytes: last.readBytes, writeBytes: last.writeBytes, syscr: last.syscr, syscw: last.syscw };
    if (prev) {
      const dt = Math.max(1, (last.t - prev.t) / 1000);
      out.rate = {
        readMBps: Number(((last.readBytes - prev.readBytes) / 1048576 / dt).toFixed(3)),
        writeMBps: Number(((last.writeBytes - prev.writeBytes) / 1048576 / dt).toFixed(3)),
        windowSec: Math.round(dt)
      };
    }
    out.selfHuman = { read: human(last.readBytes), write: human(last.writeBytes) };
  }
  return out;
}

/** 停止采样（测试/退出用）；同时清空归因表，便于测试隔离 */
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
  return { ok: true };
}

/** 清空归因表（测试用：保证用例之间互不污染） */
function reset() {
  byLabel.clear();
  bySite.clear();
  return { ok: true };
}

module.exports = { start, stop, count, meter, snapshot, topLabels, topSites, human, reset, captureSite };
