// HTML 片段组装器（框架层·通用）
// 两种模式：
//   1. 框架模式（推荐）：目录里一份「框架 html」（含 <!-- @frag:片段名 --> 注释指令），
//      组装时按指令把对应片段内容替换插入。片段可分布在子目录（如 tab-panel/）。
//   2. 数组模式（兼容旧部署）：pages 值为片段文件名数组，按顺序简单拼接。
// 支持 mtime 热更新：框架或任一片段改动后，下一次请求自动重拼，无需重启。
//
// 实测（6 片段 / 22KB）：命中缓存约 9µs，比每次读单个大文件（18µs）更快。
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 指令格式（HTML 注释 / CSS 注释两种都支持，片段名可带子目录）
//   <!-- @frag:topbar -->            HTML 框架
//   /* @frag:styles/variables.css */  CSS 框架
const FRAG_PATTERN = /(?:<!--|\/\*)\s*@frag:([^\s]+?)\s*(?:-->|\*\/)/;
// 品牌注释指令两种形态（组装时从品牌配置取项目特有值替换）：
//   注释形态（元素文本内，HTML/CSS）：<!-- @brand:key --> / /* @brand:key */
//   纯文本形态（属性值内，无 > 避免截断标签）：@brand:key@
const BRAND_PATTERN = /(?:<!--\s*@brand:([A-Za-z0-9_-]+?)\s*-->|\/\*\s*@brand:([A-Za-z0-9_-]+?)\s*\*\/|@brand:([A-Za-z0-9_-]+?)@)/g;
const MAX_NEST_DEPTH = 8; // 嵌套片段深度上限（防环）

// ---------- 模块级工具（不依赖组装器实例） ----------

function toAbs(dir, file) {
  return path.isAbsolute(file) ? file : path.join(dir, file);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/** 取一组文件的最大 mtime（相对 dir 解析）；任一缺失返回 -1 */
function maxMtime(dir, files) {
  let newest = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(toAbs(dir, f));
      if (!st.isFile()) return -1;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch (_) {
      return -1;
    }
  }
  return newest;
}

/** 生成「片段缺失/失败」占位注释：CSS 文件用块注释，其余用 HTML 注释，保证语法合法 */
function missedNote(dir, filePath, kind, name) {
  const isCss = String(filePath).toLowerCase().endsWith(".css");
  return isCss
    ? "/* " + kind + " @frag:" + name + " */"
    : "<!-- " + kind + " @frag:" + name + " -->";
}

/** 替换文本内所有 @brand:key 注释（g 正则共享 lastIndex，用前重置）。无 key 命中返回原文本。 */
function replaceBrandInText(text, brand) {
  if (!brand || !BRAND_PATTERN.test(text)) return text;
  BRAND_PATTERN.lastIndex = 0;
  let replaced = false;
  const out = text.replace(BRAND_PATTERN, (whole, k1, k2, k3) => {
    const key = k1 || k2 || k3;
    const v = brand[key];
    if (v === undefined) return whole;
    replaced = true;
    return String(v);
  });
  BRAND_PATTERN.lastIndex = 0;
  return replaced ? out : text;
}

// ---------- 本地资源自动版本化（防浏览器缓存） ----------
// 静态资源响应头 Cache-Control: public, max-age=3600——不带版本参数时浏览器
// 会缓存旧脚本/样式，前端改了不生效（实测踩坑：页面一直显示旧版）。
// 这里在装配 HTML 时自动给每个本地 .js / .css 引用加 ?v=<内容 md5 前 8 位>：
// 文件内容一变 → hash 变 → URL 变 → 浏览器自动拉新版。
// 模板/项目不用手写 ?v=，也不会出现「改了代码、忘了升版本」。
// 同时覆盖 <script src="*.js"> 与 <link href="*.css">：CSS 同样吃 max-age 缓存，
// 只给 JS 加版本号会让样式改动也踩缓存坑（此前项目层另有一份 mtime 版本号
// 覆盖逻辑，精度差、批量部署易失效，已删除，统一收敛到这里的 content-md5）。
const SCRIPT_SRC_PATTERN = /<(script\s+src|link\s+[^<]*href)=["']([^"']+?\.(?:js|css))(?:\?[^"']*)?["']/g;
function versionizeScripts(html, publicRoot, fragDir, files) {
  if (!publicRoot || html.indexOf("<") < 0) return html;
  return html.replace(SCRIPT_SRC_PATTERN, (whole, tag, src) => {
    if (/^(?:https?:)?\/\//.test(src) || /^(?:data|blob):/.test(src)) return whole; // 外链不动
    const p = toAbs(publicRoot, src);
    if (!isFile(p)) return whole; // 本地文件不存在则保持原样
    try {
      const hash = crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex").slice(0, 8);
      // 纳入缓存检测：资源 mtime 变化 → 缓存失效 → 重拼 → 新 hash
      if (files && files.indexOf(src) < 0) files.push(path.relative(fragDir, p));
      return '<' + tag + '="' + src + "?v=" + hash + '"';
    } catch (_) {
      return whole;
    }
  });
}

/** 展开单行指令：先查 @frag（片段替换），再查 @brand（品牌值替换）。
 * 品牌 key 缺失时保留原注释（不报错），由调用方决定是否提示。 */
function expandOneLine(dir, line, depth, files, filePath, brand) {
  const matched = FRAG_PATTERN.exec(line);
  if (!matched) {
    // 品牌替换：把行内所有 @brand:key 注释换成配置值
    if (brand) return { text: replaceBrandInText(line, brand), ok: true };
    return { text: line, ok: true };
  }
  const name = matched[1];
  // 带扩展名（.html/.css 等）按原名查找；无扩展名时补 .html
  const fname = /\.[a-z0-9]+$/i.test(name) ? name : name + ".html";
  const fragPath = toAbs(dir, fname);
  if (!isFile(fragPath)) {
    files.push(fname);
    return { text: missedNote(dir, filePath, "缺失片段", name), ok: false };
  }
  let fragText;
  try {
    fragText = fs.readFileSync(fragPath, "utf8").replace(/\r?\n$/, "");
  } catch (_) {
    files.push(fname);
    return { text: missedNote(dir, filePath, "读取失败", name), ok: false };
  }
  // 片段内还有指令 → 递归展开（超深度则按原文插入）
  if (depth < MAX_NEST_DEPTH && FRAG_PATTERN.test(fragText)) {
    const nested = expandFrags(dir, fragPath, depth + 1, brand);
    if (nested.error) return { text: missedNote(dir, filePath, "嵌套展开失败", name), ok: false };
    for (const f of nested.files) if (files.indexOf(f) < 0) files.push(f);
    return { text: nested.text.replace(/\r?\n$/, ""), ok: !nested.warning };
  }
  files.push(fname);
  // 片段内容无 @frag 时也要替换其内的 @brand 注释（如 head-extra/topbar 品牌区）
  return { text: replaceBrandInText(fragText, brand), ok: true };
}

/** 解析文件中的 @frag 指令（递归展开嵌套），返回 { text, files, warning? } */
function expandFrags(dir, filePath, depth, brand) {
  depth = depth || 0;
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return { error: "读取失败: " + (e && e.message), files: [filePath] };
  }
  const files = [path.relative(dir, filePath) || path.basename(filePath)];
  const lines = text.replace(/\r?\n$/, "").split("\n");
  let ok = true;
  for (let i = 0; i < lines.length; i++) {
    const r = expandOneLine(dir, lines[i], depth, files, filePath, brand);
    if (r.text !== lines[i]) lines[i] = r.text;
    if (!r.ok) ok = false;
  }
  const out = lines.join("\n") + "\n";
  return ok ? { text: out, files: files } : { text: out, files: files, warning: "存在缺失片段" };
}

/** 框架模式构建：读框架文件 → 展开指令 → 本地脚本自动版本化 */
function buildFromFramework(dir, spec, brand) {
  const fp = toAbs(dir, spec);
  if (!isFile(fp)) return { error: "框架文件缺失: " + spec };
  const out = expandFrags(dir, fp, 0, brand);
  if (out.error) return { error: out.error };
  // 本地脚本在片段目录的父目录（public/ 根）；files 纳入 js，脚本 mtime 变化即重拼
  out.text = versionizeScripts(out.text, path.dirname(dir), dir, out.files);
  return { text: out.text, files: out.files, warning: out.warning, mtime: maxMtime(dir, out.files) };
}

/** 数组模式构建：按列表顺序拼接 */
function buildFromList(dir, list) {
  const files = list.slice();
  const missing = files.filter((f) => !isFile(toAbs(dir, f)));
  if (missing.length) return { error: "片段缺失: " + missing.join(", ") };
  let text;
  try {
    text = files.map((f) => fs.readFileSync(toAbs(dir, f), "utf8")).join("\n");
  } catch (e) {
    return { error: "读取片段失败: " + (e && e.message) };
  }
  return { text: text, files: files, mtime: maxMtime(dir, files) };
}

// ---------- 组装器实例 ----------

/**
 * 创建片段组装器。
 * @param {object} opts
 * @param {string} opts.dir        片段目录（绝对路径；框架文件与片段都在其下）
 * @param {object} opts.pages      页面清单：
 *                                 值 = 字符串 → 框架模式（该文件含 @frag 指令）
 *                                 值 = 数组   → 数组模式（片段文件名列表）
 * @param {boolean} [opts.watch]   是否启用 mtime 检测（默认 true）
 * @param {object}  [opts.brand]   品牌配置 { key: value }；@brand:key 注释指令替换用
 * @returns {object} { render(name), invalidate(name), list(), labels() }
 */
function createFragmentAssembler(opts) {
  const dir = opts.dir;
  const pages = opts.pages || {};
  const watch = opts.watch !== false;
  const brand = opts.brand || null; // 品牌配置 { key: value }，@brand:key 指令替换用
  const cache = new Map(); // name → { text, files, mtime, warning }

  function build(name) {
    const spec = pages[name];
    if (!spec) return null;
    const built = typeof spec === "string" ? buildFromFramework(dir, spec, brand) : buildFromList(dir, spec);
    if (!built.error) cache.set(name, built);
    return built;
  }

  /** 缓存是否仍有效（mtime 未变） */
  function isFresh(hit) {
    const mtime = maxMtime(dir, hit.files);
    return mtime > 0 && mtime === hit.mtime;
  }

  /**
   * 渲染页面。watch 开启时按 mtime 判断是否需要重拼。
   * @returns {{ ok: boolean, text?: string, error?: string, warning?: string, rebuilt?: boolean }}
   */
  function render(name) {
    if (!pages[name]) return { ok: false, error: "未定义的页面: " + name };
    const hit = cache.get(name);
    if (hit && (!watch || isFresh(hit))) {
      return { ok: true, text: hit.text, rebuilt: false, warning: hit.warning };
    }
    const built = build(name);
    if (!built) return { ok: false, error: "未定义的页面: " + name };
    if (built.error) {
      // 重拼失败但有旧缓存 → 回退旧内容（不白屏）
      if (hit) return { ok: true, text: hit.text, rebuilt: false, warning: built.error };
      return { ok: false, error: built.error };
    }
    return { ok: true, text: built.text, rebuilt: true, warning: built.warning };
  }

  function invalidate(name) {
    if (name) cache.delete(name);
    else cache.clear();
  }

  function list() {
    return Object.keys(pages);
  }

  /** 页面 → 清单（供校验脚本使用） */
  function labels() {
    return JSON.parse(JSON.stringify(pages));
  }

  return { render, invalidate, list, labels };
}

module.exports = { createFragmentAssembler, expandFrags, FRAG_PATTERN };
