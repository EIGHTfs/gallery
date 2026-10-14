// ============================================================
// 拾光集 - 配置持久化
// 配置分两层：
//   ① 框架层（framework/config-loader）：passwordHash/passwordSalt/autoUpdate 等
//      schema 驱动字段，由 createConfig 管理，并负责密码校验与会话时长。
//   ② 业务层（本模块）：categories / directories / images / excludeDirs / fsRoot 等
//      画廊自有字段，沿用原本的 loadConfig/saveConfig 语义。
// 两层读写同一个 config.json，互不覆盖：业务层保存时先读到完整原文再回写。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const CONFIG = path.join(__dirname, "..", "config.json");

const DEFAULT_CONFIG = {
  title: "Gallery",
  categories: [],
  directories: [],
};

// 业务配置读取：文件缺失或结构不完整时回落到默认值（首次启动路径）
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    if (c && c.categories && c.directories) return c;
  } catch (e) {
    /* 尚无 config.json，用默认值 */
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

// 保存业务配置。
// ⚠️ config.json 是「业务层 + 框架层」共用文件：密码哈希等框架字段也在里面。
// 直接整体覆写会把密码冲掉（历史隐患：保存一次画廊配置 → 登录密码失效）。
// 故先读回原文、只覆盖业务字段，保留框架字段。
const BUSINESS_KEYS = ["title", "favicon", "categories", "directories", "excludeDirs", "fsRoot"];

function saveConfig(config) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG, "utf8")) || {};
  } catch (e) {
    /* 首次创建：原文为空对象 */
  }
  for (const k of BUSINESS_KEYS) {
    if (config[k] !== undefined) raw[k] = config[k];
  }
  fs.writeFileSync(CONFIG, JSON.stringify(raw, null, 2), "utf8");
}

// 排除目录（群晖 @eaDir 等系统目录）：config.json 的 excludeDirs，默认 @eaDir
function getExcludeDirs() {
  const c = loadConfig();
  const arr = Array.isArray(c.excludeDirs) ? c.excludeDirs : ["@eaDir"];
  return new Set(arr.map((n) => String(n).trim()).filter(Boolean));
}

// ─── 多根目录支持（2026-10-14）──────────────────────────────
// GALLERY_FS_ROOTS 支持多根，分隔符 : 或 ,（Linux 路径不含冒号，故冒号安全；Windows 盘符场景请只用逗号）
function parseRootList(value) {
  if (!value) return [];
  return String(value)
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

// 允许浏览的根列表（按优先级归一化为数组）：
//   GALLERY_FS_ROOTS（多值） → GALLERY_FS_ROOT（单值） → config.fsRoots[] → config.fsRoot →
//   已配置目录的公共前缀 → 文件系统根
// 只保留真实存在的目录；全部不可用时退化为文件系统根（与旧行为一致）。
function resolveFsRoots(cfg) {
  const c = cfg || loadConfig();
  const envRoots = parseRootList(process.env.GALLERY_FS_ROOTS).filter((p) => fs.existsSync(p));
  if (envRoots.length) return envRoots;
  const envRoot = process.env.GALLERY_FS_ROOT;
  if (envRoot && fs.existsSync(envRoot)) return [path.resolve(envRoot)];
  const cfgRoots = (Array.isArray(c.fsRoots) ? c.fsRoots : []).map((p) => path.resolve(String(p))).filter((p) => fs.existsSync(p));
  if (cfgRoots.length) return cfgRoots;
  if (c.fsRoot && fs.existsSync(c.fsRoot)) return [path.resolve(c.fsRoot)];
  const dirs = (c.directories || [])
    .map((d) => d && d.path)
    .filter((p) => p && fs.existsSync(p));
  if (dirs.length) {
    // 2026-10-14：黑名单模式下默认根 = **已配置目录各自**（每个都是合法根），不再取公共前缀 ——
    // 跨卷（/volume6 + /volume10）时公共前缀会退化为 /，等于把整个文件系统当默认根（既拦不住也说不清）。
    return dirs.map((p) => path.resolve(p));
  }
  return [path.parse(process.cwd()).root];
}

// 向后兼容：单根场景仍返回一个路径（取第一个根）
function resolveFsRoot(cfg) {
  return resolveFsRoots(cfg)[0];
}

// 判断某路径是否落在允许的根集合之内（多根校验用它，替代旧的单 limit 判断）
function isWithinAnyRoot(target, roots) {
  if (!target || !roots || !roots.length) return false;
  const abs = path.resolve(String(target));
  for (const r of roots) {
    const root = path.resolve(r);
    if (abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true;
  }
  return false;
}

// 浏览请求指定的根（query.root），必须落在 resolveFsRoot 之内，防越权浏览
// cfg 可选：仅供测试注入，生产调用不传（内部自行 loadConfig）
// ─── 黑名单排除（2026-10-14 新设计：自由浏览 + 黑名单）────────────────
// 语义：默认情况下任意绝对路径都可浏览；只有命中黑名单（系统关键目录）的路径才被拒。
// 旧的白名单语义（GALLERY_FS_ROOT(S) / config.fsRoot(s)）保留为「显式配置则退回白名单模式」的兼容分支。
const DEFAULT_BLACKLIST_DIRS = [
  "/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/bin", "/sbin", "/lib", "/lib64",
  "/usr", "/var", "/tmp",
  // 群晖 NAS 元数据目录（系统/套件数据，不属于用户资源）
  "/volume1/@appstore", "/volume1/@appdata", "/volume1/@database", "/volume1/@tmp", "/volume1/docker",
];

/** 解析「目录数组」字符串（分隔符 : 或 ,）为绝对路径数组 */
function parseDirList(value) {
  if (!value) return [];
  return String(value)
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

/** 实际生效的黑名单：.env GALLERY_BLACKLIST_DIRS → config.blacklistDirs → 内置默认集 */
function resolveBlacklistDirs(cfg) {
  const c = cfg || loadConfig();
  const envList = parseDirList(process.env.GALLERY_BLACKLIST_DIRS);
  if (envList.length) return envList;
  const cfgList = Array.isArray(c.blacklistDirs) ? parseDirList(c.blacklistDirs.join(":")) : [];
  if (cfgList.length) return cfgList;
  return DEFAULT_BLACKLIST_DIRS.map((p) => path.resolve(p));
}

/** realpath 解析（不存在时退回 resolve）——比对前双方都走它，防符号链接绕过 */
function safeReal(p) {
  const abs = path.resolve(String(p));
  try {
    return fs.realpathSync(abs);
  } catch (_) {
    return abs;
  }
}

/** 是否命中黑名单（含其子路径）：软链指向黑名单目录同样被拦 */
function isBlockedPath(target, cfg) {
  const abs = safeReal(target);
  for (const item of resolveBlacklistDirs(cfg)) {
    const blocked = safeReal(item);
    if (abs === blocked || abs.startsWith(blocked.endsWith(path.sep) ? blocked : blocked + path.sep)) return true;
  }
  return false;
}

/** 是否显式配置了「白名单根」（env 或 config）——决定采用哪种语义 */
function hasExplicitWhitelist(cfg) {
  const c = cfg || loadConfig();
  if (parseRootList(process.env.GALLERY_FS_ROOTS).length) return true;
  if (process.env.GALLERY_FS_ROOT) return true;
  if (Array.isArray(c.fsRoots) && c.fsRoots.length) return true;
  return !!c.fsRoot;
}

/** 路径是否允许浏览（唯一的放行判断入口）：
 *  显式配置白名单根 → 必须落在某一允许根之内；否则 → 只要不在黑名单内即可 */
function isPathAllowed(target, cfg) {
  if (hasExplicitWhitelist(cfg)) return isWithinAnyRoot(target, resolveFsRoots(cfg));
  return !isBlockedPath(target, cfg);
}

// 浏览请求指定的根（query.root）：
//   默认（黑名单模式）→ 任意路径放行，命中黑名单则退回默认根；
//   显式白名单模式 → 维持旧语义（必须落在允许根之内）。
function queryRoot(query, cfg) {
  const base = resolveFsRoot(cfg);
  if (!query || !query.root) return base;
  const want = path.resolve(String(query.root));
  return isPathAllowed(want, cfg) ? want : base;
}

// 目录浏览天花板（仅设置页「添加目录」的目录浏览器用）：
//   默认 → 文件系统根（可一路向上挑任意目录，黑名单在放行判断里拦）
//   显式配置根 → 以它为界
// 为什么不能直接用 resolveFsRoot 当上界：它取的是「已配置目录的公共前缀」，
// 只配一个目录时恰好等于该目录本身，于是「上一级」永远越界被钳回 —— 2026-10-08 修过这个问题。
function resolveBrowseLimit(cfg) {
  const c = cfg || loadConfig();
  if (hasExplicitWhitelist(c)) return resolveFsRoot(c);
  return path.parse(process.cwd()).root;
}

// 归一化并校验浏览路径：返回 { root, limit, clamped }
// clamped=true 表示请求被拒、已退回 limit（前端据此提示「已到最上层」，而不是静默无反应）
// cfg 可选：仅供测试注入，生产调用不传
function browseRoot(query, cfg) {
  const limit = resolveBrowseLimit(cfg);
  const want = query && query.root ? path.resolve(String(query.root)) : limit;
  return isPathAllowed(want, cfg) ? { root: want, limit, clamped: false } : { root: limit, limit, clamped: true };
}

// ─── .env 支持（零依赖，只读一次）────────────────────────────
// 每行 KEY=VALUE，# 开头为注释；不覆盖已存在的真实环境变量（真实 env 优先级最高）。
// 为什么由服务端自己读：start.sh 刻意不 source 外部文件（换环境会找不到 node），故进程启动时读 <项目根>/.env。
function loadDotEnvOnce() {
  if (loadDotEnvOnce.__done) return;
  loadDotEnvOnce.__done = true;
  try {
    const p = path.join(path.resolve(__dirname, "..", ".."), ".env");
    if (!fs.existsSync(p)) return;
    for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (_) {
    /* .env 缺失或不可读：忽略，走 config.json / 默认值 */
  }
}

// 每行图片数量：.env / 环境变量 GALLERY_IMAGES_PER_ROW → config.imagesPerRow → 默认 20。
// 前端不得写死，一律经 /api/gallery 下发（见 publicConfig）。
const DEFAULT_IMAGES_PER_ROW = 20;
function resolveImagesPerRow(cfg) {
  loadDotEnvOnce();
  const c = cfg || loadConfig();
  const env = parseInt(process.env.GALLERY_IMAGES_PER_ROW, 10);
  if (Number.isFinite(env) && env > 0) return env;
  const v = parseInt(c.imagesPerRow, 10);
  if (Number.isFinite(v) && v > 0) return v;
  return DEFAULT_IMAGES_PER_ROW;
}

// 浏览器不可见密码哈希
function publicConfig(cfg) {
  const { passwordHash, passwordSalt, ...rest } = cfg;
  return {
    ...rest,
    fsRoot: resolveFsRoot(cfg),     // 向后兼容：单根（取第一个根）
    fsRoots: resolveFsRoots(cfg),   // 多根：全部允许的根（前端可用于目录树/限制提示）
    imagesPerRow: resolveImagesPerRow(cfg),
  };
}

module.exports = {
  CONFIG,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  getExcludeDirs,
  resolveFsRoot,
  resolveFsRoots,
  isWithinAnyRoot,
  // 黑名单模式（2026-10-14 新设计）
  DEFAULT_BLACKLIST_DIRS,
  parseDirList,
  resolveBlacklistDirs,
  isBlockedPath,
  hasExplicitWhitelist,
  isPathAllowed,
  resolveImagesPerRow,
  queryRoot,
  resolveBrowseLimit,
  browseRoot,
  publicConfig,
};
