// ============================================================
// 拾光集 - 上传路由
//   POST /api/upload    上传单张图片（手写 multipart 解析，零依赖）
//   GET  /api/uploaded  列出项目本地 uploads/ 的图片
//
// 权限规则：不登录只能上传到预设分类「游客」（存项目本地），
//   其他目录需登录后才能上传：
//   · 无 targetDir → 游客/本地：写入项目 uploads/
//   · 带 targetDir → 需登录，且目录必须真实存在
//
// ⚠️ 本模块不经 createRoute 挂载，而是作为原生 handler 直接挂到 createServer.routes。
//    原因：createRoute 会对 POST 预读 body（按 utf8 读 + JSON.parse + 10MB 上限），
//    这会破坏 multipart 二进制内容并限制上传体积。直接挂载才能拿到原始请求流。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { jsonRes, formatSize, parseQuery, readMultipartUpload } = require("../lib/util");
const { auth } = require("../core/index.js");

// 写操作鉴权：未设密码视为开放；已设密码则校验框架会话。
// 注意：本模块是原生 handler，createServer 传进来的 ctx 只有 {cfg,auth,sendJson}，
// 没有 app.js 里那个 ctx.requireAuth，故此处自行判定（语义与之一致）。
function requireAuth(req, res, ctx) {
  const raw = ctx.cfg.readConfig();
  if (!raw.passwordHash || !raw.passwordSalt) return true;
  const token = auth.extractToken(req);
  if (token && auth.isValidSession(token)) return true;
  jsonRes(res, 401, { error: "unauthorized", needsLogin: true });
  return false;
}

const UPLOAD = path.join(__dirname, "..", "..", "uploads");

if (!fs.existsSync(UPLOAD)) fs.mkdirSync(UPLOAD, { recursive: true });

// POST /upload —— 原生 handler（签名 (req, res, subUrl, ctx)，由 createServer 直接调用）
async function apiUpload(req, res, subUrl, ctx) {
  try {
    const query = (subUrl && subUrl.query) || parseQuery(req.url);
    const targetDir = query.targetDir ? decodeURIComponent(query.targetDir) : "";
    // 带 targetDir = 登录用户上传到真实目录
    if (targetDir) {
      if (!requireAuth(req, res, ctx)) return;
      if (!targetDir.startsWith("/") || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return jsonRes(res, 400, { error: "目录无效" });
      }
    }
    const { filename, data, size } = await readMultipartUpload(req);
    if (!filename || !data) {
      return jsonRes(res, 400, { error: "No file" });
    }
    const savedName = Date.now() + "-" + filename;
    if (targetDir) {
      // 登录上传：直接写入目标真实目录（图片由扫描自动归入该目录）
      const full = path.join(targetDir, savedName);
      fs.writeFileSync(full, data);
      jsonRes(res, 200, {
        id: savedName,
        url: `/api/media?file=${encodeURIComponent(full)}`,
        name: filename,
        size: formatSize(size),
        targetDir,
      });
      return;
    }
    // 游客/本地：写入项目 uploads/
    fs.writeFileSync(path.join(UPLOAD, savedName), data);
    jsonRes(res, 200, {
      id: savedName,
      url: `/uploads/${savedName}`,
      name: filename,
      size: formatSize(size),
    });
  } catch (e) {
    jsonRes(res, 500, { error: "Upload failed: " + (e.message || String(e)) });
  }
}

// GET /uploaded — 列出 uploads/ 图片（游客上传，重启后仍可见）
function apiUploaded(req, res) {
  try {
    if (!fs.existsSync(UPLOAD)) return jsonRes(res, 200, []);
    const names = fs
      .readdirSync(UPLOAD)
      .filter((n) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n))
      .sort();
    const items = names.map((n) => ({
      id: n,
      src: "/uploads/" + encodeURIComponent(n),
      url: "/uploads/" + encodeURIComponent(n),
      name: n,
      title: n.replace(/\.[^/.]+$/, ""),
      cat: "guest",
      dirId: "Uploaded",
      dirName: "Uploaded",
      size: formatSize(fs.statSync(path.join(UPLOAD, n)).size),
    }));
    jsonRes(res, 200, items);
  } catch (e) {
    jsonRes(res, 500, { error: e.message || String(e) });
  }
}

// 原生路由入口：挂到 createServer.routes，避免 createRoute 预读 body
// 返回 true 表示已处理该请求
async function uploadRouter(req, res, subUrl, ctx) {
  const pathname = subUrl.pathname;
  if (req.method === "POST" && pathname === "/upload") {
    await apiUpload(req, res, subUrl, ctx);
    return true;
  }
  if (req.method === "GET" && pathname === "/uploaded") {
    apiUploaded(req, res);
    return true;
  }
  return false;
}

module.exports = { uploadRouter, apiUpload, apiUploaded, UPLOAD };
