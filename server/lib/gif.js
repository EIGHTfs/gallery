// ============================================================
// 拾光集 - 序列帧检测 + GIF 合成
// 目录/压缩包内的「前缀+连号」图片视为序列帧，用 ffmpeg 合成 GIF，
// 结果按 内容指纹 缓存到 cache-gifs/，命中直接复用。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const { jsonRes } = require("./util");
const { IMG_EXT_RE } = require("./scan");
const { SEVEN_ZIP, listArchiveImages, listZipEntriesNode, readZipEntryData, hasIniEntry, readIniSpeed, readArchiveEntryData } = require("./archive");
const { detectTool } = require("../tool/tool-detect.js");

const CACHE_GIF_DIR = path.join(__dirname, "..", "..", "cache-gifs");

// ffmpeg 选用：环境变量 > 项目工具目录（tool/ 或 tools/，自带 lib）> 系统路径
// 统一走 tool/tool-detect.js（存在 + 可执行 + 版本实测，失败自动降级）；
// 全部不可用时兜底裸名 "ffmpeg"（由 exec 走 PATH），行为与原 _pickFfmpeg 一致。
const _ff = detectTool("ffmpeg") || { bin: "ffmpeg", lib: "" };
const FFMPEG = _ff.bin;
const FFMPEG_LIB = _ff.lib;

// 序列帧判定：文件 ≥3、文件名「前缀+固定宽度数字+扩展名」、前缀相同、数字连续递增
function detectFramesFromDir(files) {
  if (!files || files.length < 3) return null;
  const groups = new Map();
  for (const f of files) {
    const m = String(f).match(/^(.*?)(\d+)(\.\w+)$/);
    if (!m) continue;
    const key = m[1];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ n: parseInt(m[2], 10), ext: m[3], file: f });
  }
  let best = null;
  for (const arr of groups.values()) {
    if (arr.length < 3) continue;
    const sorted = arr.slice().sort((a, b) => a.n - b.n);
    let run = [sorted[0]];
    let bestRun = run;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].n === sorted[i - 1].n + 1) run.push(sorted[i]);
      else {
        if (run.length > bestRun.length) bestRun = run;
        run = [sorted[i]];
      }
    }
    if (run.length > bestRun.length) bestRun = run;
    if (bestRun.length >= 3 && (!best || bestRun.length > best.frames.length)) {
      best = { frames: bestRun };
    }
  }
  return best;
}

/**
 * 由 ini 的 $speed 换算 GIF 每帧时长（毫秒）。
 * 依据《动画mod制作指南》：`$frame = $frame + $speed` 每渲染帧递进 $speed，
 * 故一个动画帧时长 = 1/(fps×speed) 秒；fps 为游戏渲染帧率（API 参数化，默认 60）。
 * 结果夹到 ≥10ms（GIF 的 GCE 延迟以 10ms 为单位，更小无意义）。
 */
function frameMsFromIniSpeed(speed, fps) {
  const f = Number(fps) > 0 ? Number(fps) : 60;
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.max(10, Math.round(1000 / (f * s)));
}

// 构造 ffmpeg 参数（帧序列 → 循环 GIF，宽度超过 480 等比缩小）
// flip=true：含 ini 的 3DMigoto mod，包内贴图是**倒置存储**，合成前先 180° 翻转（vflip+hflip）
function _gifArgs(pattern, frameMs, gifFile, flip) {
  const vf = (flip ? "vflip,hflip," : "") + "scale=w='if(gt(iw,480),480,iw)':h=-1";
  return [
    "-y",
    "-framerate", String(1000 / frameMs),
    "-start_number", "0",
    "-i", pattern,
    "-vf", vf,
    "-loop", "0",
    gifFile,
  ];
}

// 跑 ffmpeg：自带 binary 失败时回退系统 ffmpeg（lib 依赖可能缺）
function _runFfmpeg(args) {
  const sysFfmpeg = fs.existsSync("/usr/bin/ffmpeg") && FFMPEG !== "/usr/bin/ffmpeg" ? "/usr/bin/ffmpeg" : "";
  try {
    execFileSync(FFMPEG, args, {
      timeout: 30000,
      env: FFMPEG_LIB ? Object.assign({}, process.env, { LD_LIBRARY_PATH: FFMPEG_LIB }) : undefined,
    });
  } catch (e) {
    if (sysFfmpeg) {
      execFileSync(sysFfmpeg, args, { timeout: 30000 });
      return;
    }
    throw e;
  }
}

function _sendGif(res, gifFile) {
  res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-cache" });
  fs.createReadStream(gifFile).pipe(res);
}

// 目录序列帧 → 合成 GIF（缓存 cache-gifs/<hash>.gif）并流式返回
function gifFromDir(absDir, durMs, res) {
  let files = [];
  try {
    files = fs.readdirSync(absDir).filter((f) => IMG_EXT_RE.test(f));
  } catch (_) {
    files = [];
  }
  const det = detectFramesFromDir(files);
  if (!det) {
    jsonRes(res, 400, { ok: false, error: "非序列帧目录", frames: 0 });
    return;
  }
  try {
    fs.mkdirSync(CACHE_GIF_DIR, { recursive: true });
  } catch (_) {
    /* 缓存目录已存在或不可建：后续写入会报错并返回 500 */
  }
  const frameMs = Number.isFinite(durMs) && durMs > 0 ? durMs : Math.round(2000 / Math.max(1, det.frames.length));
  let mtime = 0;
  try {
    mtime = fs.statSync(absDir).mtimeMs;
  } catch (_) {
    /* 目录刚被删：mtime 保持 0，仍按帧列表算 hash */
  }
  const hash = crypto
    .createHash("sha1")
    .update(absDir + "|" + det.frames.map((f) => f.file).join(",") + "|" + mtime + "|" + frameMs)
    .digest("hex")
    .slice(0, 16);
  const gifFile = path.join(CACHE_GIF_DIR, hash + ".gif");
  if (!fs.existsSync(gifFile)) {
    const f0 = det.frames[0];
    const frameTmp = path.join(CACHE_GIF_DIR, hash + "-f");
    try {
      fs.mkdirSync(frameTmp, { recursive: true });
    } catch (_) {
      /* 已存在 */
    }
    det.frames.forEach((f, i) => {
      try {
        fs.copyFileSync(path.join(absDir, f.file), path.join(frameTmp, "frame_" + String(i).padStart(3, "0") + f.ext));
      } catch (_) {
        /* 单帧拷贝失败：ffmpeg 会因缺帧报错，走下面的失败分支 */
      }
    });
    try {
      _runFfmpeg(_gifArgs(path.join(frameTmp, "frame_%03d" + f0.ext), frameMs, gifFile));
    } catch (e) {
      try {
        fs.rmSync(gifFile, { force: true });
      } catch (_) {
        /* 清理失败不影响错误返回 */
      }
      try {
        fs.rmSync(frameTmp, { recursive: true, force: true });
      } catch (_) {
        /* 同上 */
      }
      jsonRes(res, 500, { ok: false, error: "GIF 合成失败" });
      return;
    }
    try {
      fs.rmSync(frameTmp, { recursive: true, force: true });
    } catch (_) {
      /* 临时帧目录残留不影响结果 */
    }
  }
  _sendGif(res, gifFile);
}

// 压缩包内序列帧 → 合成 GIF
// 规则（共 4 条）：
//   ① 包名带间隔（@40ms / 2s，Pixiv 图包）→ 按该间隔合成，**不翻转**；
//   ② 含 ini（3DMigoto mod）→ **ini 决定翻转 180°**；且有序列 且 ini 有 $speed 时按
//      1000/(fps×$speed) 换算帧间隔合成；
//   ③ 两者都无 → 不合成（此处直接拒绝）；
//   ④ 含 ini 但无序列（或 ini 无 $speed）→ 不合成，只翻转（由 /api/zip/img 负责）。
// opts.fps：游戏渲染帧率（仅用于 $speed 换算），API 参数化，默认 60。
function gifFromZip(zipPath, durMs, res, opts) {
  const fps = opts && Number(opts.fps) > 0 ? Number(opts.fps) : 60;
  const images = listArchiveImages(zipPath);
  const det = detectFramesFromDir(images.map((i) => i.name));
  if (!det) {
    jsonRes(res, 400, { ok: false, error: "压缩包内非序列帧" });
    return;
  }
  const hasIni = hasIniEntry(zipPath);
  const speed = hasIni ? readIniSpeed(zipPath) : null;
  const flip = hasIni; // ini 决定翻转
  const frameMs = Number.isFinite(durMs) && durMs > 0
    ? durMs
    : (speed ? frameMsFromIniSpeed(speed, fps) : 0);
  if (!frameMs) {
    jsonRes(res, 400, { ok: false, error: "无帧间隔来源：包名未带 @NNms，且包内 ini 无 $speed" });
    return;
  }
  try {
    fs.mkdirSync(CACHE_GIF_DIR, { recursive: true });
  } catch (_) {
    /* 缓存目录已存在 */
  }
  let zmtime = 0;
  try {
    zmtime = fs.statSync(zipPath).mtimeMs;
  } catch (_) {
    /* 包被删：mtime 保持 0 */
  }
  const zhash = crypto
    .createHash("sha1")
    .update(zipPath + "|" + det.frames.map((f) => f.file).join(",") + "|" + zmtime + "|" + frameMs + "|" + fps + "|" + (flip ? "flip" : ""))
    .digest("hex")
    .slice(0, 16);
  const gifFile = path.join(CACHE_GIF_DIR, zhash + ".gif");
  if (!fs.existsSync(gifFile)) {
    const tmpDir = path.join(CACHE_GIF_DIR, zhash + "-f");
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch (_) {
      /* 已存在 */
    }
    try {
      const zipExt = path.extname(zipPath).toLowerCase() === ".zip";
      const entries = zipExt ? listZipEntriesNode(zipPath) || [] : [];
      det.frames.forEach((f, i) => {
        const out = path.join(tmpDir, "frame_" + String(i).padStart(3, "0") + f.ext);
        if (zipExt) {
          const e = entries.find((x) => x.name === f.file);
          if (!e) return;
          const data = readZipEntryData(zipPath, e);
          if (data) fs.writeFileSync(out, data);
        } else {
          try {
            const buf = execFileSync(SEVEN_ZIP, ["e", "-so", zipPath, f.file], {
              maxBuffer: 64 * 1024 * 1024,
              timeout: 30000,
            });
            fs.writeFileSync(out, buf);
          } catch (_) {
            /* 单帧解包失败：ffmpeg 会因缺帧报错 */
          }
        }
      });
      const f0 = det.frames[0];
      _runFfmpeg(_gifArgs(path.join(tmpDir, "frame_%03d" + f0.ext), frameMs, gifFile, flip));
    } catch (e) {
      try {
        fs.rmSync(gifFile, { force: true });
      } catch (_) {
        /* 清理失败不影响错误返回 */
      }
      jsonRes(res, 500, { ok: false, error: "zip GIF 合成失败: " + (e.message || String(e)) });
      return;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {
        /* 临时帧目录残留不影响结果 */
      }
    }
  }
  _sendGif(res, gifFile);
}

/**
 * 含 ini 的包（3DMigoto mod）内单张图片 → 180° 翻转后输出。
 * 走 ffmpeg `vflip,hflip`，结果用**单帧 GIF** 承载：群晖静态 ffmpeg 4.1.9 缺 jpg/png muxer
 * （`Unable to find a suitable output format`），只有 gif muxer 可用，浏览器显示单帧 GIF 正常。
 * 结果按 路径@mtime|条目名 缓存到 cache-gifs/。
 */
function flipArchiveImage(archivePath, entryName, res) {
  let mtime = 0;
  try {
    mtime = fs.statSync(archivePath).mtimeMs;
  } catch (_) {
    res.writeHead(500);
    res.end("stat failed");
    return;
  }
  const hash = crypto
    .createHash("sha1")
    .update(archivePath + "|" + mtime + "|" + entryName + "|flip180")
    .digest("hex")
    .slice(0, 16);
  const out = path.join(CACHE_GIF_DIR, hash + ".gif");
  if (!fs.existsSync(out)) {
    try {
      fs.mkdirSync(CACHE_GIF_DIR, { recursive: true });
    } catch (_) {
      /* 已存在 */
    }
    const src = path.join(CACHE_GIF_DIR, hash + ".src");
    try {
      const data = readArchiveEntryData(archivePath, entryName);
      if (!data) throw new Error("entry not found");
      fs.writeFileSync(src, data);
      _runFfmpeg(["-y", "-i", src, "-vf", "vflip,hflip", "-frames:v", "1", out]);
    } catch (e) {
      try {
        fs.rmSync(out, { force: true });
      } catch (_) {
        /* 清理失败不影响错误返回 */
      }
      res.writeHead(500);
      res.end("flip failed");
      return;
    } finally {
      try {
        fs.rmSync(src, { force: true });
      } catch (_) {
        /* 临时源文件残留不影响结果 */
      }
    }
  }
  res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-cache" });
  fs.createReadStream(out).pipe(res);
}

module.exports = {
  CACHE_GIF_DIR,
  FFMPEG,
  FFMPEG_LIB,
  detectFramesFromDir,
  frameMsFromIniSpeed,
  gifFromDir,
  gifFromZip,
  flipArchiveImage,
};
