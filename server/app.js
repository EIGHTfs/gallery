// ============================================================
// 拾光集 - 入口（装配层）
//
// 零依赖 HTTP 画廊服务。本文件只做「装配」，不写业务逻辑：
//   ① 建配置（框架 createConfig）+ 初始化鉴权（框架 auth）
//   ② 声明路由表（业务实现分布在 routes/*.js）
//   ③ createServer 启动（框架负责 HTTP/静态/登录门/MIME）
//
// 目录约定：
//   server/framework/  框架（组装生成，勿手改）
//   server/lib/        本项目工具与领域逻辑（util/config/scan/archive/gif）
//   server/routes/     本项目业务路由（browse/archive/gallery/upload/favorites）
//   server/public/     前端静态页
//   tools/             ffmpeg + 7zz（外部二进制，不入库）
//
// 鉴权模型（保留原有语义，与框架默认不同）：
//   浏览开放、改设置需登录。框架的登录门默认「未登录全部重定向」，
//   故把浏览类 API 与登录页放进 publicRoutes 放行，写操作用 ctx.requireAuth 单独把守。
// ============================================================
"use strict";

const path = require("path");
const fs = require("fs");

const {
  createConfig,
  createServer,
  createRoute,
  createAutoUpdate,
  sendJson,
  readBody,
  appLog,
  auth: fwAuth,
} = require("./core/index.js");



const { jsonRes } = require("./lib/util");
const { CONFIG } = require("./lib/config");
const authRoutes = require("./routes/auth");
const autoUpdateRoutes = require("./routes/auto-update");
// 自动更新实例：定义在 lib/auto-update.js（路由模块自行 require，不经 ctx）
const autoUpdate = require("./lib/auto-update");
const browse = require("./routes/browse");
const archive = require("./routes/archive");
const gallery = require("./routes/gallery");
const upload = require("./routes/upload");
const favorites = require("./routes/favorites");

const PUBLIC = path.join(__dirname, "public");
const SESSION_HOURS = 72;

// ============================================================
// ① 配置与鉴权
// ============================================================
appLog.install();

const config = createConfig({
  configFile: CONFIG,
  schema: require("./config.schema.json"),
});

// 会话持久化：重启后免登录
fwAuth.init({
  sessionFile: path.join(__dirname, "sessions.json"),
  cookieName: "session",
});

// 鉴权路由：复用框架通用件 routes-auth.js，经 adapter 转表式
// （需 cfg，故在此装配而非 require 时）
const authTable = authRoutes.init({ cfg: config });
const authPublicTable = authTable.public;
// 自动更新路由：同样复用框架通用件（转表式）
const autoUpdateTable = autoUpdateRoutes.init({ cfg: config });

// ─── CLI：--set-password "xx" ───
const _pwdIdx = process.argv.indexOf("--set-password");
if (_pwdIdx !== -1) {
  const pwd = process.argv[_pwdIdx + 1];
  if (!pwd || String(pwd).length < 4) {
    console.error('❌ 密码至少 4 位: node server/app.js --set-password "新密码"');
    process.exit(1);
  }
  config.setPassword(pwd);
  console.log("✓ 密码已设置（scrypt 哈希存入 config.json）");
  process.exit(0);
}

// 是否已设密码：未设则浏览全开放，写操作也放行（与旧行为一致）
function needsSetup() {
  const raw = config.readConfig();
  return !raw.passwordHash || !raw.passwordSalt;
}

// 写操作鉴权：未设密码视为开放；已设密码则校验框架会话
// （会话签发/校验统一走框架 auth；cookie 名 session）
function requireAuth(req, res) {
  if (needsSetup()) return true;
  const token = fwAuth.extractToken(req);
  if (token && fwAuth.isValidSession(token)) return true;
  jsonRes(res, 401, { error: "unauthorized", needsLogin: true });
  return false;
}

// 所有业务路由共用的上下文（供 routes/ 下的模块取用）
const ctx = { cfg: config, auth: fwAuth, sendJson, requireAuth, SESSION_HOURS };

// ============================================================
// ② 路由表
// ============================================================
const browseRoutes = createRoute({
  "GET /directories": (req, res, c) => browse.apiDirectories(c.query, res),
  "GET /images": (req, res, c) => browse.apiImages(c.query, res),
  "GET /dir": (req, res, c) => browse.apiDir(c.query, res),
  "GET /media": (req, res, c) => browse.apiMedia(c.query, res),
});

const archiveRoutes = createRoute({
  "GET /zip/scan": (req, res, c) => archive.apiZipScan(c.query, res),
  "GET /zip/img": (req, res, c) => archive.apiZipImg(c.query, res),
  "GET /gif": (req, res, c) => archive.apiGif(c.query, res),
  "GET /zip/gif": (req, res, c) => archive.apiZipGif(c.query, res),
});

const galleryRoutes = createRoute({
  "GET /gallery": (req, res) => gallery.apiGetGallery(req, res, ctx),
  "POST /gallery": (req, res) => gallery.apiPostGallery(req, res, ctx),
});

// 上传路由不经 createRoute：它需要原始请求流做 multipart 解析，
// 而 createRoute 会预读 body（utf8 + JSON.parse + 10MB 上限），会破坏二进制上传。
// 故作为原生 handler 直接挂到 createServer.routes（见下方 routes 配置）。
const favRoutes = createRoute({
  "GET /favorites": (req, res) => favorites.apiGetFavorites(req, res, ctx),
  "POST /favorites": (req, res) => favorites.apiPostFavorite(req, res, ctx),
  "DELETE /favorites": (req, res) => favorites.apiDeleteFavorite(req, res, ctx),
});

// ============================================================
// ③ 启动
// ============================================================
// schema 缺失时不静默降级：真跑到这一步说明组装没做，明确报错优于神秘 500
if (!fs.existsSync(path.join(__dirname, "config.schema.json"))) {
  console.error("❌ 未找到 server/config.schema.json —— 请先运行 ./setup.sh gallery 组装项目层");
  process.exit(1);
}

createServer({
  config,
  auth: fwAuth,
  publicDir: PUBLIC,
  routes: [
    // 鉴权路由（登录/登出/状态/改密）：表内写的是【全路径】/api/login，
    // 故 prefix 必须为空 —— createServer 会切掉 prefix 再进路由表匹配，
    // 用 "/api" 会把 /api/login 切成 /login 导致 404（gbmd 同此写法）。
    { prefix: "", handler: authPublicTable },
    { prefix: "", handler: authTable },
    { prefix: "/api", handler: browseRoutes },
    { prefix: "/api", handler: archiveRoutes },
    { prefix: "/api", handler: galleryRoutes },
    // 上传：原生 handler（保留原始流做 multipart，勿改用 createRoute）
    { prefix: "/api", handler: upload.uploadRouter },
    { prefix: "/api", handler: favRoutes },
    // 自动更新：表内写的是【全路径】/api/auto-update/xxx，故 prefix 为空
    { prefix: "", handler: autoUpdateTable },
  ],
  // 浏览开放：登录门只挡写操作，这些读路径与登录页放行
  publicRoutes: [
    // 鉴权端点：登录/登出/状态必须免鉴权，否则未登录无法登录（死循环）
    "/api/login",
    "/api/logout",
    "/api/status",
    // 浏览类：拾光集语义是「浏览开放、改设置需登录」
    "/api/directories",
    "/api/images",
    "/api/dir",
    "/api/media",
    "/api/uploaded",
    // 上传：无 targetDir 时游客可传（写入项目 uploads/），带 targetDir 才要求登录；
    // 该判定由 routes/upload.js 的 requireAuth 负责，故此处须先放行框架登录门。
    "/api/upload",
    "/api/favorites",
    "/api/gallery",
    "/api/zip/",
    "/api/gif",
  ],
  needsSetup,
  // 画廊没有登录页：登录走页面内的 🔒 弹窗（index.html 的 loginModal + POST /api/login），
  // 故不声明 loginPath —— 留空表示「本服务无独立登录页」，框架不会 302 到不存在的地址。
  loginPath: "",
  // 页面不设登录门：游客直接进画廊看图，也能上传到「游客」分类；
  // 设置 / 收藏 / 改密等写操作由各路由的 requireAuth 把关。
  guestPages: true,
  port: parseInt(process.env.PORT, 10) || 8081,
  onReady(port) {
    autoUpdate.start(config.readConfig().autoUpdate || { enabled: false });
    console.log(`🎮 Gallery running at http://localhost:${port}  (局域网: http://<本机IP>:${port})`);
  },
});
