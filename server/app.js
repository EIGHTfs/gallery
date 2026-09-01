// ============================================================
// 拾光集 - 零依赖 HTTP 服务器
// 用户原话「完全零依赖」——不用 express/cors/multer，纯 Node.js 内置模块
// 一个进程同时服务静态页 + API，不再需要 python3 8080
// ============================================================
"use strict";

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const zlib    = require('zlib');
const { execFileSync } = require('child_process');

// 学 downloader：server/ 后端，server/public/ 网页，config/sessions 在 server/
const ROOT   = path.join(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const PORT   = parseInt(process.env.PORT, 10) || 8081;
const UPLOAD = path.join(ROOT, 'uploads');
const CONFIG = path.join(__dirname, 'config.json');

// 鉴权（登录后才能修改设置；浏览不强制）——auth.js 本身已零依赖
const auth = require('./auth');
const SESSION_HOURS = 72;

// ─── 命令行：--set-password "xx"（参照 gbmd-v3 start-linux.sh）───
const _pwdIdx = process.argv.indexOf('--set-password');
if (_pwdIdx !== -1) {
  const pwd = process.argv[_pwdIdx + 1];
  if (!pwd || String(pwd).length < 4) {
    console.error('❌ 密码至少 4 位: node server/app.js --set-password "新密码"');
    process.exit(1);
  }
  const { hash, salt } = auth.hashPassword(pwd);
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    raw.passwordHash = hash;
    raw.passwordSalt = salt;
    fs.writeFileSync(CONFIG, JSON.stringify(raw, null, 2), 'utf8');
    console.log('✓ 密码已设置（scrypt 哈希存入 config.json）');
  } catch (e) {
    console.error('❌ 写入 config.json 失败:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

// 工具（自包含）：tools/ 优先，系统路径兜底
const TOOLS_DIR     = path.join(ROOT, 'tools');
const CACHE_GIF_DIR = path.join(ROOT, 'cache-gifs');
const IMG_EXT_RE  = /\.(jpe?g|png|gif|webp)$/i;
const ZIP_EXT_RE  = /\.(zip|7z|rar)$/i;

function _pickFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return { bin: process.env.FFMPEG, lib: "" };
  const tool = path.join(TOOLS_DIR, 'ffmpeg');
  const lib  = path.join(TOOLS_DIR, 'ffmpeg-lib');
  if (fs.existsSync(tool)) {
    try {
      execFileSync(tool, ['-version'], { timeout: 8000, stdio: 'ignore', env: lib ? Object.assign({}, process.env, { LD_LIBRARY_PATH: lib }) : undefined });
      return { bin: tool, lib };
    } catch (_) {}
  }
  return { bin: fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg', lib: "" };
}
const _ff = _pickFfmpeg();
const FFMPEG = _ff.bin;
const FFMPEG_LIB = _ff.lib;
const SEVEN_ZIP = fs.existsSync(path.join(TOOLS_DIR, '7zz')) ? path.join(TOOLS_DIR, '7zz') : '/usr/bin/7z';

if (!fs.existsSync(UPLOAD)) fs.mkdirSync(UPLOAD, { recursive: true });

// ============================================================
// 零依赖 HTTP 工具函数（替代 express 中间件链）
// ============================================================

// ─── 响应辅助（替代 res.json / res.status().json）───
function jsonRes(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

// ─── 静态文件流式输出（替代 express.static / res.sendFile）───
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function streamFile(res, filePath, statusCode, headers) {
  // 通用：流式输出任意文件到 HTTP 响应（替代 express res.sendFile）
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(statusCode || 404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = (headers && headers['Content-Type']) || MIME_TYPES[ext] || 'application/octet-stream';
    const h = { 'Content-Type': ct, 'Cache-Control': 'no-cache' };
    if (st.size) h['Content-Length'] = st.size;
    res.writeHead(statusCode || 200, h);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ─── URL 查询参数解析（替代 express req.query）───
function parseQuery(rawUrl) {
  const qi = rawUrl.indexOf('?');
  if (qi === -1) return {};
  const params = {};
  for (const pair of rawUrl.slice(qi + 1).split('&')) {
    if (!pair) continue;
    const ei = pair.indexOf('=');
    const k = decodeURIComponent(ei === -1 ? pair : pair.slice(0, ei));
    const v = ei === -1 ? '' : decodeURIComponent(pair.slice(ei + 1));
    params[k] = v;
  }
  return params;
}

// ─── JSON body 读取（替代 express.json() 中间件）───
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── multipart/form-data 文件上传解析（替代 multer.diskStorage）───
// 思路：从 Content-Type 取 boundary → 在 body 中定位 boundary 分割的文件段 → 提取文件名+二进制内容
function readMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=([^;\s]+)/);
    if (!bm) { reject(new Error('no boundary')); return; }
    const boundary = bm[1];
    const chunks = [];
    let total = 0;
    req.on('data', c => { chunks.push(c); total += c.length; });
    req.on('end', () => {
      const buf = Buffer.concat(chunks, total);
      const sep  = Buffer.from('--' + boundary + '\r\n');
      const end  = Buffer.from('\r\n--' + boundary);
      const s1 = buf.indexOf(sep);
      if (s1 === -1) { reject(new Error('malformed multipart')); return; }
      const e1 = buf.indexOf(end, s1 + sep.length);
      if (e1 === -1) { reject(new Error('no end boundary')); return; }
      const part = buf.slice(s1 + sep.length, e1);
      const hd = part.indexOf('\r\n\r\n');
      if (hd === -1) { reject(new Error('no part headers')); return; }
      const headers = part.slice(0, hd).toString('utf8');
      const data = part.slice(hd + 4);
      const m = headers.match(/filename="([^"]*)"/);
      const filename = m ? m[1] : 'unknown';
      resolve({ filename, data, size: data.length });
    });
    req.on('error', reject);
  });
}

// ─── 静态文件服务（替代 express.static + python3 http.server）───
// 用户原话「完全零依赖」——一个进程同时服务静态页 + API
function serveStatic(res, pathname) {
  // 安全：禁止路径穿越
  if (pathname.includes('..')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  // /uploads/ → UPLOAD 目录
  if (pathname.startsWith('/uploads/')) {
    const fp = path.join(UPLOAD, pathname.slice('/uploads/'.length));
    return streamFile(res, fp);
  }
  // 根路径 → index.html
  let fp;
  if (pathname === '/' || pathname === '') {
    fp = path.join(PUBLIC, 'index.html');
  } else {
    fp = path.join(PUBLIC, pathname);
  }
  // 目录则 403
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(fp).pipe(res);
  });
}

// ============================================================
// Config 持久化（与原版相同）
// ============================================================
const DEFAULT_CONFIG = {
  title: 'Gallery',
  categories: [],
  directories: [],
};

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (c && c.categories && c.directories) return c;
  } catch (e) { /* no config yet */ }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

// 排除目录（群晖 @eaDir 等系统目录）：config.json 的 excludeDirs 配置，默认 @eaDir
function getExcludeDirs() {
  const c = loadConfig();
  const arr = Array.isArray(c.excludeDirs) ? c.excludeDirs : ['@eaDir'];
  return new Set(arr.map(n => String(n).trim()).filter(Boolean));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2), 'utf8');
}

// ============================================================
// 鉴权辅助（与原版逻辑相同，改为直接返回 boolean）
// ============================================================
auth.loadSessions();

function isAuthed(req) {
  return auth.isValidSession(auth.extractToken(req));
}

// 设置页需要登录：检查 session cookie
// 返回 true=放行，false=未授权（替代 express requireAuth 中间件）
function checkAuth(req) {
  const cfg = loadConfig();
  if (!cfg.passwordHash || !cfg.passwordSalt) return true;  // 未设置密码：开放
  return isAuthed(req);
}

// 浏览器看不到密码哈希
function publicConfig(cfg) {
  const { passwordHash, passwordSalt, ...rest } = cfg;
  return { ...rest, fsRoot: resolveFsRoot(cfg) };
}

// 浏览根：环境变量 / config.fsRoot / 已配置目录的公共前缀 / 系统根。禁止写死 /vol02。
function resolveFsRoot(cfg) {
  const c = cfg || loadConfig();
  const envRoot = process.env.GALLERY_FS_ROOT;
  if (envRoot && fs.existsSync(envRoot)) return path.resolve(envRoot);
  if (c.fsRoot && fs.existsSync(c.fsRoot)) return path.resolve(c.fsRoot);
  const dirs = (c.directories || [])
    .map(d => d && d.path)
    .filter(p => typeof p === 'string' && p && fs.existsSync(p))
    .map(p => path.resolve(p));
  if (dirs.length) {
    const segs = dirs.map(p => p.split(path.sep).filter(Boolean));
    let i = 0;
    while (i < segs[0].length && segs.every(s => s[i] === segs[0][i])) i++;
    const prefix = path.sep + segs[0].slice(0, Math.max(i, 1)).join(path.sep);
    if (fs.existsSync(prefix)) return prefix;
  }
  return path.parse(ROOT).root || '/';
}

function queryRoot(query) {
  if (query.root) return query.root;
  return resolveFsRoot();
}

// ============================================================
// 目录扫描缓存：懒刷新（目录 mtime 探针，避免每次请求全树递归）
// 问题：CIFS 挂载上整树递归 readdirSync 极慢（8559 目录 ≈ 9s），一次 /api/images?recursive=true 就卡死页面。
// 方案（同旧 gbmd-gallery autoRefreshIngest 思路）：
//   首次扫描后缓存 { images, dirMtimes: Map<目录, mtimeMs> }；
//   后续请求只 stat 已知目录（单次 stat ≈ 0.03ms，不 readdir）探 mtime，
//   全部未变 → 直接返回缓存（每次请求 ≈250ms 秒回，不再 9s 全扫）；
//   任一目录 mtime 变化（增/删/改都会改父目录 mtime）→ 全树重扫一次并刷新缓存。
const IMAGE_SCAN_CACHE = new Map(); // 绝对根路径 -> { searchPath, images, dirMtimes, ts, probedAt }
const IMAGE_PROBE_INTERVAL = 30 * 1000; // 探针节流：30s 内不重复 stat 全量目录，直接返回缓存

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return -1; }
}

// 全树递归扫描：收集图片 + 记录【所有目录】的 mtime
function recursiveScanAll(dir) {
  const images = [];
  const dirMtimes = new Map();
  const exclude = getExcludeDirs();
  function scan(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && exclude.has(entry.name)) continue; // 排除 @eaDir 等
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (IMG_EXT_RE.test(entry.name)) {
        try {
          const st = fs.statSync(full);
          images.push({
            name: entry.name,
            path: full,
            url: `/api/media?file=${encodeURIComponent(full)}`,
            size: formatSize(st.size),
            modified: st.mtime.toISOString(),
          });
        } catch (_) { /* skip */ }
      }
    }
    dirMtimes.set(d, statMtime(d));
  }
  scan(dir);
  return { images, dirMtimes };
}

// 探针：stat 所有已知目录（不 readdir），全同 → 缓存仍有效
function scanCacheStillValid(cached) {
  if (statMtime(cached.searchPath) === -1) return false;
  for (const [dir, m] of cached.dirMtimes) {
    if (statMtime(dir) !== m) return false;
  }
  return true;
}

// ============================================================
// API 路由处理函数（业务逻辑与原版完全一致）
// ============================================================

// GET /api/auth/status
function apiAuthStatus(req, res) {
  const cfg = loadConfig();
  jsonRes(res, 200, {
    passwordSet: !!(cfg.passwordHash && cfg.passwordSalt),
    authed: isAuthed(req),
    sessionHours: SESSION_HOURS,
  });
}

// POST /api/auth/login
async function apiAuthLogin(req, res) {
  const body = await readJsonBody(req);
  const cfg = loadConfig();
  if (!cfg.passwordHash || !cfg.passwordSalt) {
    return jsonRes(res, 400, { error: 'no_password_set' });
  }
  const ok = auth.verifyPassword(String(body.password || ''), cfg.passwordHash, cfg.passwordSalt);
  if (!ok) return jsonRes(res, 401, { error: 'wrong_password' });
  const token = auth.createSession(SESSION_HOURS);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`,
  });
  res.end(JSON.stringify({ ok: true, authed: true }));
}

// POST /api/auth/logout
async function apiAuthLogout(req, res) {
  auth.destroySession(auth.extractToken(req));
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0',
  });
  res.end(JSON.stringify({ ok: true }));
}

// GET /api/directories
function apiDirectories(query, res) {
  const root = queryRoot(query);
  try {
    const exclude = getExcludeDirs();
    const items = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && !exclude.has(d.name))
      .map(d => d.name)
      .sort();
    jsonRes(res, 200, { root, items });
  } catch (e) {
    jsonRes(res, 500, { error: e.message });
  }
}

// GET /api/images?root=&path=&recursive=false
function apiImages(query, res) {
  const root = queryRoot(query);
  const relativePath = query.path || '';
  const recursive = query.recursive === 'true';
  const searchPath = path.join(root, relativePath);

  try {
    if (!fs.existsSync(searchPath)) {
      return jsonRes(res, 200, { path: searchPath, count: 0, images: [] });
    }

    let files = [];

    if (recursive) {
      // 后端扫描缓存懒刷新：探针节流（noCache 参数强制跳过缓存，用于上传后立即刷新）
      const noCache = query.noCache === 'true';
      const now = Date.now();
      const cached = IMAGE_SCAN_CACHE.get(searchPath);
      if (noCache || !cached || now - cached.probedAt >= IMAGE_PROBE_INTERVAL) {
        // 缓存过期或强制刷新 → 重新扫描
        const sc = (noCache || !cached || !scanCacheStillValid(cached))
          ? recursiveScanAll(searchPath)
          : { images: cached.images, dirMtimes: cached.dirMtimes };
        files = sc.images;
        IMAGE_SCAN_CACHE.set(searchPath, { searchPath, images: files, dirMtimes: sc.dirMtimes, ts: now, probedAt: now });
      } else {
        files = cached.images;
        cached.probedAt = now;
      }
    } else {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const d of entries) {
        if (/\.(jpg|jpeg|png|webp|gif)$/i.test(d.name)) {
          try {
            const fullPath = path.join(searchPath, d.name);
            const stat = fs.statSync(fullPath);
            files.push({
              name: d.name,
              path: fullPath,
              url: `/api/media?file=${encodeURIComponent(fullPath)}`,
              size: formatSize(stat.size),
              modified: stat.mtime.toISOString(),
            });
          } catch (e) { /* skip */ }
        }
      }
    }

    jsonRes(res, 200, {
      path: searchPath,
      root,
      recursive,
      count: files.length,
      images: files,
    });
  } catch (e) {
    jsonRes(res, 500, { error: e.message, images: [] });
  }
}

// GET /api/dir?root=&path= - 按需加载单层目录内容
// 用户原话「网页每次刷新都要重新请求也不好」「切换目录秒响应图片晚点加载都没事」
// 思路：不再前端全量递归拉；访问哪个目录就返回哪层，从递归缓存秒取，无缓存则单层扫
function apiDir(query, res) {
  const root = queryRoot(query);
  const relativePath = query.path || '';
  const searchPath = path.join(root, relativePath);

  try {
    if (!fs.existsSync(searchPath)) {
      return jsonRes(res, 200, { root, path: relativePath, subdirs: [], images: [], sig: 0 });
    }

    const dirMtime = statMtime(searchPath);
    const prefix = relativePath ? relativePath + '/' : '';

    // 优先从递归扫描缓存取（秒级，无需再扫）
    const cached = IMAGE_SCAN_CACHE.get(root);
    if (cached && scanCacheStillValid(cached)) {
      cached.probedAt = Date.now();
      const subdirs = [];
      const images = [];
      const seen = new Set();
      for (const im of cached.images) {
        if (!im.path.startsWith(root + '/')) continue;
        const rel = im.path.slice(root.length + 1);
        const slash = rel.lastIndexOf('/');
        const dir = slash > 0 ? rel.slice(0, slash) : '';
        if (dir === relativePath) {
          images.push(im);
          continue;
        }
        if (relativePath) {
          if (dir.startsWith(prefix)) {
            const rest = dir.slice(prefix.length);
            const seg = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
            if (seg && !seen.has(seg)) {
              seen.add(seg);
              const subRel = prefix + seg;
              subdirs.push({ name: seg, relPath: subRel, root, sig: statMtime(path.join(root, subRel)) });
            }
          }
        } else {
          if (dir) {
            const seg = dir.includes('/') ? dir.slice(0, dir.indexOf('/')) : dir;
            if (seg && !seen.has(seg)) {
              seen.add(seg);
              subdirs.push({ name: seg, relPath: seg, root, sig: statMtime(path.join(root, seg)) });
            }
          }
        }
      }
      // 统计每个子文件夹的图片数 + mtime + hasSub + 叶子目录直图
      for (const sd of subdirs) {
        let count = 0, maxMtime = 0, hasSub = false;
        const leafImgs = [];
        const sdPrefix = sd.relPath + '/';
        for (const im of cached.images) {
          if (!im.path.startsWith(root + '/')) continue;
          const rel = im.path.slice(root.length + 1);
          const slash = rel.lastIndexOf('/');
          const dir = slash > 0 ? rel.slice(0, slash) : '';
          if (dir === sd.relPath || dir.startsWith(sdPrefix)) {
            count++;
            const mt = im.modified ? new Date(im.modified).getTime() : 0;
            if (mt > maxMtime) maxMtime = mt;
            if (dir === sd.relPath) leafImgs.push(im);
          }
          if (dir.startsWith(sdPrefix)) hasSub = true;
        }
        sd.count = count;
        sd.mtime = maxMtime;
        sd.hasSub = hasSub;
        if (!hasSub) sd.leafImages = leafImgs;
      }
      return jsonRes(res, 200, { root, path: relativePath, subdirs, images, sig: dirMtime });
    }

    // 无递归缓存：单层扫描
    const subdirs = [];
    const images = [];
    const seen = new Set();
    const exclude = getExcludeDirs();
    let entries;
    try { entries = fs.readdirSync(searchPath, { withFileTypes: true }); } catch (_) { entries = []; }
    for (const e of entries) {
      const full = path.join(searchPath, e.name);
      if (e.isDirectory() && exclude.has(e.name)) continue; // 排除 @eaDir 等
      if (e.isDirectory()) {
        const rel = relativePath ? relativePath + '/' + e.name : e.name;
        subdirs.push({ name: e.name, relPath: rel, root, sig: statMtime(full) });
      } else if (IMG_EXT_RE.test(e.name)) {
        try {
          const st = fs.statSync(full);
          images.push({
            name: e.name, path: full,
            url: `/api/media?file=${encodeURIComponent(full)}`,
            size: formatSize(st.size), modified: st.mtime.toISOString(),
          });
        } catch (_) {}
      }
    }
    for (const sd of subdirs) { sd.count = -1; sd.mtime = 0; sd.hasSub = true; }
    jsonRes(res, 200, { root, path: relativePath, subdirs, images, sig: dirMtime });
  } catch (e) {
    jsonRes(res, 500, { error: e.message, subdirs: [], images: [] });
  }
}

// GET /api/media?file= - 按路径输出图片（替代 express res.sendFile）
function apiMedia(query, res) {
  const filePath = query.file ? decodeURIComponent(query.file) : '';
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  streamFile(res, filePath);
}

// GET /api/zip/scan?dir= - 目录下压缩包及内图片列表
function apiZipScan(query, res) {
  const dir = query.dir || '';
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return jsonRes(res, 400, { ok: false, error: '目录无效' });
  }
  const zips = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !ZIP_EXT_RE.test(e.name)) continue;
    const zp = path.join(dir, e.name);
    zips.push({ path: zp, name: e.name, images: listArchiveImages(zp) });
  }
  jsonRes(res, 200, { ok: true, zips });
}

// GET /api/zip/img?path=&file= - 压缩包内图片
function apiZipImg(query, res) {
  const zp = query.path || '';
  const file = query.file || '';
  if (!zp || !fs.existsSync(zp) || !file || file.includes('..')) {
    res.writeHead(400); res.end('bad request'); return;
  }
  streamArchiveImage(res, zp, file);
}

// GET /api/gif?dir=&dur_ms= - 目录序列帧 → GIF
function apiGif(query, res) {
  const dir = query.dir || '';
  const abs = dir ? path.resolve(dir) : '';
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return jsonRes(res, 400, { ok: false, error: '目录无效' });
  }
  const durMs = parseInt(query.dur_ms || '0', 10);
  gifFromDir(abs, durMs, res);
}

// GET /api/zip/gif?path=&dur_ms= - 压缩包内序列帧 → GIF
function apiZipGif(query, res) {
  const zp = query.path || '';
  if (!zp || !fs.existsSync(zp)) {
    return jsonRes(res, 400, { ok: false, error: '压缩包无效' });
  }
  const durMs = parseInt(query.dur_ms || '0', 10);
  gifFromZip(zp, durMs, res);
}

// POST /api/upload - 上传单张图片（手写 multipart 解析替代 multer）
// 权限（用户原话「不登录只能上传到预设分类游客，项目本地实际存储；其他目录登录之后可以上传」）：
//   · 无 targetDir 参数 → 游客/本地：写入项目 uploads/ 目录
//   · 带 targetDir 参数（登录后上传到指定真实目录）→ 需登录 + 目录必须存在
async function apiUpload(req, res) {
  try {
    const query = parseQuery(req.url);
    const targetDir = query.targetDir ? decodeURIComponent(query.targetDir) : "";
    // 带 targetDir = 登录用户上传到真实目录
    if (targetDir) {
      if (!checkAuth(req)) return jsonRes(res, 401, { error: 'unauthorized', needsLogin: true });
      if (!targetDir.startsWith('/') || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return jsonRes(res, 400, { error: '目录无效' });
      }
    }
    const { filename, data, size } = await readMultipartUpload(req);
    if (!filename || !data) {
      return jsonRes(res, 400, { error: 'No file' });
    }
    const savedName = Date.now() + '-' + filename;
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
    // 游客/本地：写入项目 uploads/ 目录
    fs.writeFileSync(path.join(UPLOAD, savedName), data);
    jsonRes(res, 200, {
      id:    savedName,
      url:   `/uploads/${savedName}`,
      name:  filename,
      size:  formatSize(size),
    });
  } catch (e) {
    jsonRes(res, 500, { error: 'Upload failed: ' + (e.message || String(e)) });
  }
}

// GET /api/gallery - 获取画廊配置（不含密码哈希）
function apiGetGallery(res) {
  jsonRes(res, 200, publicConfig(loadConfig()));
}

// POST /api/gallery - 保存画廊配置（需登录）
async function apiPostGallery(req, res) {
  if (!checkAuth(req)) return jsonRes(res, 401, { error: 'unauthorized', needsLogin: true });
  const body = await readJsonBody(req);
  const cfg = loadConfig();
  const { title, favicon, categories, directories } = body;
  if (title !== undefined) cfg.title = title;
  if (favicon !== undefined) cfg.favicon = favicon;
  if (Array.isArray(categories)) cfg.categories = categories;
  if (Array.isArray(directories)) cfg.directories = directories;
  saveConfig(cfg);
  jsonRes(res, 200, { ok: true, ...publicConfig(cfg) });
}

// ─── 收藏功能（用户原话「增加收藏功能🩷，预设个不可删改的收藏分类，点了收藏的图片都会在里面平铺；登录用户可点收藏，游客可以看」）───
const FAV_FILE = path.join(__dirname, 'favorites.json');
function loadFavorites() {
  try {
    const raw = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
}
function saveFavorites(arr) {
  fs.writeFileSync(FAV_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

// GET /api/uploaded — 列出项目本地 uploads/ 目录的图片（游客上传，重启后仍可见）
function apiUploaded(res) {
  try {
    if (!fs.existsSync(UPLOAD)) return jsonRes(res, 200, []);
    const names = fs.readdirSync(UPLOAD)
      .filter(n => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n))
      .sort();
    const items = names.map(n => ({
      id: n,
      src: '/uploads/' + encodeURIComponent(n),
      url: '/uploads/' + encodeURIComponent(n),
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

// GET /api/favorites — 游客可看（开放）
function apiGetFavorites(res) {
  jsonRes(res, 200, loadFavorites());
}

// POST /api/favorites — 添加收藏（需登录）
async function apiPostFavorite(req, res) {
  if (!checkAuth(req)) return jsonRes(res, 401, { error: 'unauthorized', needsLogin: true });
  const body = await readJsonBody(req);
  const { src, name, title, cat, dir, size, root } = body;
  if (!src) return jsonRes(res, 400, { error: 'src required' });
  const favs = loadFavorites();
  if (favs.find(f => f.src === src)) return jsonRes(res, 200, { ok: true, alreadyExists: true, favorites: favs });
  favs.push({ src, name, title, cat, dir, size, root, addedAt: Date.now() });
  saveFavorites(favs);
  jsonRes(res, 200, { ok: true, favorites: favs });
}

// DELETE /api/favorites — 移除收藏（需登录）
async function apiDeleteFavorite(req, res) {
  if (!checkAuth(req)) return jsonRes(res, 401, { error: 'unauthorized', needsLogin: true });
  const body = await readJsonBody(req);
  const { src } = body || {};
  if (!src) return jsonRes(res, 400, { error: 'src required' });
  let favs = loadFavorites();
  favs = favs.filter(f => f.src !== src);
  saveFavorites(favs);
  jsonRes(res, 200, { ok: true, favorites: favs });
}

// ============================================================
// Helpers
// ============================================================
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

// ============ 压缩包预览 / GIF 合成（搬运自 gbmd-gallery，逻辑不变）============
// 序列帧判定：文件 ≥3、文件名「前缀+固定宽度数字+扩展名」、前缀相同、数字连续递增
function detectFramesFromDir(files) {
  if (!files || files.length < 3) return null;
  const groups = new Map();
  for (const f of files) {
    const m = String(f).match(/^(.*?)(\d+)(\.\w+)$/);
    if (!m) continue;
    const key = m[1];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ n: parseInt(m[2], 10), ext: m[3], file: f });
  }
  let best = null;
  for (const arr of groups.values()) {
    if (arr.length < 3) continue;
    const sorted = arr.slice().sort((a, b) => a.n - b.n);
    let run = [sorted[0]], bestRun = run;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].n === sorted[i - 1].n + 1) run.push(sorted[i]);
      else { if (run.length > bestRun.length) bestRun = run; run = [sorted[i]]; }
    }
    if (run.length > bestRun.length) bestRun = run;
    if (bestRun.length >= 3 && (!best || bestRun.length > best.frames.length)) {
      best = { frames: bestRun };
    }
  }
  return best;
}

// ============================================================
// GBK 解码（压缩包中文条目名）
// 问题：SA6400 群晖 Node 套件不支持 TextDecoder("gbk")（The "gbk" encoding is not supported）
//   → 代码回退 rawName.toString("utf8") 产生乱码（如 ���ҡ��ĵ���）
// 方案：TextDecoder("gbk") 可用直接用；不可用则用 python3 批量 GBK 解码兜底（零依赖）
// ============================================================
let _GBK_DECODER_OK = null;
function gbkDecoderAvailable() {
  if (_GBK_DECODER_OK === null) {
    try { new TextDecoder("gbk"); _GBK_DECODER_OK = true; }
    catch (_) { _GBK_DECODER_OK = false; }
  }
  return _GBK_DECODER_OK;
}

// 批量 GBK 解码：pending = [{ idx, raw: Buffer }] → Map(idx → string)
function decodeGbkBatch(pending) {
  const out = new Map();
  const todo = [];
  for (const it of pending) {
    if (gbkDecoderAvailable()) {
      out.set(it.idx, new TextDecoder("gbk").decode(it.raw));
    } else {
      todo.push({ i: it.idx, h: it.raw.toString("hex") });
    }
  }
  if (!todo.length) return out;
  try {
    const script =
      "import sys,json\n" +
      "d=json.load(sys.stdin)\n" +
      "o={}\n" +
      "for it in d:\n" +
      "    b=bytes.fromhex(it['h'])\n" +
      "    try: s=b.decode('gbk')\n" +
      "    except Exception: s=b.decode('utf-8', errors='replace')\n" +
      "    o[str(it['i'])]=s\n" +
      "print(json.dumps(o, ensure_ascii=False))";
    const res = execFileSync("python3", ["-c", script], {
      input: JSON.stringify(todo), encoding: "utf8", timeout: 15000,
    });
    const obj = JSON.parse(res.trim());
    for (const [k, v] of Object.entries(obj)) out.set(parseInt(k, 10), v);
  } catch (_) {
    for (const it of todo) out.set(it.idx, it.raw.toString("utf8"));
  }
  return out;
}

// 单块 Buffer GBK 解码（7z/rar 输出行）
function decodeGbkBuffer(buf) {
  if (gbkDecoderAvailable()) return new TextDecoder("gbk").decode(buf);
  try {
    const script =
      "import sys\n" +
      "b=bytes.fromhex(sys.argv[1])\n" +
      "try: print(b.decode('gbk'))\n" +
      "except Exception: print(b.decode('utf-8', errors='replace'))";
    const res = execFileSync("python3", ["-c", script, buf.toString("hex")], { encoding: "utf8", timeout: 10000 });
    return res.trim();
  } catch (_) { return buf.toString("utf8"); }
}

// zip 条目解析（流式读尾部 EOCD + 中央目录，UTF-8 严格失败 → GBK 批量回退）
function listZipEntriesNode(zipPath) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65536);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return [];
    const eocdAbs = size - tailLen + eocd;
    const count = tail.readUInt16LE(eocd + 10);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (count === 0 || cdOff < 0 || cdOff >= eocdAbs) return [];
    const cdLen = eocdAbs - cdOff;
    const cd = Buffer.alloc(cdLen);
    fs.readSync(fd, cd, 0, cdLen, cdOff);
    const entries = [];
    const pending = [];   // UTF-8 严格解码失败的条目，稍后批量 GBK 解码
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const extAttr = cd.readUInt32LE(p + 38);
      const rawName = cd.slice(p + 46, p + 46 + nameLen);
      let name = null;
      try { name = new TextDecoder("utf-8", { fatal: true }).decode(rawName); }
      catch (_) { pending.push({ idx: n, raw: rawName }); }
      const isDir = ((extAttr >>> 16) & 0x4000) !== 0 || /\/$/.test(name || "");
      entries.push({ name: name || "", method, compSize, uncompSize, localOff, isDir });
      p += 46 + nameLen + extraLen + commLen;
    }
    if (pending.length) {
      const decoded = decodeGbkBatch(pending);
      for (const it of pending) {
        const d = decoded.get(it.idx);
        if (d) { entries[it.idx].name = d; entries[it.idx].isDir = entries[it.idx].isDir || /\/$/.test(d); }
      }
    }
    return entries;
  } finally { fs.closeSync(fd); }
}

// zip 条目数据按需读取（只读 local header + 压缩数据段）
function readZipEntryData(zipPath, entry) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.localOff);
    if (head.readUInt32LE(0) !== 0x04034b50) return null;
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.localOff + 30 + nameLen + extraLen;
    const comp = Buffer.alloc(entry.compSize);
    fs.readSync(fd, comp, 0, entry.compSize, dataStart);
    if (entry.method === 0) return comp;
    if (entry.method === 8) return zlib.inflateRawSync(comp);
    return null;
  } finally { fs.closeSync(fd); }
}

// 压缩包内图片条目列表：zip 零依赖；7z/rar 用 7z l
function listArchiveImages(archivePath) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === ".zip") {
    try {
      return listZipEntriesNode(archivePath)
        .filter((e) => !e.isDir && IMG_EXT_RE.test(e.name) && !/^\.\.\//.test(e.name))
        .map((e) => ({ name: e.name, size: e.uncompSize }));
    } catch (_) { return []; }
  }
  try {
    // 7z 输出可能是 GBK 字节（SA6400 群晖 Node 无 TextDecoder("gbk")）→ buffer 按行解码
    const outBuf = execFileSync(SEVEN_ZIP, ["l", archivePath], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
    const lines = [];
    let start = 0;
    for (let i = 0; i < outBuf.length; i++) {
      if (outBuf[i] === 0x0a) { lines.push(outBuf.slice(start, i)); start = i + 1; }
    }
    if (start < outBuf.length) lines.push(outBuf.slice(start));
    let text = "";
    for (const lb of lines) {
      let line;
      try { line = new TextDecoder("utf-8", { fatal: true }).decode(lb); }
      catch (_) { line = decodeGbkBuffer(lb); }
      text += line + "\n";
    }
    const imgs = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*[\d\-:]+\s+[\d\-:]+\s+([\.DA]+)\s+(\d+)\s+\d+\s+(.+)$/);
      if (m && !m[1].includes("D") && !m[3].includes("?") && IMG_EXT_RE.test(m[3].trim())) imgs.push({ name: m[3].trim(), size: parseInt(m[2], 10) });
    }
    return imgs;
  } catch (_) { return []; }
}

// 流式输出压缩包内图片（适配原始 http res 对象）
function streamArchiveImage(res, archivePath, entryName) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === ".zip") {
    const e = (listZipEntriesNode(archivePath) || []).find((x) => x.name === entryName && !x.isDir);
    if (!e) { res.writeHead(404); res.end("not found"); return; }
    const data = readZipEntryData(archivePath, e);
    if (!data) { res.writeHead(500); res.end("read failed"); return; }
    const fext = path.extname(e.name).toLowerCase();
    const ctype = fext === ".png" ? "image/png" : fext === ".gif" ? "image/gif" : fext === ".webp" ? "image/webp" : "image/jpeg";
    res.writeHead(200, { "Content-Type": ctype, "Cache-Control": "no-cache" });
    res.end(data);
    return;
  }
  try {
    const buf = execFileSync(SEVEN_ZIP, ["e", "-so", archivePath, entryName], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
    const ctype = /\.png$/i.test(entryName) ? "image/png" : /\.gif$/i.test(entryName) ? "image/gif" : /\.webp$/i.test(entryName) ? "image/webp" : "image/jpeg";
    res.writeHead(200, { "Content-Type": ctype, "Cache-Control": "no-cache" });
    res.end(buf);
  } catch (e) { res.writeHead(500); res.end("extract failed"); }
}

// 目录序列帧 → 合成 GIF（缓存 cache-gifs/<hash>.gif）并流式返回
function gifFromDir(absDir, durMs, res) {
  let files = [];
  try { files = fs.readdirSync(absDir).filter((f) => IMG_EXT_RE.test(f)); } catch (_) { files = []; }
  const det = detectFramesFromDir(files);
  if (!det) { jsonRes(res, 400, { ok: false, error: "非序列帧目录", frames: 0 }); return; }
  try { fs.mkdirSync(CACHE_GIF_DIR, { recursive: true }); } catch (_) {}
  const frameMs = (Number.isFinite(durMs) && durMs > 0) ? durMs : Math.round(2000 / Math.max(1, det.frames.length));
  let mtime = 0;
  try { mtime = fs.statSync(absDir).mtimeMs; } catch (_) {}
  const hash = crypto.createHash("sha1").update(absDir + "|" + det.frames.map((f) => f.file).join(",") + "|" + mtime + "|" + frameMs).digest("hex").slice(0, 16);
  const gifFile = path.join(CACHE_GIF_DIR, hash + ".gif");
  if (!fs.existsSync(gifFile)) {
    const f0 = det.frames[0];
    const frameTmp = path.join(CACHE_GIF_DIR, hash + "-f");
    try { fs.mkdirSync(frameTmp, { recursive: true }); } catch (_) {}
    det.frames.forEach((f, i) => { try { fs.copyFileSync(path.join(absDir, f.file), path.join(frameTmp, "frame_" + String(i).padStart(3, "0") + f.ext)); } catch (_) {} });
    const pattern = path.join(frameTmp, "frame_%03d" + f0.ext);
    const ffArgs = [
      "-y", "-framerate", String(1000 / frameMs), "-start_number", "0",
      "-i", pattern,
      "-vf", "scale=w='if(gt(iw,480),480,iw)':h=-1",
      "-loop", "0", gifFile,
    ];
    const sysFfmpeg = fs.existsSync("/usr/bin/ffmpeg") && FFMPEG !== "/usr/bin/ffmpeg" ? "/usr/bin/ffmpeg" : "";
    try {
      execFileSync(FFMPEG, ffArgs, { timeout: 30000, env: FFMPEG_LIB ? Object.assign({}, process.env, { LD_LIBRARY_PATH: FFMPEG_LIB }) : undefined });
    } catch (e) {
      if (sysFfmpeg) { try { execFileSync(sysFfmpeg, ffArgs, { timeout: 30000 }); } catch (e2) { try { fs.rmSync(gifFile, { force: true }); } catch (_) {} jsonRes(res, 500, { ok: false, error: "GIF 合成失败" }); return; } }
      else { try { fs.rmSync(gifFile, { force: true }); } catch (_) {} jsonRes(res, 500, { ok: false, error: "GIF 合成失败" }); return; }
    }
    try { fs.rmSync(frameTmp, { recursive: true, force: true }); } catch (_) {}
  }
  res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-cache" });
  fs.createReadStream(gifFile).pipe(res);
}

// 压缩包内序列帧 → 合成 GIF
function gifFromZip(zipPath, durMs, res) {
  const images = listArchiveImages(zipPath);
  const det = detectFramesFromDir(images.map((i) => i.name));
  if (!det) { jsonRes(res, 400, { ok: false, error: "压缩包内非序列帧" }); return; }
  const frameMs = (Number.isFinite(durMs) && durMs > 0) ? durMs : Math.round(2000 / Math.max(1, det.frames.length));
  try { fs.mkdirSync(CACHE_GIF_DIR, { recursive: true }); } catch (_) {}
  let zmtime = 0;
  try { zmtime = fs.statSync(zipPath).mtimeMs; } catch (_) {}
  const zhash = crypto.createHash("sha1").update(zipPath + "|" + det.frames.map((f) => f.file).join(",") + "|" + zmtime + "|" + frameMs).digest("hex").slice(0, 16);
  const gifFile = path.join(CACHE_GIF_DIR, zhash + ".gif");
  if (!fs.existsSync(gifFile)) {
    const tmpDir = path.join(CACHE_GIF_DIR, zhash + "-f");
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    try {
      const zipExt = path.extname(zipPath).toLowerCase() === ".zip";
      const entries = zipExt ? (listZipEntriesNode(zipPath) || []) : [];
      det.frames.forEach((f, i) => {
        const out = path.join(tmpDir, "frame_" + String(i).padStart(3, "0") + f.ext);
        if (zipExt) {
          const e = entries.find((x) => x.name === f.file);
          if (!e) return;
          const data = readZipEntryData(zipPath, e);
          if (data) fs.writeFileSync(out, data);
        } else {
          try {
            const buf = execFileSync(SEVEN_ZIP, ["e", "-so", zipPath, f.file], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
            fs.writeFileSync(out, buf);
          } catch (_) {}
        }
      });
      const f0 = det.frames[0];
      const pattern = path.join(tmpDir, "frame_%03d" + f0.ext);
      const ffArgs = [
        "-y", "-framerate", String(1000 / frameMs), "-start_number", "0",
        "-i", pattern,
        "-vf", "scale=w='if(gt(iw,480),480,iw)':h=-1",
        "-loop", "0", gifFile,
      ];
      const sysFfmpeg = fs.existsSync("/usr/bin/ffmpeg") && FFMPEG !== "/usr/bin/ffmpeg" ? "/usr/bin/ffmpeg" : "";
      const runFfmpeg = (bin, opts) => execFileSync(bin, ffArgs, opts);
      try {
        runFfmpeg(FFMPEG, { timeout: 30000, env: FFMPEG_LIB ? Object.assign({}, process.env, { LD_LIBRARY_PATH: FFMPEG_LIB }) : undefined });
      } catch (e) {
        if (sysFfmpeg) runFfmpeg(sysFfmpeg, { timeout: 30000 });
        else throw e;
      }
    } catch (e) {
      try { fs.rmSync(gifFile, { force: true }); } catch (_) {}
      jsonRes(res, 500, { ok: false, error: "zip GIF 合成失败: " + (e.message || String(e)) });
      return;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
  res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-cache" });
  fs.createReadStream(gifFile).pipe(res);
}

// ============================================================
// 主路由器（替代 express 路由注册）
// ============================================================
const server = http.createServer(async (req, res) => {
  const rawUrl    = req.url;
  const qi        = rawUrl.indexOf('?');
  const pathname  = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
  const query     = parseQuery(rawUrl);
  const method    = req.method;

  try {
    // ─── 静态文件（非 /api/ 路径）───
    if (!pathname.startsWith('/api/')) {
      return serveStatic(res, pathname);
    }

    // ─── GET 路由 ───
    if (method === 'GET') {
      switch (pathname) {
        case '/api/auth/status':   return apiAuthStatus(req, res);
        case '/api/directories':   return apiDirectories(query, res);
        case '/api/images':       return apiImages(query, res);
        case '/api/dir':          return apiDir(query, res);
        case '/api/media':        return apiMedia(query, res);
        case '/api/zip/scan':     return apiZipScan(query, res);
        case '/api/zip/img':      return apiZipImg(query, res);
        case '/api/gif':          return apiGif(query, res);
        case '/api/zip/gif':      return apiZipGif(query, res);
        case '/api/gallery':      return apiGetGallery(res);
        case '/api/favorites':    return apiGetFavorites(res);
        case '/api/uploaded':     return apiUploaded(res);
      }
    }

    // ─── POST 路由 ───
    if (method === 'POST') {
      switch (pathname) {
        case '/api/auth/login':   return apiAuthLogin(req, res);
        case '/api/auth/logout':  return apiAuthLogout(req, res);
        case '/api/upload':       return apiUpload(req, res);
        case '/api/gallery':      return apiPostGallery(req, res);
        case '/api/favorites':    return apiPostFavorite(req, res);
      }
    }

    // ─── DELETE 路由 ───
    if (method === 'DELETE') {
      if (pathname === '/api/favorites') return apiDeleteFavorite(req, res);
    }

    // ─── OPTIONS（预检，同源不需要 CORS 但保险起见）───
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ─── 404 ───
    jsonRes(res, 404, { error: 'not found', path: pathname });
  } catch (e) {
    jsonRes(res, 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`🎮 Gallery running at http://localhost:${PORT}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Use PORT=xxxx env or stop existing process.`);
    process.exit(1);
  }
  console.error('Server error:', e);
});
