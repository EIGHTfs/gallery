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

// 全树递归扫描：收集图片 + 记录【所有目录】的 mtime
// 2026-10-12 粗粒度让出（第二轮方案）：保留**同步 I/O**（readdirSync/statSync），只在每 SCAN_YIELD_EVERY
//   个目录 `await setImmediate` 让出一次事件循环。
//   依据（部署端 bySite 实测）：一次冷扫描 = 21,224 次 readdir + 72,193 次 stat，合计 1.83s
//   ⇒ 单次同步调用仅 ≈0.025ms，500 个目录 ≈ 35–50ms ⇒ 长阻塞被切成小块，接口延迟从 1.78s 降到几十毫秒。
//   ⚠️ 第一轮失败教训（已回滚）：把「逐文件 await fs.promises.stat」与「每 30 目录让出」一起做 ⇒
//   3 万次异步往返把墙钟从 2.08s 拖到 4.58s（+120%）。**同步 I/O + 粗粒度让出** 才是不付性能代价的做法。
//   单飞：同一根的并发冷扫描共享同一个 Promise（避免 N 个并发请求各扫一遍）。
const SCAN_YIELD_EVERY = 500;       // 每处理这么多个目录让出一次（粗粒度：让出本身也有成本）
const INFLIGHT_SCAN = new Map();    // searchPath -> Promise（单飞复用）

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
        entries = fs.readdirSync(d, { withFileTypes: true });   // 同步读：与旧实现同速
        readdirIo(entries.length);                              // 归因：本次 readdir 读到的条目数
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
            const st = fs.statSync(full);   // 同步 stat：与旧实现同速（不做逐文件 async 往返）
            imgStatIo(st.size);             // 归因：图片 stat 的真实字节
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
      if (++dirsSeen % SCAN_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r)); // 粗粒度让出
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
function scanCacheStillValid(cached) {
  if (statMtime(cached.searchPath) === -1) return false;
  for (const [dir, m] of cached.dirMtimes) {
    probeStatIo(1);   // 归因：探针 stat 次数（纯计数，权重记 1/次）
    if (statMtime(dir) !== m) return false;
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
