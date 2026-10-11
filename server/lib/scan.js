// ============================================================
// 拾光集 - 目录递归扫描 + 扫描缓存
// 缓存策略：全量 readdir 昂贵（大图库上万文件），改用「探针」——
// 记录扫描时每个目录的 mtime，下次先 stat 这批目录（不 readdir），
// 全部未变则直接复用上次的图片列表。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { getExcludeDirs } = require("./config");
const { formatSize } = require("./util");

// 2026-10-12 IO 归因（Step 2）：扫描路径埋点。
//   ⚠️ 站点在**创建时**固定（meter 的第一件事就是抓一次栈），之后每次调用只做一次 Map 累加 ——
//   扫描是逐目录/逐文件调用的热路径，**绝不能在每次调用里抓栈**（大图库下是十万级调用）。
//   bytes 语义：真实字节用文件大小；纯计数探针用 1/次（io-monitor 文档：bytes 仅用于归因对比）。
const ioMonitor = require("./io-monitor");
const readdirIo = ioMonitor.meter("scan:readdir", "scan.js:recursiveScanAll/readdirSync");
const imgStatIo = ioMonitor.meter("scan:stat", "scan.js:recursiveScanAll/statSync");
const probeStatIo = ioMonitor.meter("probe:stat", "scan.js:scanCacheStillValid/statSync");

const IMG_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;
const ZIP_EXT_RE = /\.(zip|7z|rar)$/i;

const IMAGE_SCAN_CACHE = new Map(); // 绝对根路径 -> { searchPath, images, dirMtimes, ts, probedAt }
const IMAGE_PROBE_INTERVAL = 30 * 1000; // 探针节流：30s 内不重复 stat 全量目录，直接返回缓存

function statMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (_) {
    return -1;
  }
}

/** 异步 stat（探针用，语义与 statMtime 一致：失败返回 -1） */
async function statMtimeAsync(p) {
  try {
    return (await fs.promises.stat(p)).mtimeMs;
  } catch (_) {
    return -1;
  }
}

// 全树递归扫描：收集图片 + 记录【所有目录】的 mtime
// 2026-10-12 异步化（Step 4）：原实现是纯同步递归（readdirSync + 每图 statSync），冷扫描期间**占满事件循环**
//   （与 gbmd 实测「同步收尾把 /api/* 连续堵死 74 秒」同类）。改法：
//     · fs.promises 异步 I/O（readdir/stat），不再阻塞主线程
//     · 每处理 SCAN_YIELD_EVERY 个目录 `setImmediate` 让出一次 ⇒ 期间服务可响应（总耗时不变）
//     · **单飞**：同一根的并发冷扫描共享同一个 Promise，避免 N 个并发请求各扫一遍
//   ⚠️ 刻意**不做批量 stat**：批量会打乱「DFS + readdir 顺序」的产出顺序（旧实现边遍历边 push），
//   而本次目标是「期间可响应」而非「更快」；顺序保持一致才能满足等价性要求（见 test/scan-async.test.cjs）。
const SCAN_YIELD_EVERY = 30;         // 每处理这么多个目录让出一次事件循环
const INFLIGHT_SCAN = new Map();     // searchPath -> Promise（单飞复用）

async function recursiveScanAll(dir) {
  if (INFLIGHT_SCAN.has(dir)) return INFLIGHT_SCAN.get(dir);   // 单飞：并发请求共享同一轮扫描
  const job = (async () => {
    const images = [];
    const dirMtimes = new Map();
    const exclude = getExcludeDirs();
    let dirsSeen = 0;
    async function scan(d) {
      let entries;
      try {
        entries = await fs.promises.readdir(d, { withFileTypes: true });
        readdirIo(entries.length);   // 归因：本次 readdir 读到的条目数（权重=条目数）
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && exclude.has(entry.name)) continue; // 排除 @eaDir 等
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          await scan(full);          // 内联 DFS：与旧实现顺序一致（目录项按 readdir 顺序就地递归）
        } else if (IMG_EXT_RE.test(entry.name)) {
          try {
            const st = await fs.promises.stat(full);
            imgStatIo(st.size);      // 归因：图片 stat 的真实字节
            images.push({
              name: entry.name,
              path: full,
              url: `/api/media?file=${encodeURIComponent(full)}`,
              size: formatSize(st.size),
              modified: st.mtime.toISOString(),
            });
          } catch (_) {
            /* 扫描期文件被删/无权限，跳过该文件即可 */
          }
        }
      }
      dirMtimes.set(d, statMtime(d));
      if (++dirsSeen % SCAN_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r)); // 让出事件循环
    }
    await scan(dir);
    return { images, dirMtimes };
  })();
  INFLIGHT_SCAN.set(dir, job);
  try {
    return await job;
  } finally {
    INFLIGHT_SCAN.delete(dir);       // 单飞窗口只覆盖「正在扫」的这段
  }
}

// 探针：stat 所有已知目录（不 readdir），全同 → 缓存仍有效
// 2026-10-12 异步化（Step 3）：探针跑在**请求路径**上，大图库时目录上万 ⇒ 同步 stat 一遍会占满事件循环
//   （与 gbmd 实测的「同步收尾把 /api/* 连续堵死 74 秒」同类）。改为「有界并发 + 每批让出事件循环」：
//   总耗时不变，但期间服务可正常响应。调用方必须 await（否则拿到 Promise 恒为真 ⇒ 缓存永不失效）。
const PROBE_CONCURRENCY = 16;
async function scanCacheStillValid(cached) {
  if (statMtime(cached.searchPath) === -1) return false;
  const dirs = [...cached.dirMtimes];
  for (let i = 0; i < dirs.length; i += PROBE_CONCURRENCY) {
    const batch = dirs.slice(i, i + PROBE_CONCURRENCY);
    const same = await Promise.all(batch.map(async ([dir, m]) => (await statMtimeAsync(dir)) === m));
    probeStatIo(batch.length);
    if (same.includes(false)) return false;      // 任一目录变了 → 缓存失效
    await new Promise((r) => setImmediate(r));   // 让出事件循环，避免长时间独占
  }
  return true;
}

module.exports = {
  IMG_EXT_RE,
  ZIP_EXT_RE,
  IMAGE_SCAN_CACHE,
  IMAGE_PROBE_INTERVAL,
  statMtime,
  recursiveScanAll,
  scanCacheStillValid,
};
