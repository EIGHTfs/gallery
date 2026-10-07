// 零依赖启动器：强制本项目 .js 按 CommonJS 加载。
// 父目录 package.json 为 "type":"module" 时，直接 node app.js 会被当 ESM 导致 require 失败。
// .cjs 永远是 CJS；只劫持本项目根内的 .js，项目外仍走 Node 原逻辑。
//
// 这份文件由项目清单下发（src → server/boot.cjs），不再由 setup.sh 生成：
// 脚本生成会把具体路径写死在脚本里，框架目录一改结构就静默失效。
"use strict";

// 进程级兜底：未捕获异常 / 未处理 Promise rejection 只记录日志，不让整个服务退出。
// 背景（2026-10-08 线上崩溃）：iwara-api 的超时定时器里一个 TDZ ReferenceError 没有被
// 任何一层捕获，Node 直接退出 → 服务整机不可用、正在跑的下载任务全部中断、油猴端
// 表现为「发送不了 Cookie」（POST 还没回包进程就没了）。
// 这类「漏网异步异常」在常驻 Web 服务里应降级为一条日志，而不是整个进程陪葬。
process.on("uncaughtException", (e) => {
  console.error("[fatal-guard] uncaughtException（已拦截，进程继续）:", (e && e.stack) || e);
});
process.on("unhandledRejection", (e) => {
  console.error("[fatal-guard] unhandledRejection（已拦截，进程继续）:", (e && e.stack) || e);
});

require("./lib/cjs-bootstrap.cjs");
require("./app.js");
