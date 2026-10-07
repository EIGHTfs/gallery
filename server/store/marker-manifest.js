// 源码标记清单生成器（框架层·通用）
//
// 核心：把「哪些文件属于某类数据」从硬编码改为**源码注释自动生成**——
// 写文件的地方顺手标注，扫描源码汇总成清单，避免清单与代码脱节。
//
// 标记语法（写在相关代码的注释里）：
//
//   //<文件名.json> <file|dir> <相对路径> [key=value ...] [说明文字]
//
//   · 注释里写的是什么 json 名，就生成什么 json（不限于内置的两个）
//   · file = 单个文件；dir = 目录（可跟 .后缀 限定扩展名）
//   · key=value 为任意附加字段，直接写进清单条目
//   · 末尾不加等号的自由文本会作为 desc（方便阅读）
//
// 实例：
//   //userdata-manifest.json file json/download_task.json desc=下载任务列表
//   //userdata-manifest.json dir  json/index .json desc=按游戏拆分的索引
//   //runtime-manifest.json  file server/sessions.json desc=会话持久化 watch=skip
//   //backup-only.json       file server/config.json required=1 desc=服务配置
//
// 生成物（写盘时）：
//   { "schema": 1, "app": "...", "generatedAt": "...", "note": "...", "items": { ... } }
//   条目按 kind 分组到 files / dirs 两个数组，字段原样保留。
"use strict";

const fs = require("fs");
const path = require("path");

// 扫描缓存：同参数只扫一次（可用 clearScanCache 清空）
const scanCache = new Map();

// 已知的非字段 token（自由文本段里若出现这些，按字面保留在 desc）
const KIND_FILE = "file";
const KIND_DIR = "dir";

/**
 * 解析单行注释中的标记。
 * @returns {null|{json:string, kind:string, rel:string, fields:object, desc:string}}
 */
function parseMarkerLine(line) {
  const text = String(line || "");
  const i = text.indexOf("//");
  if (i < 0) return null;
  const rest = text.slice(i + 2).trim();
  if (!rest) return null;

  // 第一段必须是 xxx.json
  const first = rest.split(/\s+/)[0];
  if (!/^[A-Za-z0-9._-]+\.json$/.test(first)) return null;
  const json = first;

  const parts = rest.slice(first.length).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const kind = parts[0];
  if (kind !== KIND_FILE && kind !== KIND_DIR) return null;
  const rel = parts[1];
  if (!rel) return null;

  const fields = {};
  const descParts = [];
  let suffix = "";
  let idx = 2;
  while (idx < parts.length) {
    const tok = parts[idx];
    const eq = tok.indexOf("=");
    if (eq > 0) {
      const k = tok.slice(0, eq);
      let v = tok.slice(eq + 1);
      // 支持带空格的引号值：desc="服务配置（例外留在 server/）"
      if (v.charAt(0) === '"' && v.charAt(v.length - 1) !== '"') {
        const quoted = [v.slice(1)];
        idx++;
        while (idx < parts.length && !parts[idx].endsWith('"')) {
          quoted.push(parts[idx]);
          idx++;
        }
        if (idx < parts.length) quoted.push(parts[idx].slice(0, -1));
        v = quoted.join(" ");
      } else if (v.charAt(0) === '"') {
        v = v.slice(1, -1);
      }
      fields[k] = v;
    } else if (tok.charAt(0) === "." && kind === KIND_DIR) {
      suffix = tok;                       // dir 的扩展名限定（旧写法兼容）
    } else {
      descParts.push(tok);
    }
    idx++;
  }
  if (suffix) fields.suffix = suffix;

  return { json: json, kind: kind, rel: rel, fields: fields, desc: descParts.join(" ") };
}

/**
 * 扫描源码，按 json 文件名分组收集条目。
 * @param {object} opts
 * @param {string}   opts.root       项目根目录（rel 以此为基准）
 * @param {string[]} [opts.scanDirs] 扫描目录（相对 root，默认 ["server"]）
 * @param {string[]} [opts.skipDirs] 跳过目录名（默认 ["node_modules","public"]）
 * @param {boolean}  [opts.cache]    是否缓存（默认 true）
 * @returns {Map<string, {files:Array, dirs:Array}>} key = json 文件名
 */
function scanMarkers(opts) {
  const root = opts.root;
  const scanDirs = opts.scanDirs || ["server"];
  const skipDirs = opts.skipDirs || ["node_modules", "public", "framework"];
  const useCache = opts.cache !== false;

  const cacheKey = [root, scanDirs.join(","), skipDirs.join(",")].join("|");
  if (useCache && scanCache.has(cacheKey)) return scanCache.get(cacheKey);

  const byJson = new Map();

  function add(hit) {
    if (!byJson.has(hit.json)) byJson.set(hit.json, { files: [], dirs: [] });
    const bucket = byJson.get(hit.json);
    const arr = hit.kind === KIND_FILE ? bucket.files : bucket.dirs;
    const key = hit.rel + "|" + (hit.fields.suffix || "");
    if (arr.some((e) => (e.rel + "|" + (e.suffix || "")) === key)) return; // 去重
    // 条目字段 = 标记里的 k=v + 自由文本 desc
    const entry = Object.assign({ rel: hit.rel }, hit.fields);
    if (entry.desc === undefined) entry.desc = hit.desc || "";
    arr.push(entry);
  }

  function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      if (skipDirs.includes(n) || n.charAt(0) === ".") continue;
      const abs = path.join(dir, n);
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|cjs)$/.test(n)) continue;
      let text;
      try { text = fs.readFileSync(abs, "utf8"); } catch (_) { continue; }
      for (const line of text.split(/\r?\n/)) {
        const hit = parseMarkerLine(line);
        if (hit) add(hit);
      }
    }
  }

  for (const d of scanDirs) walk(path.join(root, d));

  for (const bucket of byJson.values()) {
    bucket.files.sort((a, b) => a.rel.localeCompare(b.rel));
    bucket.dirs.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  if (useCache) scanCache.set(cacheKey, byJson);
  return byJson;
}

/**
 * 生成指定 json 的完整清单对象。
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.json   目标 json 文件名（如 "userdata-manifest.json"）
 * @param {string} [opts.app]  应用名
 * @returns {object} { schema, app, generatedAt, note, files, dirs }
 */
function buildManifest(opts) {
  const all = scanMarkers(opts);
  const bucket = all.get(opts.json) || { files: [], dirs: [] };
  return {
    schema: 1,
    app: opts.app || "",
    generatedAt: new Date().toISOString(),
    note: "根据源码 //" + opts.json + " 注释自动生成，不要手改。",
    files: bucket.files,
    dirs: bucket.dirs,
  };
}

/**
 * 取指定 json 的所有路径（auto-update 判排除用）。
 * @returns {string[]}
 */
function manifestPaths(opts) {
  const all = scanMarkers(opts);
  const bucket = all.get(opts.json) || { files: [], dirs: [] };
  return bucket.files.map((f) => f.rel).concat(bucket.dirs.map((d) => d.rel));
}

/**
 * 按字段筛选条目（如只要 watch=skip 的）。
 * @param {object} opts
 * @param {string} opts.field  字段名
 * @param {string} opts.value  期望值
 * @returns {string[]} rel 列表
 */
function manifestPathsByField(opts) {
  const all = scanMarkers(opts);
  const bucket = all.get(opts.json) || { files: [], dirs: [] };
  const hit = (e) => String(e[opts.field]) === String(opts.value);
  return bucket.files.filter(hit).map((f) => f.rel)
    .concat(bucket.dirs.filter(hit).map((d) => d.rel));
}

/** 已扫描到的 json 名清单（调试用） */
function listMarkers(opts) {
  return Array.from(scanMarkers(opts).keys());
}

function clearScanCache() {
  scanCache.clear();
}

module.exports = {
  parseMarkerLine,
  scanMarkers,
  buildManifest,
  manifestPaths,
  manifestPathsByField,
  listMarkers,
  clearScanCache,
};
