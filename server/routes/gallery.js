// ============================================================
// 拾光集 - 画廊配置路由
//   GET  /api/gallery  读取配置（不含密码哈希；浏览开放）
//   POST /api/gallery  保存配置（需登录）
//   GET  /api/io       IO 监测快照（按 label + 按调用点归因；需登录——含本机路径与调用点）
// ============================================================
"use strict";

const { jsonRes, readJsonBody } = require("../lib/util");
const { loadConfig, saveConfig, publicConfig } = require("../lib/config");
const ioMonitor = require("../lib/io-monitor");

// GET /api/gallery
function apiGetGallery(req, res, ctx) {
  jsonRes(res, 200, publicConfig(loadConfig()));
}

// GET /api/io —— 2026-10-12：扫描/IO 归因（byLabel + bySite，站点为 file:line）
function apiIo(req, res, ctx) {
  if (!ctx.requireAuth(req, res)) return;   // 含本机绝对路径与调用点，不对外开放
  jsonRes(res, 200, ioMonitor.snapshot());
}

// POST /api/gallery — 保存画廊配置（需登录）
async function apiPostGallery(req, res, ctx) {
  if (!ctx.requireAuth(req, res)) return;
  const body = await readJsonBody(req);
  const cfg = loadConfig();
  const { title, favicon, categories, directories, excludeDirs, fsRoot } = body;
  if (title !== undefined) cfg.title = title;
  if (favicon !== undefined) cfg.favicon = favicon;
  if (Array.isArray(categories)) cfg.categories = categories;
  if (Array.isArray(directories)) cfg.directories = directories;
  if (Array.isArray(excludeDirs)) cfg.excludeDirs = excludeDirs;
  if (typeof fsRoot === "string") cfg.fsRoot = fsRoot;
  saveConfig(cfg);
  jsonRes(res, 200, { ok: true, ...publicConfig(cfg) });
}

module.exports = { apiGetGallery, apiPostGallery, apiIo };
