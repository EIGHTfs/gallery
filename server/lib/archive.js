// ============================================================
// 拾光集 - 压缩包内图片读取（zip 零依赖解析；7z/rar 走外部 7z）
// 搬运自原 app.js，逻辑不变，仅抽出为独立模块。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const { IMG_EXT_RE } = require("./scan");
const { getTool } = require("../tool/tool-detect.js");

// 7z/7zz 选用：环境变量 > 项目工具目录（tool/ 或 tools/）> 系统路径；
// 7zz 探测不到（不存在/不可执行）时回退 7z（统一探测模块，含可用性实测）。
// ⚠️ 必须传 versionArgs:["i"]：7-Zip 系的可用性命令是 `i`（info），`-version` 实测 exit 7；
//    不传会被判「不可用」→ 返回裸名 "7zz" → rar/7z 的列条目 + ini 检测/翻转全部静默失效
//    （旧实现「rar/7z 内 ini 从未被检测到」同源）。
const SEVEN_ZIP = getTool("7zz", { fallbacks: ["7z"], versionArgs: ["i"] });

// ============================================================
// GBK 解码（压缩包中文条目名）
// 问题：SA6400 群晖 Node 套件不支持 TextDecoder("gbk")（The "gbk" encoding is not supported）
//   → 回退 rawName.toString("utf8") 会产生乱码（如 ���ҡ��ĵ���）
// 方案：TextDecoder("gbk") 可用则直接用；不可用则用 python3 批量 GBK 解码兜底（零依赖）
// ============================================================
let _GBK_DECODER_OK = null;

function gbkDecoderAvailable() {
  if (_GBK_DECODER_OK === null) {
    try {
      new TextDecoder("gbk");
      _GBK_DECODER_OK = true;
    } catch (_) {
      _GBK_DECODER_OK = false;
    }
  }
  return _GBK_DECODER_OK;
}

// 批量 GBK 解码：pending = [{ idx, raw: Buffer }] → Map(idx → string)
function decodeGbkBatch(pending) {
  const out = new Map();
  const todo = [];
  for (const it of pending) {
    if (gbkDecoderAvailable()) {
      out.set(it.idx, new TextDecoder("gbk").decode(it.raw));
    } else {
      todo.push({ i: it.idx, h: it.raw.toString("hex") });
    }
  }
  if (!todo.length) return out;
  try {
    const script =
      "import sys,json\n" +
      "d=json.load(sys.stdin)\n" +
      "o={}\n" +
      "for it in d:\n" +
      "    b=bytes.fromhex(it['h'])\n" +
      "    try: s=b.decode('gbk')\n" +
      "    except Exception: s=b.decode('utf-8', errors='replace')\n" +
      "    o[str(it['i'])]=s\n" +
      "print(json.dumps(o, ensure_ascii=False))";
    const res = execFileSync("python3", ["-c", script], {
      input: JSON.stringify(todo),
      encoding: "utf8",
      timeout: 15000,
    });
    const obj = JSON.parse(res.trim());
    for (const [k, v] of Object.entries(obj)) out.set(parseInt(k, 10), v);
  } catch (_) {
    for (const it of todo) out.set(it.idx, it.raw.toString("utf8"));
  }
  return out;
}

// 单块 Buffer GBK 解码（7z/rar 输出行）
function decodeGbkBuffer(buf) {
  if (gbkDecoderAvailable()) return new TextDecoder("gbk").decode(buf);
  try {
    const script =
      "import sys\n" +
      "b=bytes.fromhex(sys.argv[1])\n" +
      "try: print(b.decode('gbk'))\n" +
      "except Exception: print(b.decode('utf-8', errors='replace'))";
    return execFileSync("python3", ["-c", script, buf.toString("hex")], {
      encoding: "utf8",
      timeout: 15000,
    }).replace(/\n$/, "");
  } catch (_) {
    return buf.toString("utf8");
  }
}

// ============================================================
// zip 中央目录解析（零依赖，只读需要的段）
// ============================================================
function listZipEntriesNode(zipPath) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65536);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];
    const eocdAbs = size - tailLen + eocd;
    const count = tail.readUInt16LE(eocd + 10);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (count === 0 || cdOff < 0 || cdOff >= eocdAbs) return [];
    const cdLen = eocdAbs - cdOff;
    const cd = Buffer.alloc(cdLen);
    fs.readSync(fd, cd, 0, cdLen, cdOff);
    const entries = [];
    const pending = []; // UTF-8 严格解码失败的条目，稍后批量 GBK 解码
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const extAttr = cd.readUInt32LE(p + 38);
      const rawName = cd.slice(p + 46, p + 46 + nameLen);
      let name = null;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
      } catch (_) {
        pending.push({ idx: n, raw: rawName });
      }
      const isDir = ((extAttr >>> 16) & 0x4000) !== 0 || /\/$/.test(name || "");
      entries.push({ name: name || "", method, compSize, uncompSize, localOff, isDir });
      p += 46 + nameLen + extraLen + commLen;
    }
    if (pending.length) {
      const decoded = decodeGbkBatch(pending);
      for (const it of pending) {
        const d = decoded.get(it.idx);
        if (d) {
          entries[it.idx].name = d;
          entries[it.idx].isDir = entries[it.idx].isDir || /\/$/.test(d);
        }
      }
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// zip 条目数据按需读取（只读 local header + 压缩数据段）
function readZipEntryData(zipPath, entry) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.localOff);
    if (head.readUInt32LE(0) !== 0x04034b50) return null;
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.localOff + 30 + nameLen + extraLen;
    const comp = Buffer.alloc(entry.compSize);
    fs.readSync(fd, comp, 0, entry.compSize, dataStart);
    if (entry.method === 0) return comp;
    if (entry.method === 8) return zlib.inflateRawSync(comp);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// ─── 压缩包条目一次性列举（zip 零依赖；7z/rar 用 7z l）───
// 一次列举同时得到「图片条目」与「ini 条目」：scan 需要对同一个包同时知道两者，
// 若各查一次会在 rar/7z 上 spawn 两次 7zz（CIFS 上代价明显）。按 路径@mtime 缓存。
const _metaCache = new Map(); // key = 路径@mtimeMs → { images, iniNames }

function getArchiveMeta(archivePath) {
  let mtime = 0;
  try {
    mtime = fs.statSync(archivePath).mtimeMs;
  } catch (_) {
    return { images: [], iniNames: [] };
  }
  const key = archivePath + "@" + mtime;
  const cached = _metaCache.get(key);
  if (cached) return cached;

  let meta = { images: [], iniNames: [] };
  if (path.extname(archivePath).toLowerCase() === ".zip") {
    try {
      const entries = listZipEntriesNode(archivePath).filter((e) => !e.isDir && !/^\.\.\//.test(e.name));
      meta = {
        images: entries.filter((e) => IMG_EXT_RE.test(e.name)).map((e) => ({ name: e.name, size: e.uncompSize })),
        iniNames: entries.filter((e) => /\.ini$/i.test(e.name)).map((e) => e.name),
      };
    } catch (_) {
      meta = { images: [], iniNames: [] };
    }
  } else {
    try {
      // 7z 输出可能是 GBK 字节（SA6400 群晖 Node 无 TextDecoder("gbk")）→ 统一走 bufferToText
      const outBuf = execFileSync(SEVEN_ZIP, ["l", archivePath], {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
      });
      const text = bufferToText(outBuf);
      const images = [];
      const iniNames = [];
      for (const line of text.split("\n")) {
        // 列序：Date Time Attr Size [Compressed] Name
        // ⚠️ Compressed 列可能为**空**（实测 p7zip 对同包后续条目输出空该列），
        //    旧正则硬要求两个数字 → 空列的行被整条丢弃（图片漏、ini 漏 → 该翻转的不翻转）。
        //    故 Compressed 列为可选；代价是「名字以数字+空格开头且 Compressed 为空」的极端命名
        //    会被误读一次（旧实现是直接丢整条，此为严格改进）。
        const m = line.match(/^\s*[\d\-:]+\s+[\d\-:]+[\d\-:]*\s+([\.DA]+)\s+(\d+)\s+(?:\d+\s+)?(.+)$/);
        if (!m || m[1].includes("D") || m[3].includes("?")) continue;
        const name = m[3].trim();
        if (IMG_EXT_RE.test(name)) images.push({ name, size: parseInt(m[2], 10) });
        else if (/\.ini$/i.test(name)) iniNames.push(name);
      }
      meta = { images, iniNames };
    } catch (_) {
      meta = { images: [], iniNames: [] };
    }
  }
  if (_metaCache.size > 500) _metaCache.clear(); // 粗放上限：防长跑累积
  _metaCache.set(key, meta);
  return meta;
}

// 压缩包内图片条目列表（保持原有调用方不变）
function listArchiveImages(archivePath) {
  return getArchiveMeta(archivePath).images;
}

// ─── 3DMigoto mod 标记：包内是否含 .ini ───
// 语义（共 4 条规则）：
//   ① 包名带间隔（@40ms/2s，Pixiv 图包）→ 按该间隔合成 GIF，不翻转；
//   ② 含 ini（= 3DMigoto mod）但无序列 → 不合成，只翻转 180°；
//   ③ 两者都无 → 不合成、不翻转（原样显示）；
//   ④ 含 ini 且有序列 → 翻转 180° 并按 ini 的 $speed 换算帧间隔合成。
// 兼容性坑：旧实现只用 listZipEntriesNode（zip 专用）→ rar/7z 内的 ini 从未生效。
// desktop.ini 是 Windows 目录元数据，不算 mod 标记。
function listIniEntries(archivePath) {
  return getArchiveMeta(archivePath).iniNames.filter((n) => !/(^|\/)desktop\.ini$/i.test(n));
}

function hasIniEntry(archivePath) {
  return listIniEntries(archivePath).length > 0;
}

/** 7z 列表输出按行解码（UTF-8 失败回退 GBK；群晖 Node 无 TextDecoder("gbk")） */
function bufferToText(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.slice(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push(buf.slice(start));
  let text = "";
  for (const lb of lines) {
    let line;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(lb);
    } catch (_) {
      line = decodeGbkBuffer(lb);
    }
    text += line + "\n";
  }
  return text;
}

/** 读取归档内某条目的字节（zip 走本地解析；rar/7z 走 7zz -so） */
function readArchiveEntryData(archivePath, entryName) {
  if (path.extname(archivePath).toLowerCase() === ".zip") {
    const e = (listZipEntriesNode(archivePath) || []).find((x) => x.name === entryName && !x.isDir);
    return e ? readZipEntryData(archivePath, e) : null;
  }
  return execFileSync(SEVEN_ZIP, ["e", "-so", archivePath, entryName], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  });
}

function readArchiveEntryText(archivePath, entryName) {
  const buf = readArchiveEntryData(archivePath, entryName);
  return buf ? buf.toString("utf8") : "";
}

/**
 * 解析 ini 里的动画速度 $speed。
 * 3dmigoto 动画 mod 的标准写法（《动画mod制作指南》第七步）：
 *   [Constants]  global persist $speed = 0.5
 *   [Present]    $frame = $frame + $speed     ← 每帧按 $speed 递进
 * 兼容 `global persist $speed = x` / `global $speed = x` / `$speed = x` 三种写法。
 */
function parseIniSpeed(text) {
  const m = String(text || "").match(/^[ \t]*(?:global[ \t]+(?:persist[ \t]+)?)?\$speed[ \t]*=[ \t]*([0-9]*\.?[0-9]+)/mi);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 包内 ini 的 $speed（找不到返回 null）；只看前几个 ini，够用且省 IO */
function readIniSpeed(archivePath) {
  for (const name of listIniEntries(archivePath).slice(0, 6)) {
    try {
      const v = parseIniSpeed(readArchiveEntryText(archivePath, name));
      if (v) return v;
    } catch (_) {
      /* 单个 ini 读取失败：继续看下一个 */
    }
  }
  return null;
}

// 按扩展名给出图片 Content-Type
function imageContentType(name) {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.gif$/i.test(name)) return "image/gif";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "image/jpeg";
}

// 流式输出压缩包内图片（适配原始 http res 对象）
function streamArchiveImage(res, archivePath, entryName) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === ".zip") {
    const e = (listZipEntriesNode(archivePath) || []).find((x) => x.name === entryName && !x.isDir);
    if (!e) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const data = readZipEntryData(archivePath, e);
    if (!data) {
      res.writeHead(500);
      res.end("read failed");
      return;
    }
    res.writeHead(200, { "Content-Type": imageContentType(e.name), "Cache-Control": "no-cache" });
    res.end(data);
    return;
  }
  try {
    const buf = execFileSync(SEVEN_ZIP, ["e", "-so", archivePath, entryName], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
    });
    res.writeHead(200, { "Content-Type": imageContentType(entryName), "Cache-Control": "no-cache" });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end("extract failed");
  }
}

module.exports = {
  SEVEN_ZIP,
  gbkDecoderAvailable,
  decodeGbkBatch,
  decodeGbkBuffer,
  listZipEntriesNode,
  readZipEntryData,
  listArchiveImages,
  streamArchiveImage,
  imageContentType,
  // 3DMigoto mod 判定与 ini 解析（2026-10-08）
  bufferToText,
  getArchiveMeta,
  listIniEntries,
  hasIniEntry,
  readArchiveEntryData,
  readArchiveEntryText,
  parseIniSpeed,
  readIniSpeed,
};
