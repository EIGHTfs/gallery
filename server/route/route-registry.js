// ============================================================
// 路由注册（闭包式范式）
//   表式见 route-factory.js：createRoute({ "GET /api/x": fn })
//   本文件是另一种范式：调用方拿到 route / routePublic 后自行注册，
//   适合需要在函数体内按条件/循环动态注册路由的项目。
//
//   const registry = createRegistry();
//   registry.route("GET", "/api/videos", handler);        // 需鉴权
//   registry.routePublic("POST", "/api/login", handler);  // 公开
//   // 请求到来时：
//   const h = registry.matchPublic(method, pathname) || registry.match(method, pathname);
//
// 设计约定（与 iwara 既有实现保持一致，避免调用方改动）：
//   · handler 签名 (req, res, api)，本模块不组装 ctx、不预读 body、不捕获异常
//     —— 这几件事由调用方的应用层决定，注册器只管「登记 + 匹配」
//   · onError 未传时异常照常向上抛（与原行为一致）；传入后统一捕获并记日志
//   · 匹配语义完全复用 route-core：线性扫描、先注册先赢
// ============================================================
"use strict";

const { match, normalizeRule } = require("./route-core");

/**
 * 创建路由注册器。
 * @param {object} [opts]
 * @param {(err: Error, info: {method: string, path: string}) => void} [opts.onError]
 *        传入时：handler 抛错/返回 rejected Promise 都会被捕获并回调，且不再向上抛。
 *        不传时：行为与未包装一致，异常向上抛（默认，保持既有项目行为不变）。
 * @returns {{route: Function, routePublic: Function, routes: Array, publicRoutes: Array,
 *            match: Function, matchPublic: Function, size: Function}}
 */
function createRegistry(opts) {
  const options = opts || {};
  const routes = [];
  const publicRoutes = [];

  function add(list, method, path, handler) {
    const rule = normalizeRule({ method: method, path: path, handler: handler });
    if (!rule) {
      throw new Error("[route-registry] 注册失败：method/path/handler 不合法（path=" + String(path) + "）");
    }
    list.push(rule);
    return handler;
  }

  /** 注册需鉴权路由 */
  function route(method, path, handler) {
    return add(routes, method, path, handler);
  }

  /** 注册公开路由（免鉴权） */
  function routePublic(method, path, handler) {
    return add(publicRoutes, method, path, handler);
  }

  /** 包装 handler：仅在传了 onError 时才接管异常 */
  function wrap(handler, method, path) {
    if (typeof options.onError !== "function") return handler;
    return function wrapped(req, res, api) {
      try {
        const out = handler(req, res, api);
        if (out && typeof out.then === "function") {
          return out.catch((err) => options.onError(err, { method: method, path: path }));
        }
        return out;
      } catch (err) {
        return options.onError(err, { method: method, path: path });
      }
    };
  }

  /** 查找需鉴权路由的 handler */
  function matchRoute(method, pathname) {
    return match(routes, method, pathname);
  }

  /** 查找公开路由的 handler */
  function matchPublic(method, pathname) {
    return match(publicRoutes, method, pathname);
  }

  return {
    route: route,
    routePublic: routePublic,
    wrap: wrap,
    routes: routes,
    publicRoutes: publicRoutes,
    match: matchRoute,
    matchPublic: matchPublic,
    size: () => ({ routes: routes.length, publicRoutes: publicRoutes.length }),
  };
}

module.exports = { createRegistry };
