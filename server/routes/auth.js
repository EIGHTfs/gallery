// ============================================================
// 拾光集 - 路由：认证
//
// 本文件不再手写端点，改为【直接复用框架通用件 framework/routes-auth.js】，
// 经 routes-adapter 把它的闭包式注册转成 createRoute 表式。
//
// 为什么这样做：通用件最初是给 iwara 的闭包式 registry 写的，gbmd/gallery 走表式，
// 于是各自手抄了一份同逻辑实现 —— 正是通用件注释里吐槽的「逻辑漂移」来源
// （remember 长会话一处有一处没有、改密验旧密码一处有一处没有）。
// 有了适配器，表式项目也能直接用同一份通用件，不再复制逻辑。
//
// 端点（由通用件提供）：
//   POST /api/login            登录（未设密码直接放行）
//   POST /api/logout           登出
//   GET  /api/status           前端据此决定跳登录页还是进主界面
//   POST /api/change-password  改密（需鉴权；已设密码须验旧密码）
// ============================================================
"use strict";

const { sendJson, readBody, auth } = require("../core/index.js");
const { tableFromRegister } = require("../route/routes-adapter.js");
const routesAuth = require("../route/routes-auth.js");

// 依赖在注册时注入（闭包捕获），handler 签名仍是 (req, res)
// cfg 由 app.js 在装配阶段通过 init 传入 —— 见下方 setDeps
let table = null;

/**
 * 装配：注入运行期依赖后生成路由表。
 * 通用件需要 cfg（配置读写），而 cfg 在 app.js 里创建，故此处延迟装配。
 * @param {{cfg: object}} deps
 */
function init(deps) {
  table = tableFromRegister(routesAuth, {
    sendJson,
    readBody,
    cfg: deps.cfg,
    auth,
    setSessionCookie: auth.setSessionCookie,
  });
  return table;
}

module.exports = { init, get table() { return table; } };
