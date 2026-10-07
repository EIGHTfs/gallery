// ============================================================
// 安全树复制 + 排除规则（框架层 · 通用，单一实现）
//
// 复用方：
//   1. auto-update.js（github 模式在线覆盖，Linux/macOS 走这里）
//   2. apply-staged-update.cjs（Windows 暂存更新应用，重启时覆盖）
// 两者共用同一套复制与排除逻辑，避免双份实现行为漂移。
//
// 用法：createTreeCopier({ rootDir, excludePaths, excludeDirs,
//   excludeSuffix, loadExtraExcludes, onSkip })
//   → { isExcluded, copyTreeSafe }
//   - excludePaths   精确文件路径 / 目录前缀（内置 + 项目追加）
//   - excludeDirs    任意层级目录名（系统元数据 / 依赖 / 构建产物）
//   - excludeSuffix  后缀规则（日志 / PID / 备份残留）
//   - loadExtraExcludes 动态排除清单回调（如 userdata-manifest.json）
//   - onSkip         跳过条目回调（记录日志用，可选）
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

function createTreeCopier(opts) {
  const rootDir = (opts && opts.rootDir) || ".";
  const excludePaths = ((opts && opts.excludePaths) || []).slice();
  const excludeDirs = ((opts && opts.excludeDirs) || []).slice();
  const excludeSuffix = ((opts && opts.excludeSuffix) || []).slice();
  const loadExtra = (opts && opts.loadExtraExcludes) || (() => []);
  const onSkip = (opts && opts.onSkip) || null;

  /** 判断相对路径是否命中排除清单（精确匹配或前缀匹配） */
  function isExcluded(relPath) {
    const p = String(relPath).replace(/\\/g, "/");
    // 1) 任意层级目录名（如 json/@eaDir/x.json 里的 @eaDir）
    const segs = p.split("/");
    if (excludeDirs.some((d) => segs.includes(d))) return true;
    // 2) 后缀规则（任意路径段结尾匹配）
    if (excludeSuffix.some((s) => p.endsWith(s))) return true;
    // 3) 精确文件路径 / 目录前缀（内置 + 项目追加 + 动态清单）
    const allRules = excludePaths.concat(loadExtra());
    return allRules.some((rule) => p === rule || p.startsWith(rule + "/"));
  }

  /** 安全复制：把 src 下的代码树复制到 dst（覆盖/新增），跳过运行态与敏感路径 */
  function copyTreeSafe(src, dst, relBase) {
    // dst 可能不存在（顶层首个条目是文件时 copyFileSync 会 ENOENT），先建目录
    try { fs.mkdirSync(dst, { recursive: true }); } catch (_) {}
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const ent of entries) {
      // 相对路径要累积（排除规则按完整相对路径匹配，如 json/userdata-manifest.json）
      const rel = relBase ? relBase + "/" + ent.name : ent.name;
      if (isExcluded(rel)) {
        if (onSkip) onSkip(rel);
        continue;
      }
      const s = path.join(src, ent.name);
      const d = path.join(dst, ent.name);
      if (ent.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyTreeSafe(s, d, rel);
      } else if (ent.isFile()) {
        fs.copyFileSync(s, d);
      }
    }
  }

  return { isExcluded, copyTreeSafe };
}

module.exports = { createTreeCopier };
