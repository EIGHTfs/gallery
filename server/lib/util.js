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

// 图片/文件缓存策略（2026-10-14 实测修复）：
//   故障：/api/media 原来只发 `Cache-Control: no-cache`，且**没有 ETag / Last-Modified**。
//   no-cache 的语义是「每次都必须回源校验」，而没有任何校验器可校验 ⇒ 浏览器只能**整份重新下载**
//   ⇒ 表现为「每次刷新都要重新加载图片」。
//   修法：给资源一个稳定指纹（ETag = size-mtimeMs，文件被替换即变化），允许缓存，
//   并支持 If-None-Match / If-Modified-Since ⇒ 命中回 304（零字节）。
//   思路参考 ai-work-archive 的 media-persist-cache（「mtime-size 指纹失效」），但落在标准 HTTP 层。
const DEFAULT_CACHE_MAX_AGE = 3600; // 秒（1 小时）；与静态资源策略 core/app.js 的 CACHE_MAX_AGE 同口径。
// 取值权衡：太短 ⇒ 刷新仍会发大量条件请求（虽只 304）；太长 ⇒ 图片被替换后看到旧图的时间变久。
// 1 小时是折中（1 小时内刷新零请求；文件被替换最迟 1 小时可见，强刷立即生效），
// 需要更长可改配置 mediaCacheMaxAge（例如 86400）。

/** 资源指纹：size + mtimeMs（十六进制，短且可读） */
function etagOf(st) {
  return '"' + st.size.toString(16) + "-" + Math.floor(st.mtimeMs).toString(16) + '"';
}

/** If-None-Match 匹配：支持 `*`、逗号列表、弱校验 `W/` 前缀（RFC 9110） */
function ifNoneMatchHit(headerVal, etag) {
  for (const raw of String(headerVal).split(",")) {
    const t = raw.trim();
    if (t === "*" || t === etag || t.replace(/^W\//, "") === etag) return true;
  }
  return false;
}

// 流式输出任意文件（图片/归档条目等大文件不占内存）
// 兼容两种调用（旧调用点无需改动）：
//   旧签名：streamFile(res, filePath, statusCode, headers)
//   新签名：streamFile(res, filePath, { statusCode, headers, reqHeaders, maxAge })
function streamFile(res, filePath, a, b, c) {
  const o = a && typeof a === "object" ? a : { statusCode: a, headers: b || {}, reqHeaders: c || {} };
  const statusCode = o.statusCode || 200;
  const extraHeaders = o.headers || {};
  const reqHeaders = o.reqHeaders || {};
  const maxAge = o.maxAge != null ? o.maxAge : DEFAULT_CACHE_MAX_AGE;
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(statusCode === 200 ? 404 : statusCode);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = extraHeaders["Content-Type"] || MIME_TYPES[ext] || "application/octet-stream";
    const etag = etagOf(st);
    const lastModified = new Date(st.mtimeMs).toUTCString();
    const cacheControl = "public, max-age=" + maxAge + ", must-revalidate";
    // 条件请求：If-None-Match 优先于 If-Modified-Since（RFC 9110）
    const inm = reqHeaders["if-none-match"];
    const ims = reqHeaders["if-modified-since"];
    let notModified = false;
    if (inm) {
      notModified = ifNoneMatchHit(inm, etag);
    } else if (ims) {
      const t = Date.parse(ims);
      notModified = !isNaN(t) && Math.floor(st.mtimeMs / 1000) * 1000 <= t;
    }
    if (notModified) {
      // 304：不带响应体，但仍回校验器与缓存策略，让浏览器续用本地副本
      res.writeHead(304, { ETag: etag, "Last-Modified": lastModified, "Cache-Control": cacheControl });
      res.end();
      return;
    }
    // 【原代码】const h = { "Content-Type": ct, "Cache-Control": "no-cache" };
    // 【改为】允许缓存 + 带校验器（no-cache 且无校验器会迫使浏览器每次重下整份）
    const h = Object.assign(
      { "Content-Type": ct, "Cache-Control": cacheControl, ETag: etag, "Last-Modified": lastModified },
      extraHeaders
    );
    if (st.size) h["Content-Length"] = st.size;
    res.writeHead(statusCode, h);
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
  DEFAULT_CACHE_MAX_AGE,
  parseQuery,
  readJsonBody,
  readMultipartUpload,
  formatSize,
  MIME_TYPES,
};
