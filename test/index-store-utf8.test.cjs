// 回归测试：索引 JSONL 流式读取必须在「多字节字符跨 1MB 缓冲边界」时保持路径完好
//
// 背景（真实线上 bug，2026-10-15）：
//   三个流式读点原先写的是 `rest += buf.toString("utf8", 0, n)`。
//   1MB 读取缓冲若正好切在一个多字节 UTF-8 字符（例如「洛」= e6b49b 三个字节）中间，
//   两半会被分别解码 ⇒ 各得到一个替换字符 U+FFFD ⇒ 索引里的路径变成「[库\ufffd\ufffd]」。
//   后果：前端 im.path.startsWith(配置根) 匹配失败 ⇒ 该图被挂到 directories[0]（错误的根）
//   ⇒ 面包屑显示成绝对路径链。实测特征：鸣潮根 26275 张里只有 1 张中招（每个 1MB 边界最多坏一个字符）。
//
// 本用例的构造方式：把「库洛」放进条目路径，并让这几个字节正好落在 1MB 边界附近
//   （对偏移 -6..+6 逐个构造，覆盖「字符被边界切开」的每一种情形），
//   然后读回并断言：路径里既不能出现 U+FFFD，也不能丢掉「库洛」。
//   用旧实现（buf.toString 分块解码）跑，本用例会失败；用 StringDecoder 则全部通过。

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const store = require("../server/lib/index-store");

const CHUNK = 1 << 20; // 与 index-store.js 的读取缓冲一致
const CATEGORY = "__utf8_boundary_test__"; // 独立分类，避免碰到真实索引
const KEY = "kk";
const MARK = "库洛"; // 3 字节 UTF-8 字符，最容易被缓冲边界切开

function jsonlFile() {
  return path.join(store.categoryDir(CATEGORY), "index.jsonl");
}

/** 构造一份 JSONL：让 MARK 的起始字节落在 CHUNK 边界附近（off 为偏移量，单位字节） */
function writeFixture(off) {
  const header = JSON.stringify({ version: 1, category: CATEGORY });
  // 目标：MARK 的第一个字节的绝对偏移 = CHUNK + off
  // 行内容 = header + "\n" + entryLine + "\n"；entryLine 里 MARK 之前的前缀长度需要精确控制
  const entryPrefix = '{"k":"' + KEY + '","dir":"/volume6/x/[';
  const head = header + "\n" + entryPrefix;
  const padLen = CHUNK + off - Buffer.byteLength(head, "utf8");
  assert.ok(padLen >= 0, "构造偏移过小，无法把 MARK 推到边界");
  const dir = "/volume6/x/[" + "a".repeat(padLen) + MARK + "]/Wuthering Waves – 鸣潮";
  const entry = JSON.stringify({ k: KEY, dir, dirMtime: 1, items: [], images: [] });
  fs.mkdirSync(path.dirname(jsonlFile()), { recursive: true });
  fs.writeFileSync(jsonlFile(), header + "\n" + entry + "\n");
  return dir;
}

function cleanup() {
  try {
    fs.rmSync(store.categoryDir(CATEGORY), { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结论 */
  }
}

const results = [];
function ok(name, fn) {
  try {
    fn();
    results.push(["pass", name]);
  } catch (e) {
    results.push(["fail", name + " — " + e.message]);
  }
}

ok("readDirEntryJsonl：多字节字符跨 1MB 边界时路径不被解码坏", () => {
  for (let off = -6; off <= 6; off++) {
    const expect = writeFixture(off);
    const got = store.readDirEntryJsonl(CATEGORY, KEY);
    assert.ok(got, `偏移 ${off}：读不到条目`);
    assert.ok(!got.dir.includes("\uFFFD"), `偏移 ${off}：路径出现替换字符 U+FFFD（跨块解码坏了）`);
    assert.ok(got.dir.includes(MARK), `偏移 ${off}：路径丢了「${MARK}」`);
    assert.strictEqual(got.dir, expect, `偏移 ${off}：路径与写入不一致`);
  }
});

ok("loadAllJsonl：同一份文件流式载入后同样完好", () => {
  for (let off = -6; off <= 6; off++) {
    const expect = writeFixture(off);
    const map = store.loadAllJsonl(CATEGORY);
    const got = map.get(KEY);
    assert.ok(got, `偏移 ${off}：载入后拿不到条目`);
    assert.ok(!got.dir.includes("\uFFFD"), `偏移 ${off}：出现替换字符 U+FFFD`);
    assert.strictEqual(got.dir, expect, `偏移 ${off}：路径与写入不一致`);
  }
});

ok("upsertDirEntryJsonl：流式复制（逐行改写）后仍完好", () => {
  const expect = writeFixture(2);
  const entry = { dir: expect, dirMtime: 2, items: [], images: [] };
  store.upsertDirEntryJsonl(CATEGORY, KEY, entry); // 触发逐行复制 + 替换那一行
  const got = store.readDirEntryJsonl(CATEGORY, KEY);
  assert.ok(got, "改写后读不到条目");
  assert.ok(!got.dir.includes("\uFFFD"), "改写后出现替换字符 U+FFFD");
  assert.strictEqual(got.dir, expect, "改写后路径与写入不一致");
});

cleanup();

const failed = results.filter(([s]) => s === "fail");
for (const [s, name] of results) console.log(`  ${s === "pass" ? "ok  " : "FAIL"} - ${name}`);
console.log(`# tests ${results.length} # pass ${results.length - failed.length} # fail ${failed.length}`);
if (failed.length) process.exit(1);
