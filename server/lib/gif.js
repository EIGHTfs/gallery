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
const { SEVEN_ZIP, listArchiveImages, listZipEntriesNode, readZipEntryData } = require("./archive");

const TOOLS_DIR = path.join(__dirname, "..", "..", "tools");
const CACHE_GIF_DIR = path.join(__dirname, "..", "..", "cache-gifs");

// ffmpeg 选用：环境变量 > tools/（自带 lib）> 系统路径
function _pickFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return { bin: process.env.FFMPEG, lib: "" };
  const tool = path.join(TOOLS_DIR, "ffmpeg");
  const lib = path.join(TOOLS_DIR, "ffmpeg-lib");
  if (fs.existsSync(tool)) {
    try {
      execFileSync(tool, ["-version"], {
        timeout: 8000,
        stdio: "ignore",
        env: lib ? Object.assign({}, process.env, { LD_LIBRARY_PATH: lib }) : undefined,
      });
      return { bin: tool, lib };
    } catch (_) {
      /* 自带 ffmpeg 不可用，落到系统路径 */
    }
  }
  return { bin: fs.existsSync("/usr/bin/ffmpeg") ? "/usr/bin/ffmpeg" : "ffmpeg", lib: "" };
}

const _ff = _pickFfmpeg();
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

// 构造 ffmpeg 参数（帧序列 → 循环 GIF，宽度超过 480 等比缩小）
function _gifArgs(pattern, frameMs, gifFile) {
  return [
    "-y",
    "-framerate", String(1000 / frameMs),
    "-start_number", "0",
    "-i", pattern,
    "-vf", "scale=w='if(gt(iw,480),480,iw)':h=-1",
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
function gifFromZip(zipPath, durMs, res) {
  const images = listArchiveImages(zipPath);
  const det = detectFramesFromDir(images.map((i) => i.name));
  if (!det) {
    jsonRes(res, 400, { ok: false, error: "压缩包内非序列帧" });
    return;
  }
  const frameMs = Number.isFinite(durMs) && durMs > 0 ? durMs : Math.round(2000 / Math.max(1, det.frames.length));
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
    .update(zipPath + "|" + det.frames.map((f) => f.file).join(",") + "|" + zmtime + "|" + frameMs)
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
      _runFfmpeg(_gifArgs(path.join(tmpDir, "frame_%03d" + f0.ext), frameMs, gifFile));
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

module.exports = {
  CACHE_GIF_DIR,
  FFMPEG,
  FFMPEG_LIB,
  detectFramesFromDir,
  gifFromDir,
  gifFromZip,
};
