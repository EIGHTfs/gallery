// ============================================================
// 框架统一出口
// ============================================================
"use strict";

const { createConfig } = require("../config/config-loader.js");
const { createServer, DEFAULT_MIME, createFragmentAssembler } = require("./app");
const { createRoute, groupRoutes } = require("../route/route-factory.js");
const { sendJson, readBody, parseCredentialText, cleanCookie } = require("../http/http-utils.js");
const fsAsync = require("../http/fs-async.js");
const htmlUtils = require("../http/html-utils.js");
const appLog = require("./app-log");
const jsonDir = require("../store/json-dir.js");
const auth = require("../auth/auth.js");
const routesAuth = require("../route/routes-auth.js");
const { createBackup } = require("../store/data-backup.js");
const { createAutoUpdate } = require("../update/auto-update.js");
const markerManifest = require("../store/marker-manifest.js");
const pathSafe = require("../http/path-safe.js");

module.exports = {
  // 核心
  createConfig,
  createServer,
  createRoute,
  groupRoutes,
  createBackup,
  createAutoUpdate,
  createFragmentAssembler,
  markerManifest,
  DEFAULT_MIME,

  // 工具
  sendJson,
  readBody,
  parseCredentialText,
  cleanCookie,

  // 模块
  fsAsync,
  htmlUtils,
  appLog,
  jsonDir,
  auth,
  routesAuth,
  pathSafe,
};
