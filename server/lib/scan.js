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
function recursiveScanAll(dir) {
  const images = [];
  const dirMtimes = new Map();
  const exclude = getExcludeDirs();
  function scan(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && exclude.has(entry.name)) continue; // 排除 @eaDir 等
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (IMG_EXT_RE.test(entry.name)) {
        try {
          const st = fs.statSync(full);
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
  }
  scan(dir);
  return { images, dirMtimes };
}

// 探针：stat 所有已知目录（不 readdir），全同 → 缓存仍有效
function scanCacheStillValid(cached) {
  if (statMtime(cached.searchPath) === -1) return false;
  for (const [dir, m] of cached.dirMtimes) {
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
