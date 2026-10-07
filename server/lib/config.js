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

// 浏览根：环境变量 / config.fsRoot / 已配置目录的公共前缀 / 系统根。禁止写死 /vol02。
function resolveFsRoot(cfg) {
  const c = cfg || loadConfig();
  const envRoot = process.env.GALLERY_FS_ROOT;
  if (envRoot && fs.existsSync(envRoot)) return path.resolve(envRoot);
  if (c.fsRoot && fs.existsSync(c.fsRoot)) return path.resolve(c.fsRoot);
  const dirs = (c.directories || [])
    .map((d) => d && d.path)
    .filter((p) => p && fs.existsSync(p));
  if (dirs.length) {
    // 取所有已配置目录的公共前缀作为浏览根
    let prefix = path.resolve(dirs[0]);
    for (const d of dirs.slice(1)) {
      const abs = path.resolve(d);
      while (prefix !== path.dirname(prefix) && !abs.startsWith(prefix + path.sep) && abs !== prefix) {
        prefix = path.dirname(prefix);
      }
    }
    return prefix;
  }
  return path.parse(process.cwd()).root;
}

// 浏览请求指定的根（query.root），必须落在 resolveFsRoot 之内，防越权浏览
// cfg 可选：仅供测试注入，生产调用不传（内部自行 loadConfig）
function queryRoot(query, cfg) {
  const base = resolveFsRoot(cfg);
  if (!query || !query.root) return base;
  const want = path.resolve(String(query.root));
  if (want === base || want.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return want;
  return base;
}

// 目录浏览天花板（仅设置页「添加目录」的目录浏览器用）：
//   显式配置 GALLERY_FS_ROOT / config.fsRoot → 以它为界（尊重部署方限制）
//   未显式配置 → 文件系统根（可一路向上，选择任意本机目录）
// 为什么不能直接用 resolveFsRoot 当上界：它取的是「已配置目录的公共前缀」，
// 只配了一个目录时它恰好等于该目录本身，于是「上一级」永远越界被钳回原处 ——
// 2026-10-08 修：目录浏览器（设置→添加图片目录）无法返回上一级。
function resolveBrowseLimit(cfg) {
  const c = cfg || loadConfig();
  const envRoot = process.env.GALLERY_FS_ROOT;
  if (envRoot && fs.existsSync(envRoot)) return path.resolve(envRoot);
  if (c.fsRoot && fs.existsSync(c.fsRoot)) return path.resolve(c.fsRoot);
  return path.parse(process.cwd()).root;
}

// 归一化并校验浏览路径：返回 { root, limit, clamped }
// clamped=true 表示请求越界、已被钳回 limit（前端据此提示「已到最上层」而不是静默无反应）
// cfg 可选：仅供测试注入，生产调用不传
function browseRoot(query, cfg) {
  const limit = resolveBrowseLimit(cfg);
  const want = query && query.root ? path.resolve(String(query.root)) : limit;
  const inside = want === limit || want.startsWith(limit.endsWith(path.sep) ? limit : limit + path.sep);
  return inside ? { root: want, limit, clamped: false } : { root: limit, limit, clamped: true };
}

// 浏览器不可见密码哈希
function publicConfig(cfg) {
  const { passwordHash, passwordSalt, ...rest } = cfg;
  return { ...rest, fsRoot: resolveFsRoot(cfg) };
}

module.exports = {
  CONFIG,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  getExcludeDirs,
  resolveFsRoot,
  queryRoot,
  resolveBrowseLimit,
  browseRoot,
  publicConfig,
};
