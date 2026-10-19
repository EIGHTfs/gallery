// ============================================================
// 索引内存缓存：按「文件 mtime + 毫秒 + size」失效的 LRU
//
// 为什么需要：索引读路径（readDirEntryJsonl / loadAllJsonl）此前每次调用
//   都从磁盘重读整份文件 —— 大分类索引达 94MB / 2 万余行，同一份数据被
//   每个请求反复扫盘并重新解析，热态仍要 1.5s 量级。
//
// 作用域：只在进程内有效，不落盘。进程重启后首次访问仍会读盘（预期行为）。
//
// 失效键：mtime + size 两者都要。
//   只用 mtime 不够：同一毫秒/秒内多次改写时 mtime 可能不变，会读到旧内容；
//   带上 size 能覆盖「行数变化」这类最常见的索引写入。
//
// 上限：按文件字节数估算占用，超限后淘汰最久未使用的条目。
//   上限与开关都来自环境变量，不写死在调用处：
//     GALLERY_INDEX_CACHE=0     关闭缓存（全部走原读盘路径，用于对照与排障）
//     GALLERY_INDEX_CACHE_MB=N  上限（MB，默认 128）
//
// 并发：Node 单线程 + 同步读，getMap 内部没有 await 间隙，
//   同一个文件不会被两个请求重复回源。
// ============================================================
"use strict";

const fs = require("fs");

const DEFAULT_LIMIT_MB = 128;

/** 缓存条目：file -> { mtimeMs, size, map, bytes } */
const cache = new Map();
const counters = { hit: 0, miss: 0, stale: 0, evict: 0, invalidate: 0 };

function envEnabled() {
  const v = process.env.GALLERY_INDEX_CACHE;
  return v !== "0" && v !== "false";
}

function envLimitBytes() {
  const mb = Number(process.env.GALLERY_INDEX_CACHE_MB);
  const n = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_LIMIT_MB;
  return Math.round(n * 1024 * 1024);
}

let enabled = envEnabled();
let limitBytes = envLimitBytes();

/** 文件指纹；文件不存在返回 null（不缓存不存在的文件） */
function fingerprint(file) {
  try {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (_) {
    return null;
  }
}

function totalBytes() {
  let n = 0;
  for (const v of cache.values()) n += v.bytes || 0;
  return n;
}

/** 淘汰最久未使用的条目，直到回到上限内；至少保留一条，避免超大文件永远无法缓存 */
function evictIfNeeded() {
  while (cache.size > 1 && totalBytes() > limitBytes) {
    const oldestKey = cache.keys().next().value;
    const item = cache.get(oldestKey);
    cache.delete(oldestKey);
    counters.evict++;
    if (!item) break;
  }
}

/**
 * 取某个文件的 Map 视图；命中直接返回，未命中调用 loader 读盘并登记。
 * @param {string} file 索引文件绝对路径
 * @param {() => Map} loader 未命中时的读盘实现（原逻辑，保持行为不变）
 * @returns {Map}
 */
function getMap(file, loader) {
  if (!enabled) return loader();
  const fp = fingerprint(file);
  const hit = cache.get(file);
  if (hit && fp && hit.mtimeMs === fp.mtimeMs && hit.size === fp.size) {
    // 命中：移到队尾，维持「最近使用在最后」的 LRU 顺序
    cache.delete(file);
    cache.set(file, hit);
    counters.hit++;
    return hit.map;
  }
  if (hit) counters.stale++;
  counters.miss++;
  const map = loader();
  if (fp) {
    cache.delete(file);
    cache.set(file, { mtimeMs: fp.mtimeMs, size: fp.size, map, bytes: fp.size });
    evictIfNeeded();
  }
  return map;
}

/** 写路径调用：写入完成后让该文件的缓存立刻失效 */
function invalidate(file) {
  if (cache.delete(file)) counters.invalidate++;
}

function stats() {
  return Object.assign({}, counters, {
    entries: cache.size,
    bytes: totalBytes(),
    limitBytes: limitBytes,
    enabled: enabled,
  });
}

/** 供调用方判断是否走「整份载入」的快路径；关闭缓存时应保留各自的原读盘实现 */
function isEnabled() {
  return enabled;
}

function setEnabled(v) {
  enabled = !!v;
  if (!enabled) cache.clear();
}

function setLimitBytes(n) {
  limitBytes = Math.max(1, Math.round(Number(n) || 0));
  evictIfNeeded();
}

function reset() {
  cache.clear();
  counters.hit = 0;
  counters.miss = 0;
  counters.stale = 0;
  counters.evict = 0;
  counters.invalidate = 0;
}

module.exports = {
  DEFAULT_LIMIT_MB,
  fingerprint,
  getMap,
  invalidate,
  stats,
  isEnabled,
  setEnabled,
  setLimitBytes,
  reset,
};
