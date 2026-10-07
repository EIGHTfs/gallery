// 日志工具：console 重定向加时间戳
"use strict";

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
    + " " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
}

function install(opts) {
  if (opts && Array.isArray(opts.quietApis)) addQuietApis(opts.quietApis);
  if (console._appLogInstalled) return;
  console._appLogInstalled = true;
  function wrap(fn) {
    return function () {
      const args = Array.prototype.slice.call(arguments);
      if (args.length && typeof args[0] === "string") args[0] = "[" + stamp() + "] " + args[0];
      else args.unshift("[" + stamp() + "]");
      return fn.apply(console, args);
    };
  }
  console.log = wrap(console.log);
  console.warn = wrap(console.warn);
  console.error = wrap(console.error);
}

// API 访问日志过滤：高频轮询端点不打日志（避免刷屏），其余 /api/* 记一行。
// 轮询端点可通过 install({ quietApis: [...] }) 增补（各项目特有端点用这个加）。
const DEFAULT_QUIET_APIS = [
  "/api/task",
  "/api/clock",
  "/api/login-status",
  "/api/gb-login-status",
];
let _quietApis = DEFAULT_QUIET_APIS.slice();

/**
 * 增补静默端点（项目特有高频轮询路径用）。
 * @param {string[]} apis 端点路径数组，如 ["/api/thumb"]
 */
function addQuietApis(apis) {
  for (const p of apis || []) {
    if (typeof p === "string" && p && _quietApis.indexOf(p) < 0) _quietApis.push(p);
  }
  return _quietApis.slice();
}

function shouldLogApi(method, pathname) {
  if (!pathname || pathname.indexOf("/api/") !== 0) return false;
  if (method === "GET" && _quietApis.indexOf(pathname) >= 0) return false;
  return true;
}

function apiLine(method, pathname) {
  console.log("[api] " + method + " " + pathname);
}

module.exports = { install, stamp, shouldLogApi, apiLine, addQuietApis, DEFAULT_QUIET_APIS };
