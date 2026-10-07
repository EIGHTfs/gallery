// ============================================================
// gbmd - 非热路径异步 IO 封装（P4）
// 热路径（downloader prepareMod/moveDirTo）留 sync，不经过本模块
// ============================================================
"use strict";

const fs = require("fs");
const fsp = fs.promises;

/**
 * 异步读取 JSON 文件，失败返回 fallback
 */
async function readJson(file, fallback) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch (_) {
    return fallback !== undefined ? fallback : null;
  }
}

/**
 * 异步写入 JSON 文件（自动建目录）
 */
async function writeJson(file, data) {
  const path = require("path");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data), "utf8");
}

/**
 * 异步检查文件是否存在
 */
async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 异步读取文本文件，失败返回 null
 */
async function readText(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (_) {
    return null;
  }
}

/**
 * 异步写入文本文件（自动建目录）
 */
async function writeText(file, txt) {
  const path = require("path");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, txt, "utf8");
}

/**
 * 异步读取目录条目
 */
async function readdir(file) {
  try {
    return await fsp.readdir(file);
  } catch (_) {
    return [];
  }
}

module.exports = { readJson, writeJson, exists, readText, writeText, readdir };
