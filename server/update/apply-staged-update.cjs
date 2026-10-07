#!/usr/bin/env node
// ============================================================
// 暂存更新应用器（Windows 自动更新用，零依赖 CJS）
// 用法：node server/update/apply-staged-update.cjs
//
// 背景：Windows 下运行中的服务会锁住已加载的 .js 文件，
//   github 模式在线覆盖会 EPERM 失败。auto-update.js 在 win32
//   平台改为「下载 → 暂存到 .auto-update-staged/<sha>/ → 写
//   .auto-update-pending.json → 触发 start-windows.bat restart」；
//   bat 的 restart 在停掉旧进程后、拉起新进程前调用本脚本，
//   此时文件无锁，覆盖成功后再清理暂存与 pending 标记。
//
// 排除规则与 auto-update.js 共用 tree-copy.js 单一实现，
// 清单随 pending 标记序列化（auto-update 写入时快照），
// 另叠加 json/userdata-manifest.json 动态运行态清单。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..", ".."); // server/update/ → 项目根
const PENDING_FILE = path.join(ROOT_DIR, ".auto-update-pending.json");
const STAGED_ROOT = path.join(ROOT_DIR, ".auto-update-staged");
const { createTreeCopier } = require("./tree-copy.js");

/** 读取 data-backup 生成的 userdata-manifest.json 运行态清单（与 auto-update 同构） */
function loadUserdataExcludes() {
  const out = [];
  try {
    const mf = path.join(ROOT_DIR, "json", "userdata-manifest.json");
    if (fs.existsSync(mf)) {
      const m = JSON.parse(fs.readFileSync(mf, "utf8"));
      for (const f of m.files || []) if (f && f.rel) out.push(f.rel);
      for (const d of m.dirs || []) if (d && d.rel) out.push(d.rel);
    }
  } catch (_) {}
  return out;
}

function main() {
  if (!fs.existsSync(PENDING_FILE)) {
    console.log("[apply-update] 无暂存更新（无 pending 标记）");
    return 0;
  }
  let pend;
  try {
    pend = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch (e) {
    console.error("[apply-update] pending 标记损坏: " + (e && e.message || String(e)) + "，清除标记继续启动");
    try { fs.rmSync(PENDING_FILE, { force: true }); } catch (_) {}
    return 2;
  }
  const sha = pend && pend.sha;
  if (!sha) {
    console.error("[apply-update] pending 标记缺 sha，跳过");
    return 2;
  }
  const staged = path.join(STAGED_ROOT, sha);
  if (!fs.existsSync(staged)) {
    console.error("[apply-update] 暂存目录不存在: " + staged + "，跳过（保留旧版本）");
    try { fs.rmSync(PENDING_FILE, { force: true }); } catch (_) {}
    return 2;
  }
  console.log("[apply-update] 应用暂存更新 " + sha.slice(0, 8) + " ...");
  const copier = createTreeCopier({
    rootDir: ROOT_DIR,
    excludePaths: (pend.excludePaths || []),
    excludeDirs: (pend.excludeDirs || []),
    excludeSuffix: (pend.excludeSuffix || []),
    loadExtraExcludes: () => loadUserdataExcludes(),
    onSkip: (rel) => console.log("[apply-update] 跳过(排除): " + rel),
  });
  copier.copyTreeSafe(staged, ROOT_DIR);
  // 清理暂存与标记（staged 根目录一并清，空目录不落盘）
  try { fs.rmSync(staged, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(STAGED_ROOT, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(PENDING_FILE, { force: true }); } catch (_) {}
  console.log("[apply-update] ✓ 已应用 " + sha.slice(0, 8) + "，暂存与标记已清理");
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error("[apply-update] 失败: " + (e && e.stack || String(e)));
  process.exit(1);
}
