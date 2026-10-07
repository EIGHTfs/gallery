// 鉴权框架（通用）
// 密码 scrypt 哈希存储；登录成功签发随机 session token
// 存内存 Map + HttpOnly Cookie；可选持久化到磁盘。
"use strict";

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

let SESSION_FILE = null;
let COOKIE_NAME = "token";   // 会话 cookie 名（init 可覆盖）
// ⚠️ 多项目同 host 部署时必须各用各的名字：Cookie 按 host 隔离但【不区分端口】，
//    两个服务都用 "session" 时会互相覆盖，表现为「刚登录就掉线、记住设备形同虚设」。
let FALLBACK_HOURS = 72;     // setSessionCookie 未显式传 hours 时的兜底（init 可覆盖）
let cleanupTimer = null;
const sessions = new Map(); // token -> { expiresAt, hours, deviceId }

/**
 * 初始化鉴权模块。
 * @param {object} opts
 * @param {string} [opts.sessionFile] 持久化文件路径（不传则纯内存）
 * @param {string} [opts.cookieName]  会话 cookie 名（默认 token）
 */
function init(opts = {}) {
  SESSION_FILE = opts.sessionFile || null;
  if (opts.cookieName) COOKIE_NAME = opts.cookieName;
  if (opts.fallbackHours) FALLBACK_HOURS = opts.fallbackHours;
  if (!SESSION_FILE) return;
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    for (const [token, info] of Object.entries(data)) {
      if (info.expiresAt > Date.now()) sessions.set(token, info);
    }
  } catch (_) { /* 文件不存在或损坏，从空会话开始 */ }
}

function persist() {
  if (!SESSION_FILE) return;
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    // 内存会话仍可用，但重启后会丢失——必须留痕，否则表现为「无缘无故要求重新登录」
    console.error("[auth] 会话写入失败，重启后将丢失登录态:", e && e.message || e);
  }
}

function createSession(opts = {}) {
  const hours = opts.hours || 72;
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    expiresAt: Date.now() + hours * 3600 * 1000,
    hours,
    deviceId: opts.deviceId || null,
  });
  persist();
  return { token, hours };
}

function isValidSession(token) {
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    persist();
    return false;
  }
  return true;
}

function destroySession(token) {
  sessions.delete(token);
  persist();
}

function extractToken(req) {
  const cookie = req.headers.cookie || "";
  const re = new RegExp("(?:^|;\\s*)" + COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]+)");
  const match = cookie.match(re);
  if (match) return match[1];
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

/** 定时清理过期会话（unref 不阻止进程退出）；intervalMs 默认 1 小时 */
function startCleanup(intervalMs) {
  if (cleanupTimer) clearInterval(cleanupTimer);
  const ms = intervalMs || 3600 * 1000;
  cleanupTimer = setInterval(() => { pruneExpired(); }, ms);
  if (cleanupTimer.unref) cleanupTimer.unref();
  return cleanupTimer;
}

function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** 会话 cookie 名（当前生效值） */
function cookieName() {
  return COOKIE_NAME;
}

function pruneExpired() {
  let count = 0;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= Date.now()) { sessions.delete(token); count++; }
  }
  if (count) persist();
  return count;
}

function loadSessions() {
  return sessions.size;
}

/**
 * 写会话 cookie。Max-Age 与 session 有效期保持一致，避免出现
 * 「服务端会话还在、cookie 已过期」或反之的错位。
 * @param {object} res    http 响应对象
 * @param {string} token  会话 token
 * @param {number} [hours] 有效期（小时）；不传时用 opts.fallbackHours 或默认 72
 */
function setSessionCookie(res, token, hours) {
  const h = hours != null ? hours : (FALLBACK_HOURS || 72);
  const maxAge = h * 3600;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
}

/** 清会话 cookie（登出用） */
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  init, createSession, isValidSession, destroySession, extractToken,
  pruneExpired, loadSessions, startCleanup, stopCleanup, cookieName,
  setSessionCookie, clearSessionCookie,
};
