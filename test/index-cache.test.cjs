// ============================================================
// index-cache 单测：按文件指纹失效的内存缓存
//
// 为什么要有这些断言：
//   缓存一旦判错「文件没变」，索引就会长期停在旧内容（比慢更糟），
//   所以命中、失效、淘汰、关闭四种行为都必须用测试钉死。
// ============================================================
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cache = require(path.join(__dirname, "..", "server", "lib", "index-cache.js"));

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gal-idxcache-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function cleanup(file) {
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
}

test("未命中调用 loader；命中后不再调用 loader", () => {
  cache.reset();
  cache.setEnabled(true);
  const file = tmpFile("a.jsonl", '{"k":"x","items":[]}\n');
  let loads = 0;
  const loader = () => { loads++; return new Map([["x", { k: "x" }]]); };

  const first = cache.getMap(file, loader);
  assert.strictEqual(loads, 1, "首次必须回源");
  assert.strictEqual(first.get("x").k, "x");

  const second = cache.getMap(file, loader);
  assert.strictEqual(loads, 1, "第二次应命中缓存，不得再回源");
  assert.strictEqual(second, first, "命中应返回同一份 Map 实例");

  const st = cache.stats();
  assert.strictEqual(st.hit, 1);
  assert.strictEqual(st.miss, 1);
  assert.strictEqual(st.hitRate, 50, "1 命中 / 1 未命中 ⇒ 命中率应为 50%");
  cleanup(file);
});

test("文件内容变化（size/mtime 变）后缓存失效并重新回源", () => {
  cache.reset();
  cache.setEnabled(true);
  const file = tmpFile("b.jsonl", "short\n");
  let loads = 0;
  const loader = () => { loads++; return new Map([["k", { k: String(loads) }]]); };

  cache.getMap(file, loader);
  assert.strictEqual(loads, 1);

  fs.writeFileSync(file, "short-but-longer-now\n");
  const after = cache.getMap(file, loader);
  assert.strictEqual(loads, 2, "文件变了必须重新回源");
  assert.strictEqual(after.get("k").k, "2");
  cleanup(file);
});

test("invalidate 后下一次必定回源", () => {
  cache.reset();
  cache.setEnabled(true);
  const file = tmpFile("c.jsonl", "x\n");
  let loads = 0;
  const loader = () => { loads++; return new Map(); };

  cache.getMap(file, loader);
  cache.getMap(file, loader);
  assert.strictEqual(loads, 1, "写前应命中");

  cache.invalidate(file);
  cache.getMap(file, loader);
  assert.strictEqual(loads, 2, "invalidate 后必须回源");
  assert.strictEqual(cache.stats().invalidate, 1);
  cleanup(file);
});

test("超过上限时淘汰最久未使用的条目", () => {
  cache.reset();
  cache.setEnabled(true);
  // 上限压到很小，保证第二个条目就会触发淘汰
  cache.setLimitBytes(10);

  const f1 = tmpFile("d1.jsonl", "0123456789");   // 10 字节
  const f2 = tmpFile("d2.jsonl", "0123456789");
  const f3 = tmpFile("d3.jsonl", "0123456789");

  cache.getMap(f1, () => new Map([["1", {}]]));
  cache.getMap(f2, () => new Map([["2", {}]]));
  assert.ok(cache.stats().evict >= 1, "写入第二个条目后应发生淘汰");

  // f1 已被淘汰 ⇒ 再次访问必然回源
  let reloaded = false;
  cache.getMap(f1, () => { reloaded = true; return new Map(); });
  assert.strictEqual(reloaded, true, "被淘汰的条目应重新回源");

  const st = cache.stats();
  assert.ok(st.bytes <= st.limitBytes + 20, "驻留字节应回到上限附近（允许一条溢出）");
  cleanup(f1); cleanup(f2); cleanup(f3);
  cache.setLimitBytes(cache.DEFAULT_LIMIT_MB * 1024 * 1024);
});

test("关闭缓存后每次都回源（用于对照与排障）", () => {
  cache.reset();
  cache.setEnabled(false);
  const file = tmpFile("e.jsonl", "x\n");
  let loads = 0;
  const loader = () => { loads++; return new Map(); };

  cache.getMap(file, loader);
  cache.getMap(file, loader);
  assert.strictEqual(loads, 2, "关闭缓存时不得命中");
  assert.strictEqual(cache.stats().entries, 0, "关闭时不应留下条目");

  cache.setEnabled(true);
  cleanup(file);
});

test("文件不存在时不抛错、不登记条目", () => {
  cache.reset();
  cache.setEnabled(true);
  const missing = path.join(os.tmpdir(), "gal-idxcache-not-exist-" + Date.now(), "nope.jsonl");

  const got = cache.getMap(missing, () => new Map());
  assert.ok(got instanceof Map);
  assert.strictEqual(got.size, 0);
  assert.strictEqual(cache.stats().entries, 0, "不存在的文件不应被缓存");
});

test("loader 抛错时不污染缓存（下次仍会回源）", () => {
  cache.reset();
  cache.setEnabled(true);
  const file = tmpFile("f.jsonl", "x\n");
  let attempts = 0;

  assert.throws(() => {
    cache.getMap(file, () => { attempts++; throw new Error("boom"); });
  }, /boom/);
  cache.getMap(file, () => { attempts++; return new Map(); });
  assert.strictEqual(attempts, 2, "上次失败不应留下条目，必须再回源");
  cleanup(file);
});
