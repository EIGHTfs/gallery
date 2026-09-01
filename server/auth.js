// ============================================================
// 拾光集 - 鉴权（零依赖，参照 gbmd-v3 auth.js）
// 密码 scrypt 哈希存储；登录成功签发随机 session token
// 存内存 Map + HttpOnly Cookie；持久化 session 到磁盘（重启免登录）
// ============================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SESSION_FILE = path.join(__dirname, "..", "sessions.json");
const sessions = new Map(); // token -> { expiresAt }

function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      const now = Date.now();
      for (const [token, s] of Object.entries(data)) {
        if (s.expiresAt > now) sessions.set(token, { expiresAt: s.expiresAt });
      }
    }
  } catch (_) {}
}

function saveSessions() {
  const data = {};
  for (const [token, s] of sessions) data[token] = { expiresAt: s.expiresAt };
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data), "utf8");
  } catch (_) {}
}

function createSession(hours) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + (hours || 72) * 3600 * 1000;
  sessions.set(token, { expiresAt });
  saveSessions();
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    saveSessions();
    return false;
  }
  return true;
}

function destroySession(token) {
  if (token) sessions.delete(token);
  saveSessions();
}

function extractToken(req) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1] : null;
}

// 密码 scrypt 哈希：hex 编码 {hash, salt}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const test = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(test, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  loadSessions,
  createSession,
  isValidSession,
  destroySession,
  extractToken,
  hashPassword,
  verifyPassword,
};
