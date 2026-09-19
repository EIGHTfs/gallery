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

const TOOLS_DIR = path.join(__dirname, "..", "..", "tools");
const SEVEN_ZIP = fs.existsSync(path.join(TOOLS_DIR, "7zz"))
  ? path.join(TOOLS_DIR, "7zz")
  : "/usr/bin/7z";

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

// 压缩包内图片条目列表：zip 零依赖；7z/rar 用 7z l
function listArchiveImages(archivePath) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === ".zip") {
    try {
      return listZipEntriesNode(archivePath)
        .filter((e) => !e.isDir && IMG_EXT_RE.test(e.name) && !/^\.\.\//.test(e.name))
        .map((e) => ({ name: e.name, size: e.uncompSize }));
    } catch (_) {
      return [];
    }
  }
  try {
    // 7z 输出可能是 GBK 字节（SA6400 群晖 Node 无 TextDecoder("gbk")）→ buffer 按行解码
    const outBuf = execFileSync(SEVEN_ZIP, ["l", archivePath], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
    });
    const lines = [];
    let start = 0;
    for (let i = 0; i < outBuf.length; i++) {
      if (outBuf[i] === 0x0a) {
        lines.push(outBuf.slice(start, i));
        start = i + 1;
      }
    }
    if (start < outBuf.length) lines.push(outBuf.slice(start));
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
    const imgs = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*[\d\-:]+\s+[\d\-:]+[\d\-:]*\s+([\.DA]+)\s+(\d+)\s+\d+\s+(.+)$/);
      if (m && !m[1].includes("D") && !m[3].includes("?") && IMG_EXT_RE.test(m[3].trim())) {
        imgs.push({ name: m[3].trim(), size: parseInt(m[2], 10) });
      }
    }
    return imgs;
  } catch (_) {
    return [];
  }
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
};
