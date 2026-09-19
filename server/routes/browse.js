// ============================================================
// 拾光集 - 浏览类路由（目录/图片/媒体）
//   GET /api/directories  顶层目录列表
//   GET /api/images       某目录图片（支持 recursive 递归 + 扫描缓存）
//   GET /api/dir          按需加载单层目录（优先命中递归缓存）
//   GET /api/media        按绝对路径输出图片
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { jsonRes, streamFile, formatSize } = require("../lib/util");
const { queryRoot, getExcludeDirs } = require("../lib/config");
const {
  IMG_EXT_RE,
  IMAGE_SCAN_CACHE,
  IMAGE_PROBE_INTERVAL,
  statMtime,
  recursiveScanAll,
  scanCacheStillValid,
} = require("../lib/scan");

// GET /api/directories
function apiDirectories(query, res) {
  const root = queryRoot(query);
  try {
    const exclude = getExcludeDirs();
    const items = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !exclude.has(d.name))
      .map((d) => d.name)
      .sort();
    jsonRes(res, 200, { root, items });
  } catch (e) {
    jsonRes(res, 500, { error: e.message });
  }
}

// GET /api/images?root=&path=&recursive=false&noCache=
function apiImages(query, res) {
  const root = queryRoot(query);
  const relativePath = query.path || "";
  const recursive = query.recursive === "true";
  const searchPath = path.join(root, relativePath);

  try {
    if (!fs.existsSync(searchPath)) {
      return jsonRes(res, 200, { path: searchPath, count: 0, images: [] });
    }

    let files = [];

    if (recursive) {
      // 后端扫描缓存懒刷新：探针节流（noCache 强制跳过缓存，用于上传后立即刷新）
      const noCache = query.noCache === "true";
      const now = Date.now();
      const cached = IMAGE_SCAN_CACHE.get(searchPath);
      if (noCache || !cached || now - cached.probedAt >= IMAGE_PROBE_INTERVAL) {
        const sc =
          noCache || !cached || !scanCacheStillValid(cached)
            ? recursiveScanAll(searchPath)
            : { images: cached.images, dirMtimes: cached.dirMtimes };
        files = sc.images;
        IMAGE_SCAN_CACHE.set(searchPath, {
          searchPath,
          images: files,
          dirMtimes: sc.dirMtimes,
          ts: now,
          probedAt: now,
        });
      } else {
        files = cached.images;
        cached.probedAt = now;
      }
    } else {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const d of entries) {
        if (/\.(jpg|jpeg|png|webp|gif)$/i.test(d.name)) {
          try {
            const fullPath = path.join(searchPath, d.name);
            const stat = fs.statSync(fullPath);
            files.push({
              name: d.name,
              path: fullPath,
              url: `/api/media?file=${encodeURIComponent(fullPath)}`,
              size: formatSize(stat.size),
              modified: stat.mtime.toISOString(),
            });
          } catch (e) {
            /* 扫描期文件变动，跳过 */
          }
        }
      }
    }

    jsonRes(res, 200, { path: searchPath, root, recursive, count: files.length, images: files });
  } catch (e) {
    jsonRes(res, 500, { error: e.message, images: [] });
  }
}

// 从递归缓存里取「指定层」的直接图片与该层子目录（含深层时只取第一段）。
// 从 apiDir 抽出：纯数据筛选，便于单测与复用。
function collectFromCache(allImages, relativePath, prefix, root) {
  const subdirs = [];
  const images = [];
  const seen = new Set();
  const rootPrefix = root + "/";
  for (const im of allImages) {
    if (!im.path.startsWith(rootPrefix)) continue;
    const rel = im.path.slice(root.length + 1);
    const slash = rel.lastIndexOf("/");
    const dir = slash > 0 ? rel.slice(0, slash) : "";
    if (dir === relativePath) {
      images.push(im);
      continue;
    }
    if (relativePath) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      const seg = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
      if (seg && !seen.has(seg)) {
        seen.add(seg);
        const subRel = prefix + seg;
        subdirs.push({ name: seg, relPath: subRel, root, sig: statMtime(path.join(root, subRel)) });
      }
    } else if (dir) {
      const seg = dir.includes("/") ? dir.slice(0, dir.indexOf("/")) : dir;
      if (seg && !seen.has(seg)) {
        seen.add(seg);
        subdirs.push({ name: seg, relPath: seg, root, sig: statMtime(path.join(root, seg)) });
      }
    }
  }
  return { subdirs, images };
}

// 统计每个子目录的图片数 / mtime / 是否含子目录 / 叶子目录直图。
// 从 apiDir 的缓存分支抽出：这段是纯计算，与「取哪层目录」的流程无关。
function annotateSubdirStats(subdirs, allImages, root) {
  const rootPrefix = root + "/";
  for (const sd of subdirs) {
    let count = 0;
    let maxMtime = 0;
    let hasSub = false;
    const leafImgs = [];
    const sdPrefix = sd.relPath + "/";
    for (const im of allImages) {
      if (!im.path.startsWith(rootPrefix)) continue;
      const rel = im.path.slice(root.length + 1);
      const slash = rel.lastIndexOf("/");
      const dir = slash > 0 ? rel.slice(0, slash) : "";
      if (dir === sd.relPath || dir.startsWith(sdPrefix)) {
        count++;
        const mt = im.modified ? new Date(im.modified).getTime() : 0;
        if (mt > maxMtime) maxMtime = mt;
        if (dir === sd.relPath) leafImgs.push(im);
      }
      if (dir.startsWith(sdPrefix)) hasSub = true;
    }
    sd.count = count;
    sd.mtime = maxMtime;
    sd.hasSub = hasSub;
    if (!hasSub) sd.leafImages = leafImgs;
  }
}

// 单层扫描（无递归缓存时的回落路径）：只读该层，不回传深层。
// 子目录 count/mtime 置为「未知」(-1 / 0)，hasSub 假定为 true——前端据此按需再拉。
function scanOneLevel(searchPath, relativePath, root) {
  const subdirs = [];
  const images = [];
  const exclude = getExcludeDirs();
  let entries;
  try {
    entries = fs.readdirSync(searchPath, { withFileTypes: true });
  } catch (_) {
    entries = [];
  }
  for (const e of entries) {
    const full = path.join(searchPath, e.name);
    if (e.isDirectory() && exclude.has(e.name)) continue; // 排除 @eaDir 等
    if (e.isDirectory()) {
      const rel = relativePath ? relativePath + "/" + e.name : e.name;
      subdirs.push({ name: e.name, relPath: rel, root, sig: statMtime(full) });
    } else if (IMG_EXT_RE.test(e.name)) {
      try {
        const st = fs.statSync(full);
        images.push({
          name: e.name,
          path: full,
          url: `/api/media?file=${encodeURIComponent(full)}`,
          size: formatSize(st.size),
          modified: st.mtime.toISOString(),
        });
      } catch (_) {
        /* 单文件 stat 失败，跳过 */
      }
    }
  }
  for (const sd of subdirs) {
    sd.count = -1;
    sd.mtime = 0;
    sd.hasSub = true;
  }
  return { subdirs, images };
}

// GET /api/dir?root=&path= — 按需加载单层目录内容
// 思路：不再前端全量递归拉；访问哪个目录就返回哪层，从递归缓存秒取，无缓存则单层扫
function apiDir(query, res) {
  const root = queryRoot(query);
  const relativePath = query.path || "";
  const searchPath = path.join(root, relativePath);

  try {
    if (!fs.existsSync(searchPath)) {
      return jsonRes(res, 200, { root, path: relativePath, subdirs: [], images: [], sig: 0 });
    }

    const dirMtime = statMtime(searchPath);
    const prefix = relativePath ? relativePath + "/" : "";

    // 优先从递归扫描缓存取（秒级，无需再扫）
    const cached = IMAGE_SCAN_CACHE.get(root);
    if (cached && scanCacheStillValid(cached)) {
      cached.probedAt = Date.now();
      const { subdirs, images } = collectFromCache(cached.images, relativePath, prefix, root);
      annotateSubdirStats(subdirs, cached.images, root);
      return jsonRes(res, 200, { root, path: relativePath, subdirs, images, sig: dirMtime });
    }

    // 无递归缓存：单层扫描
    const { subdirs, images } = scanOneLevel(searchPath, relativePath, root);
    jsonRes(res, 200, { root, path: relativePath, subdirs, images, sig: dirMtime });
  } catch (e) {
    jsonRes(res, 500, { error: e.message, subdirs: [], images: [] });
  }
}

// GET /api/media?file= — 按路径输出图片
function apiMedia(query, res) {
  const filePath = query.file ? decodeURIComponent(query.file) : "";
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  streamFile(res, filePath);
}

module.exports = { apiDirectories, apiImages, apiDir, apiMedia };
