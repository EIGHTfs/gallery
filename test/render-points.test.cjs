/* test/render-points.test.cjs —— 渲染点基线守卫（防「随手加重建点」这类回归）
 *
 * 防的回归类型：某个处理函数里悄悄多出一个整体重建点。
 * 已有实例：收藏路径末尾无条件 render()（render() 会 gallery.innerHTML="" 重建全部卡片）
 *           ⇒ 点收藏后画廊滚动位置被重置到顶部。
 *
 * 基线文件：test/render-points.baseline.json（由 scripts/extract-render-points.mjs --update 生成）
 * 基线不一致时的处理：先看清新增/删除的是哪个渲染点、是否会让位置/状态丢失；确认合理后再重生成基线。
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

/** 脚本位置：下游项目根 scripts/，或模板树里跑测试时的模板仓顶层 scripts/ */
function scriptPath() {
  const cands = [
    path.join(ROOT, "scripts", "extract-render-points.mjs"),
    path.join(ROOT, "..", "..", "scripts", "extract-render-points.mjs"),
  ];
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("未找到 scripts/extract-render-points.mjs");
}

test("渲染点与基线一致（新增/删除渲染点必须显式确认）", () => {
  const s = scriptPath();
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, [s, "--check", "--root", ROOT], { encoding: "utf8" });
  } catch (e) {
    code = typeof e.status === "number" ? e.status : 1;
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  assert.strictEqual(code, 0, `渲染点基线不一致：\n${out}`);
});

test("基线文件存在且含渲染点清单", () => {
  const p = path.join(ROOT, "test", "render-points.baseline.json");
  assert.ok(fs.existsSync(p), "缺少 test/render-points.baseline.json（先跑 scripts/extract-render-points.mjs --update）");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.ok(Array.isArray(j.points) && j.points.length > 0, "基线里没有渲染点");
});
