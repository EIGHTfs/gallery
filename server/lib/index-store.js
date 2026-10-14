// 按需索引存储（2026-10-14）
//
// 设计要点（与 docs/20261014-根目录设计重做-黑名单模式.MD 第十节一致）：
//   1. 一个分类一个索引文件：<项目根>/cache-index/<分类>/index.json
//   2. **只在目录被实际访问时**增量追加该目录条目 —— 不预先构建任何索引；
//      没有索引只意味着「初次访问那个目录慢一点」（那一次仅扫该目录一层）。
//   3. 目录 mtime 变新 ⇒ 该目录条目失效，下次访问只重建**那一段**并回写。
//   4. **永不整树扫描**：本模块只做单层 readdir + stat。
//   5. 前端零改动：本模块产出的图片对象形状与 server/lib/scan.js 完全一致
//      （name/path/url/size/modified），只是「来源」从整树扫描变成按目录缓存。
//
// 为什么这样设计：/volume10/Resource/(Pawchive)/Pawchive 实测 341,523 张图 + 21,383 压缩包，
// 一次整树扫描会打出 scan:stat 上 TB、读 7–70 MB/s 持续（曾两次拖慢 NAS）；按目录粒度后，
// 成本只与「被访问到的那个目录」的文件数相关。

const fs = require("fs");
const path = require("path");
// 与 scan.js 共用同一个体积格式化函数 —— 保证索引产出与整树扫描产出**逐字节一致**（前端显示不得变化）
const { formatSize } = require("./util");

// 与 scan.js 保持一致的图片后缀判断（这里只用于单层列举）
const IMG_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
// 索引根目录名（与 cache-gifs 同级；属派生数据，不入库、加入自动更新排除清单）
const CACHE_DIRNAME = "cache-index";

/** 项目根：本文件位于 <项目根>/server/lib/index-store.js */
function projectRoot() {
  return path.resolve(__dirname, "..", "..");
}

/** 索引根目录（不存在则在使用时按需创建） */
function indexRoot() {
  return path.join(projectRoot(), CACHE_DIRNAME);
}

/**
 * 键编码：可读化 + 冲突追加短哈希
 * - `/` 与文件系统不安全字符替换为 `__`，中文/空格保留（便于人工排查与备份）
 * - 超长（>120）时截断并追加 hash 后缀，保证同一父目录下不撞名
 */
function slugKey(name) {
  const raw = String(name || "").trim();
  const safe = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "__")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "_")
    .trim();
  const base = safe.length ? safe : "_";
  if (base.length <= 120) return base;
  return base.slice(0, 100) + "__" + shortHash(raw);
}

/** 稳定的短哈希（FNV-1a 32 位，零依赖；只要同名同串稳定即可，不用于安全场景） */
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 某分类的索引目录 */
function categoryDir(category) {
  return path.join(indexRoot(), slugKey(category || "uncategorized"));
}

/** 某分类的索引文件路径（保留旧版单文件路径，仅供迁移读取） */
function indexPathOf(category) {
  return path.join(categoryDir(category), "index.json");
}

/**
 * 分片键：按「配置根之下的**顶层子目录**」切分（root 自身归 _root）。
 * 为什么：单分类全量索引在大分类上会变成数百 MB 的单文件，每次访问都要解析+重写整份
 * （实测 cache-index 达 513 MB / 9 个文件）⇒ 必须把读写体积压到 MB 级。
 */
function shardKeyFor(root, dir) {
  const r = path.resolve(String(root));
  const d = path.resolve(String(dir));
  if (d === r) return "_root";
  if (!d.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return "_root";
  const rest = d.slice((r.endsWith(path.sep) ? r : r + path.sep).length);
  const first = rest.split(path.sep)[0];
  return slugKey(first || "_root");
}

/** 某分片的索引文件路径：cache-index/<分类>/<分片键>.json */
function shardPathFor(category, root, dir) {
  return path.join(categoryDir(category), shardKeyFor(root, dir) + ".json");
}

/**
 * ── JSONL 流式读写（按「文件可全量、读不全量」的格式）──
 * 文件：<分类>/index.jsonl —— 第 1 行 header，之后一行一条目录条目 {k,dir,dirMtime,items}
 * 读：逐行流式扫描，命中目标 key 立即返回（**不整份 JSON.parse、不整份入内存**，内存只留一行）
 * 写：逐行流式复制，替换/追加目标那一行 → 临时文件 → rename（内存同样只留一行）
 */
function jsonlPathFor(category) {
  return path.join(categoryDir(category), "index.jsonl");
}

/** 流式读取某一目录条目（命中即停；找不到返回 null） */
function readDirEntryJsonl(category, key) {
  const file = jsonlPathFor(category);
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (_) {
    return null;
  }
  try {
    const bufSize = 1 << 20;              // 1 MB 缓冲，只驻留当前行
    const buf = Buffer.alloc(bufSize);
    let rest = "";
    let lineNo = 0;
    while (true) {
      const n = fs.readSync(fd, buf, 0, bufSize, null);
      if (n <= 0) break;
      rest += buf.toString("utf8", 0, n);
      let idx;
      while ((idx = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, idx);
        rest = rest.slice(idx + 1);
        lineNo++;
        if (lineNo === 1 || !line) continue;          // header / 空行
        if (line.indexOf('"' + key + '"') < 0) continue; // 便宜的预筛，避免对每行 JSON.parse
        try {
          const obj = JSON.parse(line);
          if (obj && obj.k === key) return obj;
        } catch (_) {
          /* 坏行跳过：单行损坏不应影响其它条目 */
        }
      }
    }
    if (rest.trim()) {
      try {
        const obj = JSON.parse(rest);
        if (obj && obj.k === key) return obj;
      } catch (_) { /* 同上 */ }
    }
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

/** 流式更新/追加某目录条目（逐行复制 + 替换那一行；内存只留一行） */
function upsertDirEntryJsonl(category, key, entry) {
  const file = jsonlPathFor(category);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + ".tmp");
  const header = JSON.stringify({ version: 1, category: category || "uncategorized", updatedAt: new Date().toISOString() });
  const line = JSON.stringify(Object.assign({ k: key }, entry));
  const out = fs.openSync(tmp, "w");
  let replaced = false;
  try {
    let inFd = null;
    try {
      inFd = fs.openSync(file, "r");
    } catch (_) {
      inFd = null;
    }
    fs.writeSync(out, header + "\n");
    if (inFd !== null) {
      const bufSize = 1 << 20;
      const buf = Buffer.alloc(bufSize);
      let rest = "";
      let lineNo = 0;
      while (true) {
        const n = fs.readSync(inFd, buf, 0, bufSize, null);
        if (n <= 0) break;
        rest += buf.toString("utf8", 0, n);
        let idx;
        while ((idx = rest.indexOf("\n")) >= 0) {
          const l = rest.slice(0, idx);
          rest = rest.slice(idx + 1);
          lineNo++;
          if (lineNo === 1 || !l) continue;              // header / 空行
          if (l.indexOf('"' + key + '"') >= 0) {
            let isTarget = false;
            try { isTarget = JSON.parse(l).k === key; } catch (_) { isTarget = false; }
            if (isTarget) {
              if (!replaced) { fs.writeSync(out, line + "\n"); replaced = true; }
              continue;                                   // 丢弃旧行
            }
          }
          fs.writeSync(out, l + "\n");
        }
      }
      if (rest.trim()) fs.writeSync(out, rest + "\n");
    }
    if (!replaced) fs.writeSync(out, line + "\n");
  } finally {
    // 必须关掉输入与输出 fd：此前漏关 inFd ⇒ 每扫一个目录泄漏一个 fd，遍历大目录树会把
    // 进程 fd 耗尽并报 EMFILE（实测部署端 /zip/scan 全部失败、页面无图）
    try { if (typeof inFd !== "undefined" && inFd !== null) fs.closeSync(inFd); } catch (_) { /* ignore */ }
    try { fs.closeSync(out); } catch (_) { /* ignore */ }
  }
  fs.renameSync(tmp, file);
  return true;
}

/** 流式载入整份 JSONL 为 Map（内存只保留条目本身，不做一次性 JSON.parse；用于递归遍历） */
function loadAllJsonl(category) {
  const file = jsonlPathFor(category);
  const map = new Map();
  let fd;
  try { fd = fs.openSync(file, "r"); } catch (_) { return map; }
  try {
    const bufSize = 1 << 20;
    const buf = Buffer.alloc(bufSize);
    let rest = "";
    let lineNo = 0;
    const take = (line) => {
      lineNo++;
      if (lineNo === 1 || !line) return;
      try {
        const obj = JSON.parse(line);
        if (obj && obj.k) map.set(obj.k, obj);
      } catch (_) { /* 坏行跳过 */ }
    };
    while (true) {
      const n = fs.readSync(fd, buf, 0, bufSize, null);
      if (n <= 0) break;
      rest += buf.toString("utf8", 0, n);
      let idx;
      while ((idx = rest.indexOf("\n")) >= 0) {
        take(rest.slice(0, idx));
        rest = rest.slice(idx + 1);
      }
    }
    if (rest.trim()) take(rest);
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
  return map;
}

/**
 * 读分片（带旧版一次性迁移）：
 * 旧版是「一个分类一个 index.json」；若分片不存在而旧文件在，则从旧文件中**只取该分片前缀下的条目**
 * 写入分片，并删除旧文件（其余分片按需重建 —— 代价可控，避免一直背着一个数百 MB 的大文件）。
 */
function readShard(category, root, dir) {
  const shard = shardPathFor(category, root, dir);
  let store = readJsonSafe(shard, null);
  if (store && store.dirs) return { store, file: shard, legacy: false };

  const legacyFile = indexPathOf(category);
  const legacy = readJsonSafe(legacyFile, null);
  if (legacy && legacy.dirs) {
    const r = path.resolve(String(root));
    const prefix = r.endsWith(path.sep) ? r : r + path.sep;
    const dirs = {};
    for (const [k, v] of Object.entries(legacy.dirs)) {
      const p = v && v.dir ? path.resolve(v.dir) : "";
      if (p && (p === r || p.startsWith(prefix))) dirs[k] = v;
    }
    store = { version: 1, category: category || "uncategorized", dirs, migratedFrom: "index.json" };
    try {
      writeJsonAtomic(shard, store);
      fs.rmSync(legacyFile, { force: true });   // 迁移后删旧大文件（释放数百 MB）
    } catch (_) {
      /* 迁移失败不影响本次读取（下次再试） */
    }
    return { store, file: shard, legacy: true };
  }

  return { store: { version: 1, category: category || "uncategorized", dirs: {} }, file: shard, legacy: false };
}

/** 目录在索引里的键：用目录相对项目根的路径做可读化编码 */
function dirKey(dir) {
  return slugKey(path.resolve(String(dir)));
}

/** 读 JSON（容错）：文件缺失/损坏一律退回 fallback，绝不让索引问题影响浏览 */
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

/**
 * 原子写：先写同目录临时文件再 rename —— 避免断电/中断留下半截 JSON
 * （索引是可重建的派生数据，但半截文件会让读取端反复失败）
 */
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
  fs.renameSync(tmp, file);
}

/** 取目录自身 mtime 毫秒；失败返回 0（视为「未知」⇒ 下次访问会重建） */
function dirMtimeMs(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch (_) {
    return 0;
  }
}

/**
 * 单层扫描：只列举 dir 自身的条目（不递归、不进子目录）
 * 关键：返回的 `items` **保留 readdir 顺序**，且把「文件」与「子目录」按原顺序交错记录 ——
 * 既有实现（server/lib/scan.js::recursiveScanAll）是「readdir 顺序 + 就地递归」，
 * 子目录里的图会插在该目录后续文件之前；要保证前端显示零变化，必须能原样重放这个顺序。
 * items: [{ t:'f', img:{name,path,url,size,modified} } | { t:'d', name }]
 */
function scanDirShallow(dir) {
  const d = path.resolve(String(dir));
  const items = [];
  const images = [];
  let entries = [];
  try {
    entries = fs.readdirSync(d, { withFileTypes: true });
  } catch (_) {
    return { items, images, dirMtime: 0 };
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      items.push({ t: "d", name: entry.name }); // 子目录：只记名字，递归时再展开（顺序位保留）
      continue;
    }
    if (!entry.isFile() || !IMG_EXT_RE.test(entry.name)) continue;
    const full = path.join(d, entry.name);
    try {
      const st = fs.statSync(full);
      const img = {
        name: entry.name,
        path: full,
        url: `/api/media?file=${encodeURIComponent(full)}`,
        size: formatSize(st.size),
        modified: st.mtime.toISOString(),
      };
      items.push({ t: "f", img });
      images.push(img);
    } catch (_) {
      /* 扫描期文件被删/无权限：跳过该文件 */
    }
  }
  // 刻意不排序：排序会改变前端分组/卡片顺序（属显示变化）
  return { items, images, dirMtime: dirMtimeMs(d) };
}

/**
 * 取某目录的索引条目（**这就是「按需」的入口**）：
 *   - 命中（同一目录、mtime 未变）⇒ 直接返回缓存条目，零磁盘遍历
 *   - 未命中/已过期 ⇒ 只扫该目录一层，写回该分类索引文件，然后返回
 * 返回 { dir, dirMtime, images, hit:boolean }
 * opts.category 缺省时用 uncategorized；opts.persist=false 时只扫描不落盘（测试用）
 */
function getDirEntry(category, dir, opts) {
  const options = opts || {};
  const abs = path.resolve(String(dir));
  const key = dirKey(abs);
  const mtime = dirMtimeMs(abs);
  // 只取该目录那一条：JSONL 流式读，命中即停（不整份解析、内存只留一行）
  const cached = options.persist === false ? null : readDirEntryJsonl(category, key);
  if (cached && mtime && cached.dirMtime === mtime) {
    return { dir: abs, dirMtime: mtime, items: cached.items || [], images: cached.images || [], hit: true };
  }

  // 未命中/过期：只扫这一个目录（单层）
  const scanned = scanDirShallow(abs);
  const entry = { dir: abs, dirMtime: scanned.dirMtime, items: scanned.items, images: scanned.images };
  if (options.persist !== false) {
    try {
      upsertDirEntryJsonl(category, key, entry);   // 逐行替换/追加那一行（内存只留一行）
    } catch (_) {
      /* 落盘失败不影响本次浏览（下次访问重建即可） */
    }
  }
  return { dir: abs, dirMtime: entry.dirMtime, items: entry.items, images: entry.images, hit: false };
}

/**
 * 按需递归枚举（**显示零变化的关键**）：
 * 与 server/lib/scan.js::recursiveScanAll 同为「readdir 顺序 + 就地递归」，因此产出的图片数组
 * 与既有实现**逐项同序**；区别只在数据来源 —— 每个目录先查索引（mtime 未变则直接复用，不读盘），
 * 变化过的目录才做一次单层扫描并回写该段。
 * 返回 { images, dirsSeen, hits, scans }（hits/scans 用于日志与自检）
 */
function walkWithIndex(category, root, opts) {
  const options = opts || {};
  // 流式载入本分类条目（内存只保留条目本身）；不再整份解析 + 整份重写单文件
  const entries = options.persist === false ? new Map() : loadAllJsonl(category);
  const exclude = new Set((options.excludeDirs || []).map((s) => String(s)));
  const images = [];
  let dirsSeen = 0;
  let hits = 0;
  let scans = 0;

  function entryOf(dir) {
    const abs = path.resolve(dir);
    const key = dirKey(abs);
    const mtime = dirMtimeMs(abs);
    const cached = entries.get(key);
    if (cached && mtime && cached.dirMtime === mtime) {
      hits++;
      return cached;
    }
    const scanned = scanDirShallow(abs);
    const entry = { dir: abs, dirMtime: scanned.dirMtime, items: scanned.items, images: scanned.images };
    if (options.persist !== false) {
      try {
        upsertDirEntryJsonl(category, key, entry);   // 只写这一条（逐行替换/追加；内存只留一行）
      } catch (_) { /* 落盘失败不影响本次返回 */ }
      entries.set(key, entry);
    }
    scans++;
    return entry;
  }

  function walk(dir) {
    dirsSeen++;
    const entry = entryOf(dir);
    for (const it of entry.items || []) {
      if (it.t === "d") {
        if (exclude.has(it.name)) continue;          // 与既有实现一致：跳过 @eaDir 等排除项
        walk(path.join(entry.dir, it.name));         // 就地递归 ⇒ 顺序与 recursiveScanAll 相同
      } else if (it.t === "f" && it.img) {
        images.push(it.img);
      }
    }
  }

  walk(path.resolve(String(root)));

  return { images, dirsSeen, hits, scans };
}

/** 手动重建（保留但不自动跑）：按目录 / 按分类 / 全量；批量导入后一次性补全用 */
function rebuild(target) {
  const t = target || {};
  if (t.dir) return [getDirEntry(t.category, t.dir)];
  if (t.category) {
    const store = readJsonSafe(indexPathOf(t.category), null);
    const dirs = store && store.dirs ? Object.keys(store.dirs).map((k) => store.dirs[k].dir) : [];
    return dirs.map((d) => getDirEntry(t.category, d));
  }
  const out = [];
  let cats = [];
  try {
    cats = fs.readdirSync(indexRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) {
    cats = [];
  }
  for (const c of cats) out.push(...rebuild({ category: c }));
  return out;
}

module.exports = {
  CACHE_DIRNAME,
  indexRoot,
  slugKey,
  shortHash,
  categoryDir,
  indexPathOf,
  dirKey,
  readJsonSafe,
  writeJsonAtomic,
  dirMtimeMs,
  scanDirShallow,
  getDirEntry,
  walkWithIndex,
  rebuild,
  IMG_EXT_RE,
};
