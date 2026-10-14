// test/media-cache-headers.test.cjs —— /api/media 的缓存头与条件请求（304）回归测试
//
// 背景（2026-10-14 实测故障）：图片接口原来只发 `Cache-Control: no-cache` 且**没有 ETag/Last-Modified**，
//   no-cache 的语义是「每次必须回源校验」，而没有校验器可校验 ⇒ 浏览器只能整份重新下载
//   ⇒ 表现为「每次刷新都要重新加载图片」。本测试锁住修复：有校验器、能 304、文件换了能失效。
//
// 纪律（test-design-norms）：零依赖、临时目录造夹具、不碰真实素材、不硬编码绝对路径。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const stream = require("node:stream");

const { streamFile } = require(path.join(__dirname, "..", "server", "lib", "util.js"));

/** 假 res：捕获 writeHead 的头与 body（真实模块调用，不 mock 被测函数） */
class FakeRes extends stream.Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this.body = Buffer.alloc(0);
  }
  writeHead(code, h) { this.statusCode = code; this.headers = h || {}; return this; }
  _write(chunk, enc, cb) { this.body = Buffer.concat([this.body, Buffer.from(chunk)]); cb(); }
}

function serve(file, reqHeaders, opts) {
  return new Promise((resolve) => {
    const res = new FakeRes();
    res.on("finish", () => resolve(res));
    streamFile(res, file, Object.assign({ reqHeaders: reqHeaders || {} }, opts || {}));
  });
}

function makeDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "gallery-cache-")); }
function makeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test("200 响应带 ETag / Last-Modified / max-age（有校验器浏览器才敢缓存）", async () => {
  const dir = makeDir();
  try {
    const f = makeFile(dir, "a.jpg", Buffer.alloc(2048, 7));
    const res = await serve(f);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers.ETag), /^".+"$/, "ETag 必须是带引号的字符串");
    assert.ok(res.headers["Last-Modified"], "必须有 Last-Modified");
    assert.match(String(res.headers["Cache-Control"]), /max-age=\d+/, "必须给出 max-age");
    assert.match(String(res.headers["Cache-Control"]), /public/, "按项目口径用 public（游客可读的浏览类接口）");
    assert.equal(res.headers["Content-Length"], 2048);
    assert.equal(res.body.length, 2048, "200 应回完整内容");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("If-None-Match 命中 ⇒ 304 且响应体为 0 字节（刷新零流量）", async () => {
  const dir = makeDir();
  try {
    const f = makeFile(dir, "b.jpg", Buffer.alloc(1024, 3));
    const first = await serve(f);
    const etag = first.headers.ETag;
    const second = await serve(f, { "if-none-match": etag });
    assert.equal(second.statusCode, 304);
    assert.equal(second.body.length, 0, "304 不得带响应体");
    assert.equal(second.headers.ETag, etag, "304 仍应回校验器");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("文件被替换（size/mtime 变）⇒ ETag 变 ⇒ 旧 ETag 不再命中", async () => {
  const dir = makeDir();
  try {
    const f = makeFile(dir, "c.jpg", Buffer.alloc(1024, 1));
    const first = await serve(f);
    const oldEtag = first.headers.ETag;
    fs.writeFileSync(f, Buffer.alloc(4096, 9));           // 换图（更长）
    const future = new Date(Date.now() + 60 * 1000);
    fs.utimesSync(f, future, future);                      // 明确推进 mtime，避免同秒内看不出变化
    const after = await serve(f);
    assert.notEqual(after.headers.ETag, oldEtag, "内容/时间变了 ETag 必须变");
    const stale = await serve(f, { "if-none-match": oldEtag });
    assert.equal(stale.statusCode, 200, "旧 ETag 必须失效（不能一直吃旧图）");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("If-None-Match: * ⇒ 304（RFC 语义）", async () => {
  const dir = makeDir();
  try {
    const f = makeFile(dir, "d.jpg", Buffer.alloc(256, 5));
    const res = await serve(f, { "if-none-match": "*" });
    assert.equal(res.statusCode, 304);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("弱校验（W/\"...\"）与逗号列表也能匹配", async () => {
  const dir = makeDir();
  try {
    const f = makeFile(dir, "e.jpg", Buffer.alloc(512, 2));
    const etag = (await serve(f)).headers.ETag;
    assert.equal((await serve(f, { "if-none-match": "W/" + etag })).statusCode, 304, "弱校验前缀应忽略");
    assert.equal((await serve(f, { "if-none-match": '"xxx", ' + etag })).statusCode, 304, "逗号列表里命中即可");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("If-Modified-Since 不早于 mtime ⇒ 304；早于则 200", async () => {
  const dir = makeDir();
  try {
    const f = makeFile(dir, "f.jpg", Buffer.alloc(128, 4));
    const lm = (await serve(f)).headers["Last-Modified"];
    assert.equal((await serve(f, { "if-modified-since": lm })).statusCode, 304);
    const old = new Date(Date.now() - 86400 * 1000).toUTCString();
    assert.equal((await serve(f, { "if-modified-since": old })).statusCode, 200);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("文件不存在 ⇒ 404（行为不变）", async () => {
  const dir = makeDir();
  try {
    const res = await serve(path.join(dir, "nope.jpg"));
    assert.equal(res.statusCode, 404);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("兼容旧签名（statusCode, headers 位置参数）—— 老调用点不受影响", async () => {
  const dir = makeDir();
  try {
    const f = makeFile(dir, "g.png", Buffer.alloc(64, 6));
    const res = await new Promise((resolve) => {
      const r = new FakeRes();
      r.on("finish", () => resolve(r));
      streamFile(r, f, 200, { "Content-Type": "image/png" });   // 旧签名
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Type"], "image/png");
    assert.ok(res.headers.ETag, "旧签名也应拿到新加的缓存头");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
