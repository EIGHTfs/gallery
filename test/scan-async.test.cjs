#!/usr/bin/env node
// 扫描异步化回归测试（Step 5，2026-10-12）
//
// 用法：在项目根执行  node test/scan-async.test.cjs
// 零依赖、不联网；沙箱目录建在系统临时目录、跑完即删，不碰 server/config.json。
//
// 背景：recursiveScanAll 原为纯同步递归（readdirSync + 每图 statSync），冷扫描期间占满事件循环。
//   Step 4 改为 fs.promises 异步 + 每 30 个目录 setImmediate 让出 + 单飞复用。
//
// 标尺隔离（perf-profile-first 纪律）：等价性基准是**本文件内冻结的旧同步实现**，
//   不是被测的 scan.js 本身 —— 否则「改源码必然改变它」，基准就失去意义。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const scan = require(path.join(__dirname, "..", "server", "lib", "scan.js"));
const io = require(path.join(__dirname, "..", "server", "lib", "io-monitor.js"));

// ── 冻结的旧实现（Step 4 之前的同步版，仅用于等价性对照）────────────────────
const { getExcludeDirs } = require(path.join(__dirname, "..", "server", "lib", "config.js"));
const { formatSize } = require(path.join(__dirname, "..", "server", "lib", "util.js"));
function legacyRecursiveScanAll(dir) {
  const images = [];
  const dirMtimes = new Map();
  const exclude = getExcludeDirs();
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && exclude.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(jpe?g|png|gif|webp)$/i.test(entry.name)) {
        try {
          const st = fs.statSync(full);
          images.push({
            name: entry.name, path: full,
            url: `/api/media?file=${encodeURIComponent(full)}`,
            size: formatSize(st.size), modified: st.mtime.toISOString(),
          });
        } catch (_) { /* 跳过 */ }
      }
    }
    dirMtimes.set(d, (() => { try { return fs.statSync(d).mtimeMs; } catch (_) { return -1; } })());
  }
  walk(dir);
  return { images, dirMtimes };
}

// ── 夹具：嵌套目录 + 混合文件 + 一个排除目录 ────────────────────────────────
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gal-scan-"));
  const sub = path.join(root, "sub");
  const deep = path.join(sub, "deep");
  const ea = path.join(root, "@eaDir");              // 应被排除
  for (const d of [sub, deep, ea]) fs.mkdirSync(d, { recursive: true });
  const files = [
    [root, "a.png"], [root, "b.JPG"], [root, "note.txt"],     // 只有图片应被收集
    [sub, "c.webp"], [sub, "d.gif"],
    [deep, "e.jpeg"],
    [ea, "should-be-ignored.png"],                             // 排除目录内不收集
  ];
  for (const [d, n] of files) fs.writeFileSync(path.join(d, n), "x".repeat(n.length));
  return root;
}

let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((e) => { failed += 1; console.log(`not ok - ${name}\n    ${e && e.message}`); });
}

(async () => {
  const root = makeTree();
  try {
    await test("等价性：异步扫描结果与旧同步实现逐字段一致（含顺序）", async () => {
      const legacy = legacyRecursiveScanAll(root);
      const now = await scan.recursiveScanAll(root);
      assert.deepStrictEqual(now.images, legacy.images, "images 必须逐字段一致且顺序相同");
      assert.deepStrictEqual([...now.dirMtimes.keys()], [...legacy.dirMtimes.keys()], "目录集合与顺序一致");
      assert.deepStrictEqual([...now.dirMtimes.values()], [...legacy.dirMtimes.values()], "各目录 mtime 一致");
      assert.strictEqual(now.images.length, 5, "应收集 5 张图片（排除 @eaDir）");
    });

    await test("排除目录：@eaDir 内的图片不被收集", async () => {
      const r = await scan.recursiveScanAll(root);
      assert.ok(!r.images.some((x) => x.path.includes("@eaDir")), "@eaDir 内图片不应出现");
    });

    await test("边界：空目录返回空结果且不抛错", async () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gal-empty-"));
      try {
        const r = await scan.recursiveScanAll(empty);
        assert.deepStrictEqual(r.images, []);
        assert.strictEqual(r.dirMtimes.size, 1);
      } finally { fs.rmSync(empty, { recursive: true, force: true }); }
    });

    await test("边界：不存在的根目录不抛错（返回空）", async () => {
      const r = await scan.recursiveScanAll(path.join(os.tmpdir(), "gal-not-exist-" + Date.now()));
      assert.deepStrictEqual(r.images, []);
    });

    await test("单飞：并发 3 次冷扫描只实际扫一轮（readdir 调用数 = 目录数，而非 3 倍）", async () => {
      io.reset();
      const before = io.topSites().filter((x) => x.label === "scan:readdir").reduce((s, x) => s + x.calls, 0);
      const [r1, r2, r3] = await Promise.all([
        scan.recursiveScanAll(root), scan.recursiveScanAll(root), scan.recursiveScanAll(root),
      ]);
      const after = io.topSites().filter((x) => x.label === "scan:readdir").reduce((s, x) => s + x.calls, 0);
      const dirs = r1.dirMtimes.size;                       // 夹具目录数（含根、sub、deep；@eaDir 被排除不读）
      assert.strictEqual(after - before, dirs, `并发 3 次应只扫一轮（readdir ${dirs} 次），实际 ${after - before} 次`);
      assert.deepStrictEqual(r2.images, r1.images);
      assert.deepStrictEqual(r3.images, r1.images);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} 个用例失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
})();
