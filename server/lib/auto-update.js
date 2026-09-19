// ============================================================
// 自动更新（项目实例）：从框架引入工厂，只在这里传项目参数。
// 框架实现见 ../framework/auto-update.js（createAutoUpdate），本文件不重复框架代码。
// 路由模块 routes/auto-update.js 直接 require 本文件取实例（同 gbmd 做法）。
// ============================================================
"use strict";

const { createAutoUpdate } = require("../update/auto-update.js");

module.exports = createAutoUpdate({
  projectName: "gallery",
  defaultRepo: "EIGHTfs/gallery",
  // 运行态数据：github 模式绝不覆盖
  //   uploads/     游客上传的图片
  //   favorites.json  收藏列表
  //   config.json  画廊配置 + 密码哈希
  //   cache-gifs/  合成的 GIF 缓存
  //   tools/       ffmpeg / 7zz 外部二进制
  extraExclude: ["uploads/", "favorites.json", "config.json", "cache-gifs/", "tools/"],
});
