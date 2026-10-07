// cjs-bootstrap.cjs —— 零依赖 CJS 强制（boot.cjs 与 test/ 共用）
// 「这个项目不需要packagejson文件」「零依赖nodejs项目禁止生成packagejson等」
// 背景：父目录（DSH 检出根）package.json 是 "type":"module"，直接 node server/app.js
//   会被当成 ESM 而 require 失效。禁止为此写本地 package.json；.cjs 永远是 CJS。
//   只劫持本项目根内的 .js，项目外仍走 Node 原逻辑。
// 重构纪律：本文件是 boot.cjs 与 test/bootstrap.cjs 的共同依赖——搬文件时不要破坏 PROJECT_ROOT 计算。
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

// server/lib/ → 上两级 = 项目根（gamebanana-mods-downloader-server/）
// 项目根下所有 .js（server/、server/routes/、server/services/、server/utils/）都强制 CJS。
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const origJs = Module._extensions[".js"];

Module._extensions[".js"] = function loadProjectJsAsCjs(module, filename) {
  const rel = path.relative(PROJECT_ROOT, filename);
  const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (inside) {
    const body = fs.readFileSync(filename, "utf8");
    module._compile(body, filename);
    return;
  }
  return origJs(module, filename);
};
