// ============================================================
// 工具自探测（框架层 · 通用）——统一「项目需要的工具能否自探测」的查找逻辑
//
// 背景：gallery/gbmd/iwara 各自实现了工具查找（gif.js 的 ffmpeg、archive.js 的 7z、
//   data-backup.js 的 zip/unzip），逻辑重复且能力不一：
//   · gif.js  环境变量 → tools/（含可用性实测 + lib）→ 系统路径   （完善）
//   · archive.js 只 exists 检查、无可用性校验、无环境变量、无 PATH 兜底（最弱）
//   · data-backup.js 只查 tool/bin，无 tools/（旧目录）扫描
//   本模块统一为：环境变量 → 项目工具目录（tool/ 与 tools/ 两套都扫）→ 系统路径，
//   每级都做「存在 + 可执行 + 版本探测」实测，失败自动降级到下一级。
//
// 项目工具目录约定（project-self-tools）：
//   · 新目录 <项目>/tool/（单数，工具直接放或 tool/bin/ 下）
//   · 旧目录 <项目>/tools/（复数，如 gallery 的 tools/ffmpeg + tools/ffmpeg-lib + tools/7zz）
//   本模块对两者都扫描，新项目用 tool/ 即可。
//
// 用法：
//   const { detectTool, getTool, probeTools } = require("../tool/tool-detect.js");
//   const t = detectTool("ffmpeg");            // → { bin, lib, source } | null
//   const bin = getTool("7zz", { fallbacks: ["7z"] });   // → bin 路径；找不到返回 "7zz"
//   probeTools(["ffmpeg", "7zz", "zip"])       // → 批量探测状态（诊断用）
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// 探测结果缓存：key = name + 关键 opts 序列化，避免每次调用都跑可执行测试
const _cache = new Map();

/** 项目根：本模块被组装到 <项目>/server/framework/tool/ 下，向上三级即项目根 */
function projectRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

/**
 * 单个候选工具是否可用（存在 + 可执行 + 版本探测）。
 * @param {string} bin    候选二进制绝对路径
 * @param {object} opts   { versionArgs?, lib?, timeoutMs?, env? }
 * @returns {boolean}
 */
function _usable(bin, opts = {}) {
  if (!bin || !fs.existsSync(bin)) return false;
  const args = opts.versionArgs || ["-version"];
  const env = opts.lib
    ? Object.assign({}, process.env, { LD_LIBRARY_PATH: opts.lib }, opts.env || {})
    : Object.assign({}, process.env, opts.env || {});
  try {
    execFileSync(bin, args, {
      timeout: opts.timeoutMs || 8000,
      stdio: "ignore",
      env,
    });
    return true;
  } catch (_) {
    return false; // 不可执行 / 缺动态库（如 stack smashing）/ 版本探测失败 → 不可用
  }
}

/** 扫描一个目录下的候选（兼容 win32 .exe） */
function _candidatesIn(dir, name) {
  if (!dir || !fs.existsSync(dir)) return [];
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  const out = [];
  for (const ext of exts) {
    const p = path.join(dir, name + ext);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

/** 取项目工具目录列表（tool/ 与 tools/ 两套都扫） */
function _toolDirs(opts = {}) {
  if (Array.isArray(opts.toolDirs) && opts.toolDirs.length) return opts.toolDirs;
  const root = opts.appRoot || projectRoot();
  return [
    path.join(root, "tool", "bin"), // 新规：tool/bin/<name>（data-backup 既有用法）
    path.join(root, "tool"),        // 新规：tool/<name>
    path.join(root, "tools"),       // 旧规：tools/<name>（gallery 既有用法）
  ];
}

/**
 * 探测一个工具：环境变量 → 项目工具目录 → 系统路径，每级可用性实测，失败降级。
 * @param {string} name  工具名（ffmpeg / 7zz / zip / unzip ...）
 * @param {object} opts  { envVar?, toolDirs?, appRoot?, libDir?, checkVersion?, timeoutMs?, fallbacks? }
 * @returns {{bin:string, lib:string, source:string}|null}
 *   bin   可用二进制路径
 *   lib   随工具的动态库目录（如 tools/ffmpeg-lib，调用方用于 LD_LIBRARY_PATH）
 *   source "env" | "tool" | "system"
 */
function detectTool(name, opts = {}) {
  if (!name) return null;
  const cacheKey = name + "|" + JSON.stringify(opts);
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  const result = _detect(name, opts);
  _cache.set(cacheKey, result);
  return result;
}

function _detect(name, opts) {
  const checkVersion = opts.checkVersion !== false; // 默认做可用性实测
  const versionArgs = opts.versionArgs || ["-version"];

  // 1) 环境变量：envVar 默认 name 大写（FFMPEG / 7ZZ / ZIP），可覆盖（如 SEVEN_ZIP）
  const envVar = opts.envVar || name.toUpperCase().replace(/-/g, "_");
  const envPath = process.env[envVar];
  if (envPath && fs.existsSync(envPath) && (!checkVersion || _usable(envPath, { versionArgs }))) {
    return { bin: envPath, lib: opts.libDir || "", source: "env" };
  }

  // 2) 项目工具目录：tool/bin → tool → tools，逐个候选实测
  const toolDirs = _toolDirs(opts);
  for (const dir of toolDirs) {
    for (const cand of _candidatesIn(dir, name)) {
      // 随工具 lib：同目录下 <name>-lib/（如 tools/ffmpeg-lib）
      const lib = opts.libDir || (fs.existsSync(path.join(dir, name + "-lib")) ? path.join(dir, name + "-lib") : "");
      if (!checkVersion || _usable(cand, { versionArgs, lib })) {
        return { bin: cand, lib, source: "tool" };
      }
      // 该候选存在但不可用（如自带 ffmpeg 报 stack smashing）→ 继续下一级，不直接返回
    }
  }

  // 3) 系统路径：PATH 里的 name（which）→ 固定 /usr/bin/<name> → /bin/<name>
  for (const sys of _systemCandidates(name)) {
    if (fs.existsSync(sys) && (!checkVersion || _usable(sys, { versionArgs }))) {
      return { bin: sys, lib: "", source: "system" };
    }
  }

  // 4) 备选名（fallbacks）：7zz 找不到时试 7z
  if (Array.isArray(opts.fallbacks)) {
    for (const fb of opts.fallbacks) {
      const r = _detect(fb, Object.assign({}, opts, { fallbacks: undefined }));
      if (r) return r;
    }
  }

  return null;
}

/** 系统路径候选：PATH 中 name → /usr/bin/name → /bin/name（按顺序实测） */
function _systemCandidates(name) {
  const out = [];
  const PATH = (process.env.PATH || "").split(path.delimiter);
  for (const dir of PATH) {
    if (!dir) continue;
    for (const cand of _candidatesIn(dir, name)) out.push(cand);
  }
  out.push("/usr/bin/" + name, "/bin/" + name);
  // 去重保序
  return [...new Set(out)];
}

/**
 * 取工具路径；探测不到时返回裸名（与原代码 findTool 兜底语义一致，由 exec 走 PATH）。
 * @returns {string}
 */
function getTool(name, opts = {}) {
  const t = detectTool(name, opts);
  return t ? t.bin : name;
}

/**
 * 批量探测（诊断/状态展示用）：列出每个工具是否可用、来源、路径。
 * @param {string[]} names
 * @param {object}   opts
 * @returns {Array<{name:string, ok:boolean, bin:string, source:string, error?:string}>}
 */
function probeTools(names, opts = {}) {
  return (names || []).map((name) => {
    try {
      const t = detectTool(name, opts);
      return { name, ok: !!t, bin: t ? t.bin : "", source: t ? t.source : "" };
    } catch (e) {
      return { name, ok: false, bin: "", source: "", error: (e && e.message) || String(e) };
    }
  });
}

module.exports = { detectTool, getTool, probeTools };
