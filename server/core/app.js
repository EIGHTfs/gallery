// HTTP 服务骨架（框架层）
// 项目只需传：config + routes + publicDir，框架负责其他一切。
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const urlMod = require("url");

const { sendJson } = require("../http/http-utils.js");
const { createFragmentAssembler } = require("../assemble/fragment-assembler.js");

const DEFAULT_PORT = 3000;
const CACHE_MAX_AGE = 3600;

const DEFAULT_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m3u": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".flv": "video/x-flv",
  ".mpd": "application/dash+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function isWhitelisted(pathname, whitelist) {
  for (const entry of whitelist) {
    if (pathname === entry || pathname.startsWith(entry)) return true;
  }
  return false;
}

async function serveStaticFile(res, publicDir, pathname, mime, transformHtml) {
  let filePath = path.join(publicDir, pathname);
  if (pathname.endsWith("/")) filePath = path.join(filePath, "index.html");
  if (!filePath.startsWith(publicDir)) return false;

  try {
    // 异步 IO：静态资源是每请求路径，同步读会阻塞事件循环（并发加载时尤为明显）
    if (!(await fsp.stat(filePath)).isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    let content = await fsp.readFile(filePath);
    // HTML 二次处理钩子（资源版本注入等），返回字符串或 Buffer
    if (ext === ".html" && typeof transformHtml === "function") {
      const out = transformHtml(content.toString("utf8"), pathname);
      if (out != null) content = Buffer.from(out);
    }
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=" + CACHE_MAX_AGE;
    res.writeHead(200, {
      "Content-Type": mime[ext] || "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": cacheControl,
    });
    res.end(content);
    return true;
  } catch (_) { return false; }
}

function dispatchAuth(req, res, pathname, auth, loginPath, extraPaths, needsSetup, guestPages) {
  const hasExt = path.extname(pathname);
  if (hasExt) return true; // 静态资源不鉴权
  // 未设置密码（首次初始化阶段）：不做鉴权，允许设置密码/进入页面
  if (typeof needsSetup === "function" && needsSetup()) return true;

  // 游客可读页面：画廊语义是「游客能看能传，登录才能改设置」，
  // 故页面本身不做登录门；写操作由各路由的 requireAuth 单独把守。
  if (guestPages && !pathname.startsWith("/api/")) return true;

  // 注意：loginPath 允许为空（项目无独立登录页），空串必须剔除 ——
  // startsWith("") 恒为 true，混进白名单会让所有路径直接放行。
  const whitelist = [loginPath, "/api/auth/"].concat(extraPaths || []).filter(Boolean);
  if (isWhitelisted(pathname, whitelist)) return true;

  const token = auth.extractToken(req);
  if (token && auth.isValidSession(token)) return true;

  if (pathname.startsWith("/api/")) {
    sendJson(res, { ok: false, error: "未登录" }, 401);
  } else if (loginPath) {
    res.writeHead(302, { Location: loginPath });
    res.end();
  } else {
    // 本服务没有独立登录页（登录走页面内弹窗，如 gallery 的 🔒）：
    // 不能 302 到空串（会变成自跳转死循环），改为明确告知。
    sendJson(res, { ok: false, error: "未登录", needsLogin: true }, 401);
  }
  return false;
}

async function dispatchRoutes(req, res, url, pathname, routes, ctx) {
  for (const { prefix, handler } of routes) {
    if (!pathname.startsWith(prefix)) continue;
    const subPath = pathname.slice(prefix.length) || "/";
    const subUrl = urlMod.parse(subPath + (url.search || ""), true);
    req._originalUrl = url;
    if (await handler(req, res, subUrl, ctx)) return true;
  }
  return false;
}

/**
 * 创建 HTTP 服务。
 * @param {object} opts
 * @param {object}   opts.config         - 配置管理器
 * @param {object}   opts.auth           - 鉴权模块
 * @param {string}   opts.publicDir      - 静态文件目录
 * @param {Array}    opts.routes         - 路由列表 [{ prefix, handler }]
 * @param {Array}    [opts.publicRoutes] - 认证前放行的路径前缀（如 /api/status）
 * @param {string}   [opts.loginPath]    - 登录页路径；传空串表示本服务没有独立登录页
 *                                         （登录走页面内弹窗），未登录的页面请求返回 401 JSON
 * @param {object}   [opts.extraMime]    - 额外 MIME
 * @param {function} [opts.transformHtml]- HTML 二次处理 (html, pathname) => string
 * @param {function} [opts.needsSetup]   - 返回 true 时未配置密码：页面请求重定向到
 *                                         opts.setupPath（默认 /setup.html）
 * @param {string}   [opts.setupPath]    - 首次设置页路径
 * @param {string}   [opts.port]         - 覆盖监听端口（缺省读 config.port）
 * @param {object}   [opts.fragments]    - HTML 片段组装配置：
 *                                         { dir, pages: { "index.html": ["head.html", ...] }, watch }
 *                                         命中请求返回拼装结果，片段改动后下一次请求自动重拼
 * @param {function} [opts.onReady]      - 启动回调 (port)
 */
/**
 * 给 http server 挂上 drain()：停止接收新连接，等在途响应写完再 resolve。
 * 自动更新重启前调用，避免硬退出让浏览器收到截断的 CSS/HTML
 *   （表现为「刚更新完页面样式不对，刷新几次又好了」）。
 * 做法：跟踪每条连接的活跃请求数，全部归零即放行；server.close() 的回调
 *   负责等已有连接自然关闭。
 */
function enableGracefulDrain(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    socket._activeReqs = 0;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // finish/close 都会触发，用 max(0) 防重复递减后变负
  const dec = (socket) => {
    if (socket) socket._activeReqs = Math.max(0, (socket._activeReqs || 0) - 1);
  };
  server.on("request", (req, res) => {
    const socket = req.socket;
    if (socket) socket._activeReqs = (socket._activeReqs || 0) + 1;
    res.on("finish", () => dec(socket));
    res.on("close", () => dec(socket));
  });

  server.drain = () => new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    try { server.close(finish); } catch (_) { finish(); }
    const timer = setInterval(() => {
      for (const sk of sockets) if ((sk._activeReqs || 0) > 0) return;
      clearInterval(timer);
      finish();
    }, 50);
    if (timer.unref) timer.unref();
  });
}

function createServer(opts) {
  const {
    config, auth, publicDir, routes = [],
    publicRoutes = [], loginPath = "/login.html", extraMime = {},
    transformHtml, needsSetup, setupPath = "/setup.html",
    guestPages = false,   // true=页面不设登录门（游客可读），API 仍按 publicRoutes 把关
    port: portOpt, fragments, onReady,
  } = opts;

  const mime = { ...DEFAULT_MIME, ...extraMime };
  const assembler = fragments && fragments.pages
    ? createFragmentAssembler({
        dir: fragments.dir,
        pages: fragments.pages,
        watch: fragments.watch,
        brand: fragments.brand, // 品牌配置：@brand:key 指令替换用
      })
    : null;

  /** 尝试用片段组装响应页面请求；命中返回 true */
  function serveFragment(res, pathname, mimeMap, transform) {
    if (!assembler) return false;
    const name = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    if (!assembler.list().includes(name)) return false;

    const r = assembler.render(name);
    if (!r.ok) {
      console.error("[fragments] " + name + " 组装失败: " + r.error);
      res.writeHead(500, { "Content-Type": mimeMap[path.extname(name).toLowerCase()] || "text/html; charset=utf-8" });
      res.end("<h1>页面组装失败</h1><p>" + r.error + "</p>");
      return true;
    }
    let html = r.text;
    if (typeof transform === "function") {
      const out = transform(html, pathname);
      if (out != null) html = out;
    }
    const buf = Buffer.from(html);
    // MIME 按组装页面名推断（index.html → text/html，style.css → text/css）
    const ctype = mimeMap[path.extname(name).toLowerCase()] || "text/html; charset=utf-8";
    res.writeHead(200, {
      "Content-Type": ctype,
      "Content-Length": buf.length,
      "Cache-Control": "no-cache",
    });
    res.end(buf);
    return true;
  }

  async function handleRequest(req, res) {
    const url = urlMod.parse(req.url, true);
    const pathname = decodeURIComponent(url.pathname);

    // 未设置密码：页面请求先导向首次设置页（先于鉴权门，否则会被重定向到登录页死循环）
    if (typeof needsSetup === "function" && needsSetup() && !pathname.startsWith("/api/")) {
      if (pathname === "/" || pathname === "/index.html" || pathname === setupPath) {
        if (serveFragment(res, setupPath, mime, transformHtml)) return;
        if (await serveStaticFile(res, publicDir, setupPath, mime, transformHtml)) return;
      }
    }

    if (!dispatchAuth(req, res, pathname, auth, loginPath, publicRoutes, needsSetup, guestPages)) return;

    const ctx = { cfg: config, auth, sendJson };
    if (await dispatchRoutes(req, res, url, pathname, routes, ctx)) return;
    if (serveFragment(res, pathname, mime, transformHtml)) return;
    if (await serveStaticFile(res, publicDir, pathname, mime, transformHtml)) return;

    sendJson(res, { error: "未找到" }, 404);
  }

  const server = http.createServer(handleRequest);
  enableGracefulDrain(server);
  // 端口解析：显式 port > config.get(key)（createConfig 风格）> config.readConfig()[key]（项目自研风格）
  const cfgPort = typeof config.get === "function"
    ? config.get("port")
    : (typeof config.readConfig === "function" ? (config.readConfig() || {}).port : null);
  const port = portOpt || cfgPort || process.env.PORT || DEFAULT_PORT;

  server.listen(port, () => {
      // 不传 host 时 Node 监听 ::/0.0.0.0（局域网可访问）。
      // 旧日志只打 localhost，易被误读成「只能本机访问」，故补上局域网地址。
      console.log("服务启动: http://localhost:" + port + "  (局域网: http://<本机IP>:" + port + ")");
    if (onReady) onReady(port);
  });

  return server;
}

module.exports = { createServer, DEFAULT_MIME, createFragmentAssembler };
