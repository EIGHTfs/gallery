// ============================================================
// 路由适配器（框架层 · 通用）：闭包式 register(api) ↔ 表式 createRoute
//
// 背景：框架的通用路由件（routes-auth.js、routes-auto-update.js）写成了闭包式
//   `module.exports = function register(api) { api.route("GET","/api/x",fn) ... }`，
//   这是为 iwara 的 route-registry 设计的。而 gbmd / gallery 走 createRoute 表式，
//   于是各自手抄了一份同逻辑的表式版本 —— 正是通用件注释里吐槽的「逻辑漂移」来源。
//
// 本适配器让表式项目也能直接用那份闭包式通用件：调用 register 时把 route/routePublic
// 收集成路由表，返回 createRoute 可直接消费的表；公开路由挂在返回值 .public 上，
// 与 gbmd 的 `module.exports.public` 约定一致。
//
// 用法（表式项目）：
//   const { createRoute } = require("../core/index.js");
//   const { tableFromRegister } = require("../route/routes-adapter.js");
//   const authRoutes = require("../route/routes-auth.js");
//   module.exports = tableFromRegister(authRoutes, { cfg, auth, sendJson, readBody, setSessionCookie });
// ============================================================
"use strict";

const { createRoute } = require("./route-factory");

/**
 * 把一个闭包式 register(api) 路由件转成表式。
 *
 * @param {Function} register  形如 (api) => void 的注册函数
 * @param {object}   deps      注入给 register 的依赖（cfg/auth/sendJson/readBody/autoUpdate/...）
 * @param {object}   [opts]
 * @param {string}   [opts.prefix]  给所有路径加前缀（默认不加）
 * @returns {Function} createRoute 表（公开路由挂在返回值的 .public 上）
 */
function tableFromRegister(register, deps, opts) {
  if (typeof register !== "function") {
    throw new Error("[routes-adapter] register 必须是函数");
  }
  const options = opts || {};
  const prefix = options.prefix || "";

  // key 形如 "GET /api/login"，多个方法用同一 key 时后者覆盖（与 createRoute 同语义）
  const authedTable = {};
  const publicTable = {};

  const collect = (bucket) => (method, path, handler) => {
    const m = String(method).toUpperCase();
    const p = prefix + path;
    // "*" 表示任意方法：createRoute 支持 "* /path" 形式
    bucket[m + " " + p] = handler;
    return handler;
  };

  const api = Object.assign({}, deps, {
    route: collect(authedTable),
    routePublic: collect(publicTable),
  });

  register(api);

  const table = createRoute(authedTable);
  // 公开路由：与 gbmd 的 module.exports.public 约定对齐
  table.public = createRoute(publicTable);
  // 也挂个空表兜底，避免调用方在无公开路由时对 undefined 取用
  return table;
}

module.exports = { tableFromRegister };
