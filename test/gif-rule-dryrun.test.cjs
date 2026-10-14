/* test/gif-rule-dryrun.test.cjs —— GIF 合成规则 dry-run 回归（不跑 ffmpeg，只验「会不会合成、按哪条规则、要不要翻转」）
 *
 * 背景：合成判定曾散在前端（shell/tree.js）与后端（lib/gif.js）两处，且「目录内编号连续就合成」
 * 把 卡面 这类数字编号图集（489 张）误合成为一个 GIF。规则已抽到唯一实现
 * server/lib/rule/gif-rule.js，本测试即对它的决策表做回归（dry-run：只判定，不动文件、不起进程）。
 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const R = require(path.join(__dirname, "..", "server", "lib", "rule", "gif-rule.js"));

/** 造 n 张「前缀+补零数字+扩展名」序列帧名 */
function frames(n, prefix = "frame_", ext = ".png") {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(3, "0")}${ext}`);
}
/** 卡面式命名（编号连续但语义上是不同卡片，不是动画帧） */
const CARD_LIKE = Array.from({ length: 5 }, (_, i) => `tex_support_card_${10001 + i}.png`);

test("dry-run：目录一律不合成（口径：只认压缩包 / ini）", () => {
  assert.strictEqual(R.shouldSynthDir(), false, "目录不应合成 GIF");
});

test("dry-run：压缩包命中 mod 规则（含 .ini 且 $speed>0）→ 合成、翻转", () => {
  const d = R.shouldSynthZip({ names: frames(4), packageName: "某mod", hasIni: true, speed: 0.5 });
  assert.strictEqual(d.synth, true);
  assert.strictEqual(d.rule, "mod");
  assert.strictEqual(d.flip, true, "mod 需 180° 翻转");
});

test("dry-run：压缩包命中图包规则（包名带间隔）→ 按间隔合成、不翻转", () => {
  const d = R.shouldSynthZip({ names: frames(3), packageName: "pixiv 图包@40ms", hasIni: false, speed: 0 });
  assert.strictEqual(d.synth, true);
  assert.strictEqual(d.rule, "imagePack");
  assert.strictEqual(d.flip, false, "图包不翻转");
  assert.strictEqual(d.frameMs, 40, "帧间隔应取自包名");
});

test("dry-run：两条规则都不命中 → 不合成", () => {
  // 卡面式数字编号（本次事故的形态）
  assert.strictEqual(R.shouldSynthZip({ names: CARD_LIKE, packageName: "卡面", hasIni: false, speed: 0 }).synth, false);
  // 只有一张图
  assert.strictEqual(R.shouldSynthZip({ names: ["only.png"], packageName: "单个", hasIni: false, speed: 0 }).synth, false);
  // 非序列命名
  assert.strictEqual(R.shouldSynthZip({ names: ["a.png", "b.png", "c.png"], packageName: "杂图", hasIni: false, speed: 0 }).synth, false);
  // 含 ini 但 $speed=0（不可换算）
  assert.strictEqual(R.shouldSynthZip({ names: frames(3), packageName: "mod", hasIni: true, speed: 0 }).synth, false);
});

test("dry-run：边界 —— 2 张不算序列帧、3 张算、断号取最长连续段", () => {
  assert.strictEqual(R.detectFrames(frames(2)).length, 0, "2 张不应算序列帧");
  assert.strictEqual(R.detectFrames(frames(3)).length, 3);
  const gap = ["f_001.png", "f_002.png", "f_004.png", "f_005.png", "f_006.png"];
  assert.strictEqual(R.detectFrames(gap).length, 3, "应取 004-006 这段最长的连续段");
});

test("dry-run：两条具名规则各自的前置条件（缺一项即不成立）", () => {
  assert.strictEqual(R.modGifRule({ names: frames(3), hasIni: true, speed: 0 }).synth, false, "mod 缺 $speed");
  assert.strictEqual(R.modGifRule({ names: frames(3), hasIni: false, speed: 1 }).synth, false, "mod 缺 ini");
  assert.strictEqual(R.imagePackGifRule({ names: frames(3), packageName: "无间隔包名" }).synth, false, "图包缺间隔");
  assert.strictEqual(R.parseFrameMs("2s"), 2000, "2s → 2000ms");
  assert.strictEqual(R.parseFrameMs("500ms"), 500, "500ms → 500ms");
});
