// JSON 目录存储：读/写/迁移运行态 JSON 文件
"use strict";

const fs = require("fs");
const path = require("path");

// DATA_DIR 通用；GBMD_DATA_DIR 为 gbmd 项目并入的专名（其测试用该变量指定数据目录），
// 模板统一兼容两者，项目不再保留第二份实现。
const SERVER_DIR = process.env.DATA_DIR || process.env.GBMD_DATA_DIR || path.join(__dirname, "..");
const JSON_DIR = path.join(SERVER_DIR, "..", "json");

function ensureJsonDir() {
  fs.mkdirSync(JSON_DIR, { recursive: true });
}

function jsonFile(name) {
  return path.join(JSON_DIR, name);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch (_) { return null; } // 文件不存在或损坏返回 null
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * 迁移旧位置的 JSON 文件到 json/ 目录。
 * @param {string} name 文件名
 * @returns {string} 目标路径
 */
function migrateRuntimeJson(name) {
  ensureJsonDir();
  const dest = jsonFile(name);
  if (fs.existsSync(dest)) return dest;

  const legacyPaths = [
    path.join(SERVER_DIR, name),
    path.join(SERVER_DIR, "json", name),
    path.join(SERVER_DIR, "..", name),
  ];

  for (const src of legacyPaths) {
    if (!src || src === dest || !fs.existsSync(src)) continue;
    try {
      fs.renameSync(src, dest);
      return dest;
    } catch (_) { /* 跨设备 rename 失败，尝试 copy */ }
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      return dest;
    } catch (_) { /* copy 也失败，跳过此路径 */ }
  }
  return dest;
}

module.exports = { SERVER_DIR, JSON_DIR, jsonFile, readJson, writeJson, ensureJsonDir, migrateRuntimeJson };
