#!/usr/bin/env node
// 目录浏览器「返回上一级」回归测试（2026-10-08 修 gallery「设置→添加图片目录」上不去）
//
// 用法：在项目根执行  node test/dir-browser-up.test.cjs
// 零依赖、不联网；沙箱目录建在系统临时目录、跑完即删，不碰 server/config.json。
//
// 背景：queryRoot 会把越界请求钳回 resolveFsRoot（= 已配置目录的公共前缀）。
// 只配了一个图片目录时，公共前缀恰好等于该目录本身 → 目录浏览器永远上不去。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const { resolveFsRoot, queryRoot, resolveBrowseLimit, browseRoot } =
  require(path.join(ROOT, "server", "lib", "config.js"));

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + " → " + (e && e.message)); fail++; }
}

// 沙箱：模拟「只配了一个图片目录」的部署 —— 这正是 bug 的触发条件
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-browse-"));
const inner = path.join(sandbox, "Cygames", "赛马娘Pretty Derby");
fs.mkdirSync(inner, { recursive: true });
const parent = path.dirname(inner);
const cfg = { directories: [{ path: inner, category: "all" }] };

console.log("═══ 根因复现：单目录时 resolveFsRoot 恰好等于该目录（上界过窄）═══");
ok("resolveFsRoot(cfg) === 该目录本身", () => assert.strictEqual(resolveFsRoot(cfg), inner));
ok("公共路径 queryRoot 仍被钳回该目录（未登录行为不变）", () => {
  assert.strictEqual(queryRoot({ root: parent }, cfg), inner);
});

console.log("═══ 修复：已登录的目录浏览器可返回上一级 ═══");
ok("向上请求父目录 → 返回父目录且未被钳制", () => {
  const r = browseRoot({ root: parent }, cfg);
  assert.strictEqual(r.root, parent);
  assert.strictEqual(r.clamped, false);
});
ok("再上一级（沙箱的父）同样可用", () => {
  const r = browseRoot({ root: path.dirname(parent) }, cfg);
  assert.strictEqual(r.root, path.dirname(parent));
  assert.strictEqual(r.clamped, false);
});
ok("未显式配置时浏览天花板 = 文件系统根", () => {
  assert.strictEqual(resolveBrowseLimit(cfg), path.parse(process.cwd()).root);
});

console.log("═══ 显式配置 fsRoot 时仍受限制（尊重部署方限制）═══");
ok("显式 fsRoot 之内正常浏览", () => {
  const c2 = { ...cfg, fsRoot: parent };
  assert.strictEqual(resolveBrowseLimit(c2), parent);
  assert.strictEqual(browseRoot({ root: inner }, c2).root, inner);
});
ok("越出显式 fsRoot 被钳回并标记 clamped", () => {
  const c2 = { ...cfg, fsRoot: inner };
  const r = browseRoot({ root: parent }, c2);
  assert.strictEqual(r.root, inner);
  assert.strictEqual(r.clamped, true);
});

console.log("═══ 前端回归守卫：目录浏览器处理 clamped / canUp ═══");
ok("app.js 读取 data.clamped 与 data.canUp", () => {
  const ui = fs.readFileSync(path.join(ROOT, "server", "public", "app.js"), "utf8");
  assert.ok(ui.includes("data.clamped"), "缺少 clamped 处理 → 会退化成「点了没反应」");
  assert.ok(ui.includes("data.canUp"), "缺少 canUp 处理 → 到顶时 ↑ 不会禁用");
});

console.log("═══ 后端路由把登录态传给了 apiDirectories ═══");
ok("server/app.js 传入 { authed: isAuthed(req) }", () => {
  const s = fs.readFileSync(path.join(ROOT, "server", "app.js"), "utf8");
  assert.ok(s.includes("authed: isAuthed(req)"), "路由未传登录态 → 放宽逻辑不会生效");
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
