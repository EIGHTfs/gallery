#!/usr/bin/env node
// IO 监测「按调用点归因」回归测试（2026-10-12 新增）
//
// 用法：在项目根执行  node test/io-monitor.test.cjs
// 零依赖、不联网；不碰 server/config.json。
//
// 背景：原来只按 label 归因（scan:readdir / scan:stat 之类），扫描慢时定位不到**哪一行**在扫。
//   扩展为按调用点（file:line）归因。三条关键约束：
//     ① 站点必须在 meter() **创建时**固定 —— 热路径（逐文件/逐分块计数）绝不抓栈；
//     ② count() 向后兼容（不传站点记 "(未标注)"）；
//     ③ snapshot().bySite 结构稳定（/api/io 消费）。
"use strict";
const path = require("path");
const assert = require("assert");

const io = require(path.join(__dirname, "..", "server", "lib", "io-monitor.js"));

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`not ok - ${name}\n    ${e && e.message}`);
  }
}

test("meter：站点在创建时固定（抓到本测试文件），按 label+站点聚合字节与次数", () => {
  io.reset();
  const a = io.meter("scan:stat");
  const b = io.meter("scan:stat", "scan.js:48");       // 显式站点
  a(100); a(200); b(50);
  const sites = io.topSites().filter((x) => x.label === "scan:stat");
  assert.strictEqual(sites.length, 2, "同一 label 下应有两个站点");
  const explicit = sites.find((x) => x.site === "scan.js:48");
  assert.ok(explicit, "显式站点应原样记录");
  assert.strictEqual(explicit.bytes, 50);
  const auto = sites.find((x) => x.site !== "scan.js:48");
  assert.ok(auto, "未显式给站点时应自动捕获");
  assert.match(auto.site, /io-monitor\.test\.cjs:\d+/, "自动捕获应指向真实调用点");
  assert.strictEqual(auto.bytes, 300);
  assert.strictEqual(auto.calls, 2);
  assert.strictEqual(io.topLabels().find((x) => x.label === "scan:stat").bytes, 350);
});

test("count：向后兼容（站点记「(未标注)」），也可显式给站点", () => {
  io.reset();
  io.count("scan:readdir", 1000);
  io.count("scan:readdir", 500, "scan.js:37");
  const sites = io.topSites();
  assert.strictEqual(sites.find((x) => x.site === "(未标注)").bytes, 1000);
  assert.strictEqual(sites.find((x) => x.site === "scan.js:37").bytes, 500);
});

test("性能护栏：meter 调用 10 万次 < 400ms（证明热路径不抓栈）", () => {
  io.reset();
  const m = io.meter("scan:stat", "hot-path");
  const t0 = Date.now();
  for (let i = 0; i < 100000; i += 1) m(128);
  const ms = Date.now() - t0;
  assert.ok(ms < 400, `10 万次 meter 调用耗时 ${ms}ms（>400ms 说明每次都在抓栈，热路径会拖垮扫描）`);
  assert.strictEqual(io.topSites().find((x) => x.site === "hot-path").calls, 100000);
});

test("snapshot：bySite 结构稳定 + byLabel 保留（/api/io 消费方不破）", () => {
  io.reset();
  io.meter("scan:stat", "scan.js:48")(4096);
  const snap = io.snapshot();
  assert.ok(Array.isArray(snap.bySite), "bySite 必须是数组");
  assert.ok(Array.isArray(snap.byLabel), "byLabel 必须保留（兼容）");
  for (const k of ["label", "site", "bytes", "calls", "human"]) {
    assert.ok(k in snap.bySite[0], `bySite 条目应含 ${k}`);
  }
  assert.strictEqual(snap.bySite[0].human, "4.0 KB");
  assert.strictEqual(typeof snap.enabled, "boolean");
});

test("reset：清空归因表，保证用例之间互不污染", () => {
  io.reset();
  assert.strictEqual(io.topSites().length, 0);
  assert.strictEqual(io.topLabels().length, 0);
});

console.log(failed ? `\n${failed} 个用例失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
