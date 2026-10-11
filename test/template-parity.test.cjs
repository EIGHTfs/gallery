#!/usr/bin/env node
// 模板回流一致性门禁（2026-10-12 新增）
//
// 用法：在项目根执行  node test/template-parity.test.cjs
// 零依赖；部署端没有模板仓库时自动跳过（不误报）。
//
// 为什么必须有：本项目已**两次**踩同一个坑 —— 改了项目侧的下发件（第一次 routes/browse.js、
//   第二次 routes/gallery.js + app.js），随后跑 setup.sh 组装时改动被**静默覆盖**回模板版本；
//   编辑工具回报成功、node --check 也通过（覆盖后语法完全合法），只有比对组装产物才暴露。
//   本门禁用模板自带的官方检查命令把这件事变成机械拦截：
//     bash setup.sh --to <项目清单> --check     # 只做清单一致性检查，不组装；不一致退出码 1
//   模板仓库默认同级（../bench-template，可用 TEMPLATE_REPO 覆盖）。
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TEMPLATE = process.env.TEMPLATE_REPO || path.join(ROOT, "..", "bench-template");
const setup = path.join(TEMPLATE, "setup.sh");

if (!fs.existsSync(setup)) {
  console.log("跳过：未找到模板仓库（" + TEMPLATE + "）—— 部署端无模板仓库属正常");
  process.exit(0);
}

let out = "";
try {
  out = execFileSync("bash", [setup, "--to", path.join(ROOT, "assemble.json"), "--check"],
    { cwd: TEMPLATE, encoding: "utf8", timeout: 120000 });
} catch (e) {
  const detail = String((e && (e.stdout || e.stderr || e.message)) || e);
  console.log("not ok - 模板一致性检查未通过（项目侧改了却没回流模板，下次组装会被覆盖）\n" + detail);
  process.exit(1);
}
console.log("ok - 模板一致性检查通过（清单两端一致）");
console.log("     " + String(out).trim().split("\n").slice(-1)[0]);
