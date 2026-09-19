// ============================================================
// 拾光集 - 收藏路由
// 收藏功能：预设不可删改的收藏分类，收藏的图片在其中平铺。
//   权限上读开放、写需登录（游客可看，登录用户可点收藏）。
//   GET    /api/favorites  列表（游客可看）
//   POST   /api/favorites  添加（需登录）
//   DELETE /api/favorites  移除（需登录）
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { jsonRes, readJsonBody } = require("../lib/util");

const FAV_FILE = path.join(__dirname, "..", "favorites.json");

function loadFavorites() {
  try {
    const raw = JSON.parse(fs.readFileSync(FAV_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function saveFavorites(arr) {
  fs.writeFileSync(FAV_FILE, JSON.stringify(arr, null, 2), "utf8");
}

// GET /api/favorites
function apiGetFavorites(req, res) {
  jsonRes(res, 200, loadFavorites());
}

// POST /api/favorites — 添加收藏（需登录）
async function apiPostFavorite(req, res, ctx) {
  if (!ctx.requireAuth(req, res)) return;
  const body = await readJsonBody(req);
  const { src, name, title, cat, dir, size, root } = body;
  if (!src) return jsonRes(res, 400, { error: "src required" });
  const favs = loadFavorites();
  if (favs.find((f) => f.src === src)) {
    return jsonRes(res, 200, { ok: true, alreadyExists: true, favorites: favs });
  }
  favs.push({ src, name, title, cat, dir, size, root, addedAt: Date.now() });
  saveFavorites(favs);
  jsonRes(res, 200, { ok: true, favorites: favs });
}

// DELETE /api/favorites — 移除收藏（需登录）
async function apiDeleteFavorite(req, res, ctx) {
  if (!ctx.requireAuth(req, res)) return;
  const body = await readJsonBody(req);
  const { src } = body || {};
  if (!src) return jsonRes(res, 400, { error: "src required" });
  let favs = loadFavorites();
  favs = favs.filter((f) => f.src !== src);
  saveFavorites(favs);
  jsonRes(res, 200, { ok: true, favorites: favs });
}

module.exports = { apiGetFavorites, apiPostFavorite, apiDeleteFavorite, loadFavorites, saveFavorites };
