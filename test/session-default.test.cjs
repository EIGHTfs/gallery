// test/session-default.test.cjs —— gallery 会话时长机制的回归保护
//
// 背景（2026-10-14 实测定位）：
//   gallery 的登录界面**没有**「记住此设备」勾选框（设计如此，默认就一直记住），
//   所以登录请求里不带 remember，服务端 routes-auth.js 的 hoursFor(body) 会走
//   `c.sessionHours || 72` 这一支。也就是说「一直记住」**必须靠 gallery 自己的
//   配置默认值**保证：sessionHours = 720（30 天）。
//   实测故障证据：部署端 14 条会话里 12 条只有 72h（3 天），表现为「记住时间更短」。
//
// 本测试锁住这个默认值：一旦有人把它改回 72（或改小），此处失败，避免旧病复发。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const { createConfig } = require(path.join(ROOT, "server", "config", "config-loader.js"));
const schema = require(path.join(ROOT, "server", "config.schema.json"));

test("gallery 默认会话时长是 720h（30 天）—— 不依赖前端传 remember", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-cfg-"));
  try {
    // configFile 指向不存在的文件 ⇒ 全部取 schema 默认值（等价于部署端未设置时的情形）
    const cfg = createConfig({ configFile: path.join(tmp, "config.json"), schema });
    const v = cfg.readConfig();
    assert.equal(
      v.sessionHours,
      720,
      "gallery 的 sessionHours 必须是 720（30 天）：登录界面无「记住此设备」勾选框，" +
        "不会传 remember，服务端只能靠这个默认值实现「一直记住」"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
