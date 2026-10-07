// 同级/上级模块查找加载（框架层·通用）
//
// 背景：框架模块有时被项目拷贝到不同目录层级使用（如 auto-update 从
// framework/ 拼接到 lib/），此时"与依赖模块同级"不成立，require("./x")
// 会失败。本模块提供按文件名定位并加载的能力：
//   1. dirs 模式：按给定候选目录逐个查找（如 lib/ → ../framework）
//   2. 祖先链模式：从 startDir 逐级向上查找（如 server/ → 项目根）
//
// 用法：
//   const { requireUp } = require("../http/require-sibling.js");
//   // dirs 模式（lib/auto-update 找 framework/marker-manifest）：
//   const { manifestPaths } = requireUp(__dirname, "marker-manifest.js",
//       { dirs: [path.join(__dirname, "..", "framework"), __dirname] });
//   // 祖先链模式（找项目根下某模块）：
//   const { manifestPaths } = requireUp(__dirname, "marker-manifest.js");
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * 在候选目录列表里查找文件。
 * @param {string[]} dirs    候选目录（绝对路径）
 * @param {string}   fileName 目标文件名
 * @returns {string|null}
 */
function findInDirs(dirs, fileName) {
  for (const d of dirs || []) {
    const candidate = path.join(d, fileName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) { /* 不存在则试下一个 */ }
  }
  return null;
}

/**
 * 从 startDir 开始逐级向上查找文件。
 * @param {string} startDir  起始目录（含本身）
 * @param {string} fileName  目标文件名
 * @param {number} maxDepth  最多向上找多少级（默认 32，防死循环）
 * @returns {string|null}
 */
function findUp(startDir, fileName, maxDepth) {
  const depth = maxDepth || 32;
  let dir = path.resolve(startDir);
  for (let i = 0; i < depth; i++) {
    const candidate = path.join(dir, fileName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) { /* 不存在则继续向上 */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 已到文件系统根
    dir = parent;
  }
  return null;
}

/**
 * 查找并 require 目标模块。
 * @param {string} startDir  当前模块的 __dirname
 * @param {string} fileName  目标文件名
 * @param {object} [opts]
 * @param {string[]} [opts.dirs]    候选目录（绝对路径），优先于祖先链
 * @param {number}  [opts.maxDepth] 祖先链最多向上找多少级（默认 32）
 * @returns {*} require 结果
 * @throws 找不到时抛错
 */
function requireUp(startDir, fileName, opts) {
  const dirs = (opts && opts.dirs) || [];
  const maxDepth = (opts && opts.maxDepth) || 32;
  const found = findInDirs(dirs, fileName) || findUp(startDir, fileName, maxDepth);
  if (!found) {
    throw new Error("requireUp 找不到模块 " + fileName + "（dirs: " + JSON.stringify(dirs) + "，自 " + startDir + " 向上 " + maxDepth + " 级内）");
  }
  return require(found);
}

module.exports = { findInDirs, findUp, requireUp };