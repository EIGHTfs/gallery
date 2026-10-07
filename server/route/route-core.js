// ============================================================
// 路由匹配核心（两范式共享）
//   模板同时提供两种注册范式，注册方式不同，匹配逻辑只有这一份：
//     · route-factory.js  表式：createRoute({ "GET /api/x": fn })
//     · route-registry.js 闭包式：createRegistry() → route / routePublic
//   两边注册完成后都归结为「有序规则列表 + match() 线性匹配」，故核心在此统一。
// 规则形状（normalizeRule 归一化后）：
//   { method, path, handler }
//   method：字符串 / "*"（通配）/ 数组（如 ["GET","HEAD"]）
//   path：字符串（精确匹配）/ RegExp 实例
// 匹配语义（与 iwara 原 app.js 内联实现保持逐条一致）：
//   1) 按列表顺序线性扫描，先注册先命中（同路径重复注册时先注册的赢）
//   2) method 先判： "*" 恒真，数组含即中，否则严格相等
//   3) path 再判： RegExp 用 test，字符串用全等（大小写敏感，不做归一化）
// ============================================================
"use strict";

/**
 * method 是否命中规则。
 * @param {string|string[]} ruleMethod 规则声明的 method（"*" / "GET" / ["GET","HEAD"]）
 * @param {string} method 请求 method
 */
function matchMethod(ruleMethod, method) {
  if (ruleMethod === "*") return true;
  const list = Array.isArray(ruleMethod) ? ruleMethod : [ruleMethod];
  return list.indexOf(method) >= 0;
}

/**
 * path 是否命中规则。
 * @param {string|RegExp} rulePath 规则声明的路径
 * @param {string} pathname 请求路径
 */
function matchPath(rulePath, pathname) {
  if (rulePath instanceof RegExp) {
    // 带 g / y 标志的正则 test 会改写 lastIndex，导致同一条规则间歇性失配；
    // 每次匹配前归零，保证匹配无状态。
    if (rulePath.global || rulePath.sticky) rulePath.lastIndex = 0;
    return rulePath.test(pathname);
  }
  return rulePath === pathname;
}

/**
 * 在规则列表中查找命中的 handler。
 * @param {Array} rules 归一化后的规则列表
 * @param {string} method 请求 method
 * @param {string} pathname 请求路径
 * @returns {*} 命中的 handler，未命中返回 null
 */
function match(rules, method, pathname) {
  for (const r of rules || []) {
    if (matchMethod(r.method, method) && matchPath(r.path, pathname)) return r.handler;
  }
  return null;
}

/**
 * 归一化单条规则：把 { method, p|path, handler } 统一成 { method, path, handler }。
 * 兼容表式历史上用 p 字段、闭包式用 path 字段的差异。
 */
function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const path = rule.path !== undefined ? rule.path : rule.p;
  if (path === undefined || path === null || path === "") return null;
  if (typeof rule.handler !== "function") return null;
  return { method: rule.method, path: path, handler: rule.handler };
}

/**
 * 把 "/api/x/:id" 这类模板路径编译为正则，具名捕获分组可直接用 match.groups.id 取。
 * 供表式 route-factory 使用（闭包式不需要，其 path 原样传入）。
 * @param {string} pattern 模板路径
 * @returns {RegExp}
 */
function compilePattern(pattern) {
  const src = String(pattern || "/").replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return new RegExp("^" + src + "$");
}

module.exports = { matchMethod, matchPath, match, normalizeRule, compilePattern };
