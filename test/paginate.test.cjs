// ============================================================
// paginate 单测：分页参数解析与切片
//
// 重点钉住的边界：非法 limit 必须退化成「全量」，而不是「返回空」——
// 后者会让页面看起来正常但一张图都没有，是最难排查的一类回归。
// ============================================================
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const P = require(path.join(__dirname, "..", "server", "lib", "paginate.js"));

const LIST = Array.from({ length: 12 }, (_, i) => i + 1);

test("toPositiveInt：只接受正整数，其余一律 0（0 = 不限）", () => {
  assert.strictEqual(P.toPositiveInt("5"), 5);
  assert.strictEqual(P.toPositiveInt(5), 5);
  assert.strictEqual(P.toPositiveInt("5.9"), 5, "小数向下取整");
  assert.strictEqual(P.toPositiveInt(-1), 0);
  assert.strictEqual(P.toPositiveInt(0), 0);
  assert.strictEqual(P.toPositiveInt("abc"), 0);
  assert.strictEqual(P.toPositiveInt(undefined), 0);
  assert.strictEqual(P.toPositiveInt(null), 0);
  assert.strictEqual(P.toPositiveInt(NaN), 0);
  assert.strictEqual(P.toPositiveInt(Infinity), 0, "Infinity 视为非法");
});

test("resolvePaging：缺省全为 0（= 全量），显式传值才生效", () => {
  assert.deepStrictEqual(P.resolvePaging(undefined), { limit: 0, offset: 0 });
  assert.deepStrictEqual(P.resolvePaging({}), { limit: 0, offset: 0 });
  assert.deepStrictEqual(P.resolvePaging({ limit: "200" }), { limit: 200, offset: 0 });
  assert.deepStrictEqual(P.resolvePaging({ limit: "200", offset: "20" }), { limit: 200, offset: 20 });
  assert.deepStrictEqual(P.resolvePaging({ limit: "-5" }), { limit: 0, offset: 0 }, "非法 limit 退化为全量");
});

test("slicePage：不传 limit/offset 时原样返回（同一引用，零拷贝）", () => {
  const out = P.slicePage(LIST, { limit: 0, offset: 0 });
  assert.strictEqual(out, LIST, "全量路径应直接返回入参，不做拷贝");
});

test("slicePage：limit 单独生效", () => {
  assert.deepStrictEqual(P.slicePage(LIST, { limit: 5, offset: 0 }), [1, 2, 3, 4, 5]);
});

test("slicePage：offset + limit 取中段", () => {
  assert.deepStrictEqual(P.slicePage(LIST, { limit: 5, offset: 5 }), [6, 7, 8, 9, 10]);
});

test("slicePage：只给 offset 时取到结尾", () => {
  assert.deepStrictEqual(P.slicePage(LIST, { limit: 0, offset: 10 }), [11, 12]);
});

test("slicePage：offset 超范围返回空数组，不抛错", () => {
  assert.deepStrictEqual(P.slicePage(LIST, { limit: 5, offset: 999 }), []);
});

test("slicePage：limit 超过剩余长度时只到结尾", () => {
  assert.deepStrictEqual(P.slicePage(LIST, { limit: 100, offset: 8 }), [9, 10, 11, 12]);
});

test("slicePage：入参不是数组时返回空数组（不抛错）", () => {
  assert.deepStrictEqual(P.slicePage(null, { limit: 5, offset: 0 }), []);
  assert.deepStrictEqual(P.slicePage(undefined, { limit: 0, offset: 0 }), []);
  assert.deepStrictEqual(P.slicePage("abc", { limit: 5, offset: 0 }), []);
});

test("slicePage：不修改入参", () => {
  const src = [1, 2, 3, 4];
  P.slicePage(src, { limit: 2, offset: 1 });
  assert.deepStrictEqual(src, [1, 2, 3, 4]);
});
