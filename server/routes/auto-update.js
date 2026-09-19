// ============================================================
// 拾光集 - 路由：自动更新（/api/auto-update）
//
// 复用框架通用件 framework/routes-auto-update.js（闭包式 register(api)），
// 经 routes-adapter 转成 createRoute 表式 —— 不再手抄一份同逻辑实现。
//
// 端点（由通用件提供）：
//   GET  /api/auto-update/status   配置 + 运行状态（含 lastUpdatedAt，供前端显示更新时间）
//   POST /api/auto-update/config   改启停/模式/间隔（github 仓库与 Token 仅限改配置文件）
//   POST /api/auto-update/check    手动触发一次 github 检查
//   POST /api/auto-update/restart  手动重启
// ============================================================
"use strict";

const { sendJson, readBody } = require("../core/index.js");
const { tableFromRegister } = require("../route/routes-adapter.js");
const routesAutoUpdate = require("../route/routes-auto-update.js");
// 项目实例：lib/auto-update.js（引框架工厂 + 传 gallery 参数）
const autoUpdate = require("../lib/auto-update");

let table = null;

/**
 * 装配：注入 cfg 后生成路由表。
 * @param {{cfg: object}} deps
 */
function init(deps) {
  table = tableFromRegister(routesAutoUpdate, {
    sendJson,
    readBody,
    cfg: deps.cfg,
    autoUpdate,
  });
  return table;
}

module.exports = { init, get table() { return table; } };
