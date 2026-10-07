// 配置加载器（schema 驱动）
// 项目只需传 schema（字段名/类型/默认值），框架负责加载/保存/校验。
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCRYPT_KEY_LEN = 64;

function readRawFile(configFile) {
  try { return JSON.parse(fs.readFileSync(configFile, "utf-8")); }
  catch (_) { return {}; }
}

function writeRawFile(configFile, obj) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function mergeDefaults(raw, schema) {
  const out = {};
  for (const [key, def] of Object.entries(schema)) {
    out[key] = raw[key] !== undefined ? raw[key] : def.default;
  }
  for (const [key, val] of Object.entries(raw)) {
    if (!(key in out)) out[key] = val;
  }
  return out;
}

/**
 * 创建配置管理器。
 * @param {object} opts
 * @param {string} opts.configFile 配置文件路径（绝对路径）
 * @param {object} opts.schema 字段 schema
 */
function createConfig(opts) {
  const { configFile, schema } = opts;

  return {
    readConfig() { return mergeDefaults(readRawFile(configFile), schema); },

    writeConfig(patch) {
      const raw = readRawFile(configFile);
      Object.assign(raw, patch);
      writeRawFile(configFile, raw);
    },

    get(field) { return mergeDefaults(readRawFile(configFile), schema)[field]; },

    setPassword(pwd) {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(pwd, salt, SCRYPT_KEY_LEN).toString("hex");
      this.writeConfig({ passwordHash: hash, passwordSalt: salt });
    },

    verifyPassword(pwd) {
      const raw = readRawFile(configFile);
      if (!raw.passwordHash || !raw.passwordSalt) return false;
      const hash = crypto.scryptSync(pwd, raw.passwordSalt, SCRYPT_KEY_LEN).toString("hex");
      return hash === raw.passwordHash;
    },

    configFile,
    schema,
  };
}

module.exports = { createConfig };
