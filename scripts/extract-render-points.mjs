#!/usr/bin/env node
/* scripts/extract-render-points.mjs —— 提取前端全部「渲染点」作为回归基准（零依赖）
 *
 * 为什么需要：
 *   本仓库发生过这类回归 —— 收藏路径末尾无条件 `render()`，而 render() 会 gallery.innerHTML="" 重建全部卡片，
 *   导致「点收藏 → 画廊回顶部」。这类 bug 的共性就是「某个处理函数里悄悄多了一个整体重建点」。
 *   把当前所有渲染点固化成基线文件后，任何新增/删除/搬家都会让
 *   test/render-points.test.cjs 失败 ⇒ 必须显式确认（并顺手检查是否又要重建导致位置丢失）。
 *
 * 用法：
 *   node scripts/extract-render-points.mjs                 # 打印当前渲染点（JSON）
 *   node scripts/extract-render-points.mjs --update        # 写入基线 test/render-points.baseline.json
 *   node scripts/extract-render-points.mjs --check         # 与基线比对（不一致退出码 1）
 *   node scripts/extract-render-points.mjs --root <dir>    # 指定项目根（默认脚本上级目录）
 *
 * 覆盖的渲染点类型见 PATTERNS；每条记录含：类型、所在函数、行号、该行内容。
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/** 渲染点类型 → 匹配规则（按顺序判断，命中即记一条） */
const PATTERNS = [
  { kind: "gallery-rebuild", re: /(^|[^.\w])render\s*\(\s*\)/, note: "整体重建画廊（gallery.innerHTML 清空后重铺）" },
  { kind: "gallery-clear", re: /gallery\.innerHTML\s*=\s*""/, note: "清空画廊 DOM" },
  { kind: "dirTree-render", re: /renderDirTree\s*\(\s*\)/, note: "重建侧边目录树" },
  { kind: "navBtns-render", re: /renderNavBtns\s*\(\s*\)/, note: "重建顶部导航按钮" },
  { kind: "breadcrumb-render", re: /renderBreadcrumb\s*\(/, note: "重建面包屑" },
  { kind: "lightbox-update", re: /updateLightbox\s*\(/, note: "更新 lightbox（不重建画廊）" },
];

/** 待扫描的前端产物（按存在性取第一个） */
const CANDIDATES = [
  "server/public/app.js",
  "templates/_gallery/js/app.js",
  "js/app.js",
];

function parseArgs(argv) {
  const out = { update: false, check: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") out.update = true;
    else if (a === "--check") out.check = true;
    else if (a === "--root") out.root = argv[++i] || null;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/** 从某行往上找最近的函数定义名（找不到记 "top-level"） */
function enclosingFunction(lines, idx) {
  for (let i = idx; i >= 0 && i > idx - 400; i--) {
    const m = lines[i].match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/);
    if (m) return m[1];
    const m2 = lines[i].match(/^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/);
    if (m2) return m2[1];
  }
  return "top-level";
}

/** 提取渲染点（返回按 kind/func/line 排序的数组，保证结果稳定可 diff） */
export function extractRenderPoints(root) {
  let file = null;
  for (const rel of CANDIDATES) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) { file = p; break; }
  }
  if (!file) throw new Error(`未找到前端产物，试过：${CANDIDATES.join(" / ")}`);
  const rel = path.relative(root, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const points = [];
  lines.forEach((line, i) => {
    if (/^\s*(?:(\/\/)|(\*))/.test(line)) return;          // 跳过注释行
    for (const pat of PATTERNS) {
      if (pat.re.test(line)) {
        points.push({
          kind: pat.kind,
          func: enclosingFunction(lines, i),
          line: i + 1,
          text: line.trim(),
        });
        break;                                              // 一行只记一次
      }
    }
  });
  points.sort((a, b) => (a.kind + a.func + a.line).localeCompare(b.kind + b.func + b.line));
  // 注意：file 用**路径无关**的标签、且不记录具体扫描路径，保证「模板树」与「下游项目树」
  // 生成的基线逐字节一致（这样基线可以被 assemble 映射 + parity 校验）
  return { file: "app.js", count: points.length, points };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法: node scripts/extract-render-points.mjs [--update|--check] [--root <dir>]");
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : path.resolve(HERE, "..");
  const cur = extractRenderPoints(root);
  const baselinePath = path.join(root, "test", "render-points.baseline.json");

  if (args.update) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(cur, null, 2) + "\n", "utf8");
    console.log(`✅ 已写入基线 ${path.relative(root, baselinePath)}（${cur.count} 个渲染点，扫描 ${cur.file}）`);
    return 0;
  }

  if (args.check) {
    if (!fs.existsSync(baselinePath)) {
      console.error(`✗ 基线不存在：${path.relative(root, baselinePath)}（先跑 --update）`);
      return 1;
    }
    const base = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const key = (p) => `${p.kind}|${p.func}|${p.text}`;
    const baseSet = new Set(base.points.map(key));
    const curSet = new Set(cur.points.map(key));
    const added = cur.points.filter((p) => !baseSet.has(key(p)));
    const removed = base.points.filter((p) => !curSet.has(key(p)));
    if (!added.length && !removed.length) {
      console.log(`✅ 渲染点与基线一致（${cur.count} 个，扫描 ${cur.file}）`);
      return 0;
    }
    if (added.length) {
      console.error("✗ 新增渲染点（可能导致重建/滚动位置丢失，确认无误后再更新基线）：");
      added.forEach((p) => console.error(`   + [${p.kind}] ${p.func}()  第 ${p.line} 行：${p.text}`));
    }
    if (removed.length) {
      console.error("✗ 渲染点消失（确认是有意删除）：");
      removed.forEach((p) => console.error(`   - [${p.kind}] ${p.func}()  第 ${p.line} 行：${p.text}`));
    }
    console.error(`   如确认改动合理：node scripts/extract-render-points.mjs --update`);
    return 1;
  }

  console.log(JSON.stringify(cur, null, 2));
  return 0;
}

// 直接执行时才走 main（被 import 时不执行）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) {
  process.exit(main());
}
