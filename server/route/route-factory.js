// 路由工厂（表式范式）：把 handler 函数注册到 HTTP 路由
// 项目路由文件只需导出 handler 表，框架处理：body 解析、错误捕获。
// 另一种范式见 route-registry.js（闭包式）；两者的匹配语义共用 route-core，
// 差异仅在「怎么登记路由」，匹配行为完全一致。
//
// 表 key 支持：
//   "GET /api/x"      精确路径
//   "* /api/x"        method 通配（任意方法）
//   "GET /api/x/:id"  模板路径，:id 编译为具名捕获，handler 里用 ctx.params.id 取
//   "GET /^\\/avatar\\//"  RegExp 路径（以 / 开头且能被解析为正则字面量时不适用，
//                      如需正则请用 route-registry 的闭包式注册）
"use strict";

const { sendJson, readBody } = require("../http/http-utils.js");
const routeCore = require("./route-core");

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function parseRouteTable(handlers) {
  const table = [];
  for (const [key, fn] of Object.entries(handlers)) {
    const parts = key.split(/\s+/);
    const method = parts[0].toUpperCase();
    const pattern = parts[1] || "/";
    // 复用 route-core 的模板编译（:param → 具名捕获），保持与闭包式同源
    const re = routeCore.compilePattern(pattern);
    table.push({ method, re, fn, pattern });
  }
  return table;
}

async function parseBody(req) {
  if (!BODY_METHODS.has(req.method)) return;
  try { req.body = await readBody(req); }
  catch (_) { req.body = {}; }
}

/**
 * 创建路由处理器。
 * @param {object} handlers - { 'GET /path': fn, 'POST /path': fn, ... }
 */
function createRoute(handlers) {
  const table = parseRouteTable(handlers);

  return async function routeHandler(req, res, url, ctx) {
    const pathname = url.pathname;
    const method = req.method;

    for (const entry of table) {
      // method 匹配统一走 route-core：支持 "*" 通配与数组，与闭包式同源
      if (!routeCore.matchMethod(entry.method, method)) continue;
      const match = pathname.match(entry.re);
      if (!match) continue;

      await parseBody(req);
      req.params = match.groups || {};

      // 请求上下文：query / pathname / params / url（handler 第三参数直接取用）
      const reqCtx = Object.assign({}, ctx, {
        query: (url && url.query) || {},
        pathname: pathname,
        params: req.params,
        url: url,
        req: req,
        res: res,
      });

      try {
        await entry.fn(req, res, reqCtx);
      } catch (err) {
        console.error("[route] " + method + " " + pathname + " error:", err.message);
        sendJson(res, { ok: false, error: err.message || "内部错误" }, 500);
      }
      return true;
    }
    return false;
  };
}

/**
 * 创建路由组（多个路由合并）。
 */
function groupRoutes(...routes) {
  return async function(req, res, url, ctx) {
    for (const route of routes) {
      if (await route(req, res, url, ctx)) return true;
    }
    return false;
  };
}

module.exports = { createRoute, groupRoutes };
