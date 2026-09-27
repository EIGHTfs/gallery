// ============================================================
// 自动更新（通用项目包装，最通用层）：从框架引入工厂，项目参数从同目录
// auto-update-params.json 读取（独立参数文件，不占 config.json 运行态配置）。
// 框架实现见 templates/js/update/auto-update.js（createAutoUpdate），本文件不重复框架代码。
// 项目参数文件：<项目根>/server/lib/auto-update-params.json —— 由项目侧维护，
//   与模板无关（模板只下发本通用包装，参数文件随项目自定义）。
// 下发：assemble.json 把本文件 → 项目 server/lib/auto-update.js。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { createAutoUpdate } = require("../update/auto-update.js");

// 项目参数文件与本文件同目录（server/lib/auto-update-params.json）
let params = {};
const paramsPath = path.join(__dirname, "auto-update-params.json");
try {
  params = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
} catch (_) {
  // 参数文件缺失（首次未配置）：用空参数，工厂默认值兜底
}

module.exports = createAutoUpdate({
  projectName: params.projectName || "",
  defaultRepo: params.defaultRepo || "",
  extraExclude: params.extraExclude || [],
  extraChmodScripts: params.extraChmodScripts || [],
});
