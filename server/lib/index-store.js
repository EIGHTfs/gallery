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

/** 某分类的索引文件路径（一个分类一个文件） */
function indexPathOf(category) {
  return path.join(categoryDir(category), "index.json");
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
  const file = indexPathOf(category);
  const store = readJsonSafe(file, null) || { version: 1, category: category || "uncategorized", dirs: {} };
  if (!store.dirs || typeof store.dirs !== "object") store.dirs = {};

  const mtime = dirMtimeMs(abs);
  const cached = store.dirs[key];
  if (cached && mtime && cached.dirMtime === mtime) {
    // 命中：目录未变化 ⇒ 不读盘
    return { dir: abs, dirMtime: mtime, items: cached.items || [], images: cached.images || [], hit: true };
  }

  // 未命中/过期：只扫这一个目录（单层）
  const scanned = scanDirShallow(abs);
  const entry = { dir: abs, dirMtime: scanned.dirMtime, items: scanned.items, images: scanned.images };
  if (options.persist !== false) {
    store.dirs[key] = entry;
    store.updatedAt = new Date().toISOString();
    try {
      writeJsonAtomic(file, store);
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
  const file = indexPathOf(category);
  const store = readJsonSafe(file, null) || { version: 1, category: category || "uncategorized", dirs: {} };
  if (!store.dirs || typeof store.dirs !== "object") store.dirs = {};
  const exclude = new Set((options.excludeDirs || []).map((s) => String(s)));
  const images = [];
  let dirsSeen = 0;
  let hits = 0;
  let scans = 0;
  let dirty = false;

  function entryOf(dir) {
    const abs = path.resolve(dir);
    const mtime = dirMtimeMs(abs);
    const cached = store.dirs[dirKey(abs)];
    if (cached && mtime && cached.dirMtime === mtime) {
      hits++;
      return cached;
    }
    const scanned = scanDirShallow(abs);
    const entry = { dir: abs, dirMtime: scanned.dirMtime, items: scanned.items, images: scanned.images };
    store.dirs[dirKey(abs)] = entry;
    dirty = true;
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

  if (dirty && options.persist !== false) {
    store.updatedAt = new Date().toISOString();
    try {
      writeJsonAtomic(file, store);
    } catch (_) {
      /* 落盘失败不影响本次返回（下次访问重建该段即可） */
    }
  }
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
