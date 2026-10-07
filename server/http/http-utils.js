// HTTP 工具（框架层）
// sendJson：统一 JSON 响应（sendJson(res, data, status)）
// readBody：流式读请求体（落临时文件，防大 body OOM）
// parseCredentialText / cleanCookie：cookie 清洗
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const BODY_SIZE_LIMIT = 10 * 1024 * 1024;
const RADIX_36 = 36;

function sendJson(res, obj, status) {
  if (typeof obj === "number") { const tmp = obj; obj = status; status = tmp; }
  const code = status || 200;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit = BODY_SIZE_LIMIT) {
  // 已读过（createRoute 预读后 handler 再次调用）直接复用结果：
  // 请求流只能消费一次，二次读会永远等不到 end 事件导致请求挂死。
  if (req._bodyCache !== undefined) return Promise.resolve(req._bodyCache);
  if (req._bodyPromise) return req._bodyPromise;

  req._bodyPromise = new Promise((resolve, reject) => {
    const tmpName = "dl-body-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(RADIX_36).slice(2);
    const tmpPath = path.join(os.tmpdir(), tmpName);
    const ws = fs.createWriteStream(tmpPath);
    let size = 0;
    let settled = false;
    let draining = false;

    const cleanup = () => fs.unlink(tmpPath, () => {});
    const fail = (err) => {
      if (settled) return;
      settled = true;
      ws.destroy();
      cleanup();
      reject(err);
    };

    ws.on("error", fail);

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        ws.destroy();
        cleanup();
        req.destroy();
        reject(new Error("请求体过大"));
        return;
      }
      const ok = ws.write(chunk);
      if (!ok && !draining) {
        draining = true;
        req.pause();
        ws.once("drain", () => { draining = false; req.resume(); });
      }
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      ws.end(() => {
        fs.readFile(tmpPath, "utf8", (err, data) => {
          cleanup();
          if (err) return reject(err);
          try {
            const parsed = data ? JSON.parse(data) : {};
            req._bodyCache = parsed;
            resolve(parsed);
          } catch (_) {
            reject(new Error("无效的 JSON"));
          }
        });
      });
    });

    req.on("error", fail);
  });
  return req._bodyPromise;
}

/**
 * 解析油猴脚本自动复制的组合凭证文本：
 *   Cookie=...\nToken=...\nAccessToken=...
 * 返回 { cookie, token, accessToken }，未命中的字段为 null；
 * 若文本不含任何组合字段行，返回 null（视为纯 Cookie 串）。
 *
 * 字段支持取各项目并集：
 *   - Cookie      两项目通用
 *   - Token       iwara 刷新令牌
 *   - AccessToken iwara 访问令牌
 * 只用 Cookie 的项目（gbmd）拿到的 cookie 值与原来一致，多出的字段为 null。
 */
function parseCredentialText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const keys = ["Cookie", "Token", "AccessToken"];
  const get = (key) => {
    const line = text.split(/\r?\n/).find((l) => l.startsWith(key + "="));
    if (!line) return null;
    return line.slice(key.length + 1).trim();
  };
  const hit = new RegExp("(^|\\n)(" + keys.join("|") + ")=").test("\n" + text);
  if (!hit) return null; // 不是组合文本
  const out = {};
  for (const k of keys) {
    const v = get(k);
    out[k === "Cookie" ? "cookie" : k === "Token" ? "token" : "accessToken"] = v;
  }
  return out;
}

function cleanCookie(raw) {
  if (raw === undefined || raw === null) return "";
  const str = String(raw).trim();
  if (!str) return "";
  const combo = parseCredentialText(str);
  if (combo) return combo.cookie || "";
  if (str.startsWith("{")) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed.cookie === "string") return parsed.cookie.trim();
    } catch (_) { /* JSON 解析失败，回退返回原始字符串 */ }
  }
  return str;
}

module.exports = { sendJson, readBody, parseCredentialText, cleanCookie };
