// ============================================================
// 拾光集 - 通用 HTTP 工具（零依赖）
// 原先内联在 app.js，重构时按「工具 / 业务」拆出，供 lib/ 与 routes/ 共用。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

// ─── 响应辅助 ───
// 与框架 sendJson 行为一致，但保留旧签名 (res, code, data)：
// gallery 现有 20+ 处调用沿用该签名，改签名收益小于改动量。
function jsonRes(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// 流式输出任意文件（图片/归档条目等大文件不占内存）
function streamFile(res, filePath, statusCode, headers) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(statusCode || 404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = (headers && headers["Content-Type"]) || MIME_TYPES[ext] || "application/octet-stream";
    const h = { "Content-Type": ct, "Cache-Control": "no-cache" };
    if (st.size) h["Content-Length"] = st.size;
    res.writeHead(statusCode || 200, h);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ─── URL 查询参数解析（替代 express req.query）───
function parseQuery(rawUrl) {
  const qi = rawUrl.indexOf("?");
  if (qi === -1) return {};
  const params = {};
  for (const pair of rawUrl.slice(qi + 1).split("&")) {
    if (!pair) continue;
    const ei = pair.indexOf("=");
    const k = decodeURIComponent(ei === -1 ? pair : pair.slice(0, ei));
    const v = ei === -1 ? "" : decodeURIComponent(pair.slice(ei + 1));
    params[k] = v;
  }
  return params;
}

// ─── JSON body 读取 ───
// 注意：走框架 createRoute 时，它已把 body 读完放进 req.body；
// 此时直接复用，绝不能再读一次请求流（流只能消费一次，二次读会永久挂起）。
function readJsonBody(req) {
  if (req && req.body !== undefined) return Promise.resolve(req.body || {});
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      chunks.push(c);
      total += c.length;
      // 防御：设置页配置体积极小，超过 2MB 视为异常请求，避免内存被打满
      if (total > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ─── multipart/form-data 上传解析（替代 multer）───
// 思路：从 Content-Type 取 boundary → 在 body 中定位 boundary 分割的文件段 → 提取文件名+二进制
function readMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers["content-type"] || "";
    const bm = ct.match(/boundary=([^;\s]+)/);
    if (!bm) {
      reject(new Error("no boundary"));
      return;
    }
    const boundary = bm[1];
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      chunks.push(c);
      total += c.length;
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks, total);
      const sep = Buffer.from("--" + boundary + "\r\n");
      const end = Buffer.from("\r\n--" + boundary);
      const s1 = buf.indexOf(sep);
      if (s1 === -1) {
        reject(new Error("malformed multipart"));
        return;
      }
      const e1 = buf.indexOf(end, s1 + sep.length);
      if (e1 === -1) {
        reject(new Error("no end boundary"));
        return;
      }
      const part = buf.slice(s1 + sep.length, e1);
      const hd = part.indexOf("\r\n\r\n");
      if (hd === -1) {
        reject(new Error("no part headers"));
        return;
      }
      const headers = part.slice(0, hd).toString("utf8");
      const data = part.slice(hd + 4);
      const m = headers.match(/filename="([^"]*)"/);
      const filename = m ? m[1] : "unknown";
      resolve({ filename, data, size: data.length });
    });
    req.on("error", reject);
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

module.exports = {
  jsonRes,
  streamFile,
  parseQuery,
  readJsonBody,
  readMultipartUpload,
  formatSize,
  MIME_TYPES,
};
