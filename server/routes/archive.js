// ============================================================
// 拾光集 - 压缩包 / 序列帧路由
//   GET /api/zip/scan  目录下压缩包及内图片列表
//   GET /api/zip/img   压缩包内单张图片
//   GET /api/gif       目录序列帧 → 合成 GIF
//   GET /api/zip/gif   压缩包内序列帧 → 合成 GIF
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { jsonRes } = require("../lib/util");
const { ZIP_EXT_RE } = require("../lib/scan");
const { listArchiveImages, streamArchiveImage, hasIniEntry, readIniSpeed } = require("../lib/archive");
const { gifFromDir, gifFromZip, flipArchiveImage } = require("../lib/gif");

// GET /api/zip/scan?dir=
function apiZipScan(query, res) {
  const dir = query.dir || "";
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return jsonRes(res, 400, { ok: false, error: "目录无效" });
  }
  const zips = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !ZIP_EXT_RE.test(e.name)) continue;
    const zp = path.join(dir, e.name);
    // hasIni：包内含 .ini = 3DMigoto mod（贴图倒置存储，需 180° 翻转）；
    // speed ：动画 mod 的 $speed（有序列时用它换算 GIF 帧间隔）。
    // 两者与 images 同出一次列目录（getArchiveMeta 已缓存），rar/7z 不会重复 spawn 7zz。
    const hasIni = hasIniEntry(zp);
    zips.push({ path: zp, name: e.name, images: listArchiveImages(zp), hasIni, speed: hasIni ? readIniSpeed(zp) : null });
  }
  jsonRes(res, 200, { ok: true, zips });
}

// GET /api/zip/img?path=&file=
function apiZipImg(query, res) {
  const zp = query.path || "";
  const file = query.file || "";
  // file 为包内条目名，含 .. 视为路径穿越尝试，直接拒绝
  if (!zp || !fs.existsSync(zp) || !file || file.includes("..")) {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  // 含 ini 的包：贴图倒置存储 → 输出前 180° 翻转（单帧 GIF 承载，理由见 lib/gif.js）
  if (hasIniEntry(zp)) return flipArchiveImage(zp, file, res);
  streamArchiveImage(res, zp, file);
}

// GET /api/gif?dir=&dur_ms=
function apiGif(query, res) {
  const dir = query.dir || "";
  const abs = dir ? path.resolve(dir) : "";
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return jsonRes(res, 400, { ok: false, error: "目录无效" });
  }
  const durMs = parseInt(query.dur_ms || "0", 10);
  gifFromDir(abs, durMs, res);
}

// GET /api/zip/gif?path=&dur_ms=&fps=
// dur_ms：包名带间隔（Pixiv 图包 @40ms/2s）→ 直接作为帧间隔；
// fps   ：游戏渲染帧率，仅在用 ini 的 $speed 换算帧间隔时使用（参数化，默认 60）
function apiZipGif(query, res) {
  const zp = query.path || "";
  if (!zp || !fs.existsSync(zp)) {
    return jsonRes(res, 400, { ok: false, error: "压缩包无效" });
  }
  const durMs = parseInt(query.dur_ms || "0", 10);
  const fps = parseInt(query.fps || "60", 10);
  gifFromZip(zp, durMs, res, { fps });
}

module.exports = { apiZipScan, apiZipImg, apiGif, apiZipGif };
