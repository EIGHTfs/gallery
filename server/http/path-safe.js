// ============================================================
// 路径安全（框架层 · 通用）
//
// 场景：局域网自用项目——「📂 读取本地选择」只需拉黑各平台系统关键目录，
//   不做白名单收敛到下载根（无下载根时也应可浏览）。
//
// 统一化（2026-09-17）：合并 gbmd 与 iwara 两份同源实现，取并集：
//   - 目录黑名单：iwara 版（POSIX + macOS 独立列出 + Windows 任意盘符，
//     比 gbmd 硬编码 C:\ 更完整）
//   - 大小写：统一 resolve 后转小写比较（Windows / macOS 大小写不敏感，
//     Linux 上系统目录本就全小写，多转一次无副作用）
//   - 垃圾目录过滤：iwara 版 isSystemJunkName（群晖 @eaDir、回收站 #recycle 等）
//   - 命名：同时导出两套别名，各项目调用点无需改动
//       isBlocked / isBrowsableDir     ← gbmd 原命名
//       isDeniedBrowseDir              ← iwara 原命名（语义同 isBlocked 的反面）
// ============================================================
"use strict";

const path = require("path");

// 系统关键目录黑名单（跨平台，含 POSIX + macOS + Windows）。
// 匹配规则：resolve 后的绝对路径，小写比较，等于根或 startsWith 根+sep 即命中。
// POSIX：/etc /proc /sys /dev /var /boot /root /run /sbin /bin /lib /lib64 /usr
//        macOS 额外：/System /Library /Applications /private
// Windows：各盘符的 \Windows \Program Files \Program Files (x86) \ProgramData \Recovery
const DENY_ROOTS = [
  // POSIX 系统目录
  "/etc", "/proc", "/sys", "/dev", "/var", "/boot", "/root", "/run",
  "/sbin", "/bin", "/lib", "/lib64", "/usr",
  // macOS
  "/system", "/library", "/applications", "/private",
  // Windows（任意盘符）
  ":\\windows", ":\\program files", ":\\program files (x86)", ":\\programdata", ":\\recovery"
];

/**
 * 是否命中系统关键目录黑名单。
 * @param {string} dir 绝对路径（相对路径会按 cwd resolve）
 * @returns {boolean} true = 应拒绝访问
 */
function isDeniedBrowseDir(dir) {
  const abs = path.resolve(String(dir || ""));
  const low = abs.toLowerCase();
  return DENY_ROOTS.some((root) => {
    if (low === root) return true;
    if (low.startsWith(root + path.sep)) return true;
    // Windows 盘符匹配：把 "C:\windows" 这类盘符化根匹配掉
    if (root.startsWith(":\\")) {
      const drive = low.match(/^[a-z]:/);
      if (!drive) return false;
      const candidate = drive[0] + root;
      return low === candidate || low.startsWith(candidate + "\\") || low.startsWith(candidate + path.sep);
    }
    return false;
  });
}

/**
 * 目录列表里要过滤的系统残留目录名（browse 列条目时用）。
 * @param {string} name 目录名（不含路径）
 * @returns {boolean} true = 应过滤掉
 */
function isSystemJunkName(name) {
  return name === "@eaDir" || name === "#recycle" || name === ".git" || name === "System Volume Information";
}

/**
 * 路径是否被禁止（isDeniedBrowseDir 的同义别名，供 gbmd 沿用原命名）。
 * @param {string} abs 绝对路径
 * @returns {boolean} true = 命中黑名单
 */
function isBlocked(abs) {
  return isDeniedBrowseDir(abs);
}

/**
 * dir 是否可浏览：不在黑名单内即放行。
 * 局域网自用项目，无需白名单收敛到下载根。
 * @param {string} dir 目录路径
 * @returns {boolean} true = 可浏览
 */
function isBrowsableDir(dir) {
  return !isDeniedBrowseDir(dir);
}

module.exports = {
  // 通用命名
  isDeniedBrowseDir,
  isSystemJunkName,
  // gbmd 原命名（别名，保持调用点不变）
  isBlocked,
  isBrowsableDir,
  // 黑名单本体（供测试/调试查看）
  DENY_ROOTS,
  BLOCKED_ROOTS: DENY_ROOTS,
};
