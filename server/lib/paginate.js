// ============================================================
// 分页参数解析与切片（纯函数，零依赖）
//
// 为什么要单独抽出来：
//   分页参数一旦解析错（-1 / "abc" / 小数 / 超大 offset），
//   要么切出错的数据、要么把全量当成空返回 —— 这是最容易被"看起来正常"掩盖的 bug。
//   抽成纯函数就能用单测把每个边界钉死。
//
// 向后兼容约定（重要）：
//   limit 缺失 / 非数字 / ≤0  ⇒ 全量返回（与引入分页前完全一致）
//   只有显式传正的 limit 才真正分片；offset 单独传也生效（从第 N 条开始到结尾）
// ============================================================
"use strict";

/** 把查询值转成正整数；非法一律返回 0（0 在各处都表示"不限"） */
function toPositiveInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * 解析分页参数
 * @param {object} query 请求查询对象（可能为空/含字符串）
 * @returns {{limit:number, offset:number}} limit=0 表示不限
 */
function resolvePaging(query) {
  const q = query || {};
  return {
    limit: toPositiveInt(q.limit),
    offset: toPositiveInt(q.offset),
  };
}

/**
 * 按分页参数切一份列表；不改变入参
 * @param {Array} list 全量列表
 * @param {{limit:number, offset:number}} paging
 * @returns {Array} 切片结果（offset 超范围时返回空数组，不抛错）
 */
function slicePage(list, paging) {
  const arr = Array.isArray(list) ? list : [];
  const { limit, offset } = paging || { limit: 0, offset: 0 };
  if (!limit && !offset) return arr;                       // 常用路径：原样返回，零拷贝
  if (!limit) return arr.slice(offset);
  return arr.slice(offset, offset + limit);
}

module.exports = { toPositiveInt, resolvePaging, slicePage };
