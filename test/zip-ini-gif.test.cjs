#!/usr/bin/env node
// 压缩包 ini / 180° 翻转 / GIF 帧间隔 回归测试（2026-10-08）
//
// 用法：在项目根执行  node test/zip-ini-gif.test.cjs
// 零依赖、不联网；沙箱建在系统临时目录、跑完即删。
// 真包部分依赖系统 zip / 7z（缺失则跳过，只跑纯函数与接线守卫）。
//
// 被测语义（4 条规则）：
//   ① 包名带间隔（@40ms / 2s，Pixiv 图包）→ 按该间隔合成 GIF，不翻转；
//   ② 含 ini（3DMigoto mod）→ ini 决定翻转 180°；
//   ③ 序列 且 含 ini 且 ini 有 $speed → 按 1000/(fps×$speed) 换算帧间隔合成 GIF；
//   ④ 两者都无 → 不合成、不翻转（原样显示）。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const archive = require(path.join(ROOT, "server", "lib", "archive.js"));
const gif = require(path.join(ROOT, "server", "lib", "gif.js"));

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + " → " + (e && e.message)); fail++; }
}
function has(bin) {
  try { execFileSync("sh", ["-c", "command -v " + bin], { stdio: "ignore" }); return true; }
  catch (_) { return false; }
}

console.log("═══ $speed 解析（3dmigoto 动画 ini 的三种写法）═══");
ok("global persist $speed = 0.5 → 0.5", () => assert.strictEqual(archive.parseIniSpeed("[Constants]\nglobal persist $speed = 0.5\n"), 0.5));
ok("global $speed = 0.25 → 0.25", () => assert.strictEqual(archive.parseIniSpeed("global $speed = 0.25"), 0.25));
ok("$speed = 1 → 1", () => assert.strictEqual(archive.parseIniSpeed("$speed = 1"), 1));
ok("只有 $frame → null", () => assert.strictEqual(archive.parseIniSpeed("global persist $frame = 0"), null));
ok("$speed = 0 → null（0 视为不可用）", () => assert.strictEqual(archive.parseIniSpeed("global persist $speed = 0"), null));
ok("无关文本 → null", () => assert.strictEqual(archive.parseIniSpeed("hello world"), null));

console.log("═══ $speed → 帧间隔换算（fps 参数化，默认 60）═══");
ok("speed=0.5, fps=60 → 33ms（30 动画帧/秒）", () => assert.strictEqual(gif.frameMsFromIniSpeed(0.5, 60), 33));
ok("speed=0.5, fps=30 → 67ms（与旧记录 66.7ms/帧 吻合）", () => assert.strictEqual(gif.frameMsFromIniSpeed(0.5, 30), 67));
ok("speed=0.25, fps=60 → 67ms", () => assert.strictEqual(gif.frameMsFromIniSpeed(0.25, 60), 67));
ok("极大 speed → 夹到 ≥10ms（GIF 延迟单位是 10ms）", () => assert.strictEqual(gif.frameMsFromIniSpeed(100, 60), 10));
ok("非法 speed → 0（表示不可换算）", () => assert.strictEqual(gif.frameMsFromIniSpeed(0, 60), 0));

console.log("═══ 真包验证：含 ini 的 zip 与 7z（rar 走同一分支）═══");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-zipini-"));
// 1x1 透明 PNG（最小合法图）
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
for (const n of ["frame01.png", "frame02.png", "frame03.png"]) fs.writeFileSync(path.join(sandbox, n), png);
fs.writeFileSync(path.join(sandbox, "mod.ini"), "[Constants]\nglobal persist $speed = 0.5\n");

const packs = [];
if (has("zip")) {
  const zp = path.join(sandbox, "pack_ini.zip");
  execFileSync("zip", ["-q", "-j", zp, "frame01.png", "frame02.png", "frame03.png", "mod.ini"], { cwd: sandbox });
  packs.push(["zip", zp]);
}
if (has("7z")) {
  const zp = path.join(sandbox, "pack_ini.7z");
  execFileSync("7z", ["a", "-bd", "-y", zp, "frame01.png", "frame02.png", "frame03.png", "mod.ini"], { cwd: sandbox, stdio: "ignore" });
  packs.push(["7z", zp]);
}
if (!packs.length) {
  console.log("  ⚠ 本机无 zip/7z，跳过真包部分");
} else {
  for (const [kind, zp] of packs) {
    ok(kind + "：listArchiveImages 认出 3 张图", () => assert.strictEqual(archive.listArchiveImages(zp).length, 3));
    ok(kind + "：hasIniEntry = true（mod 标记）", () => assert.strictEqual(archive.hasIniEntry(zp), true));
    ok(kind + "：listIniEntries 命中 mod.ini", () => assert.deepStrictEqual(archive.listIniEntries(zp), ["mod.ini"]));
    ok(kind + "：readIniSpeed = 0.5（供换算帧间隔）", () => assert.strictEqual(archive.readIniSpeed(zp), 0.5));
    ok(kind + "：无 ini 的包 hasIniEntry = false", () => {
      const np = path.join(sandbox, "noini" + path.extname(zp));
      if (kind === "zip") execFileSync("zip", ["-q", "-j", np, "frame01.png"], { cwd: sandbox });
      else execFileSync("7z", ["a", "-bd", "-y", np, "frame01.png"], { cwd: sandbox, stdio: "ignore" });
      assert.strictEqual(archive.hasIniEntry(np), false);
    });
    ok(kind + "：desktop.ini 不算 mod 标记", () => {
      const dp = path.join(sandbox, "desk" + path.extname(zp));
      fs.writeFileSync(path.join(sandbox, "desktop.ini"), "[LocalizedFileNames]\n");
      if (kind === "zip") execFileSync("zip", ["-q", "-j", dp, "frame01.png", "desktop.ini"], { cwd: sandbox });
      else execFileSync("7z", ["a", "-bd", "-y", dp, "frame01.png", "desktop.ini"], { cwd: sandbox, stdio: "ignore" });
      assert.strictEqual(archive.hasIniEntry(dp), false);
    });
  }
}

console.log("═══ 前端/路由接线守卫 ═══");
ok("前端门控：序列 且（包名间隔 或 ini 有 $speed）", () => {
  const ui = fs.readFileSync(path.join(ROOT, "server", "public", "app.js"), "utf8");
  assert.ok(/useGif\s*=\s*isSeq\s*&&/.test(ui), "缺少 useGif 门控");
  assert.ok(ui.includes("z.hasIni && z.speed"), "门控未同时考虑 ini 的 $speed");
});
ok("路由 fps 参数化并透传（默认 60）", () => {
  const r = fs.readFileSync(path.join(ROOT, "server", "routes", "archive.js"), "utf8");
  assert.ok(r.includes('query.fps || "60"'), "未参数化 fps");
  assert.ok(r.includes("{ fps }"), "未把 fps 传给 gifFromZip");
});
ok("含 ini 的包图片走翻转分支", () => {
  const r = fs.readFileSync(path.join(ROOT, "server", "routes", "archive.js"), "utf8");
  assert.ok(r.includes("flipArchiveImage"), "未接翻转");
});
ok("GIF 合成对 ini 包启用 vflip,hflip", () => {
  const g = fs.readFileSync(path.join(ROOT, "server", "lib", "gif.js"), "utf8");
  assert.ok(g.includes("vflip,hflip"), "缺少翻转滤镜");
});
ok("scan 回传 hasIni / speed（供前端门控）", () => {
  const r = fs.readFileSync(path.join(ROOT, "server", "routes", "archive.js"), "utf8");
  assert.ok(r.includes("hasIni") && r.includes("speed:"), "scan 未回传 hasIni/speed");
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
