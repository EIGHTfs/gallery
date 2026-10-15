#!/usr/bin/env node
/**
 * scripts/scan-fs-hotspots.mjs —— 文件系统热点「静态」扫描（零依赖）
 *
 * 为什么要有它：实测遍历一次 26k 张图，进程 CPU 只占 15%、磁盘只读 ~12MB 元数据，
 * 85% 的时间花在「等 I/O」，且期间发生上千次阻塞式切换 —— 瓶颈是 **syscall 次数**（每个文件一次 stat、
 * 每个目录一次 readdir），不是 CPU、也不是磁盘吞吐。所以优化前必须先把「谁在遍历、遍历里 stat 了几次、
 * 哪些 stat 是重复的、同一条树被遍历了几遍」静态扫出来，避免凭感觉改。
 *
 * 用法：
 *   node scripts/scan-fs-hotspots.mjs [root] [--json] [--top N] [--include <子串>] [--exclude <子串>] [--include-tests]
 *   默认 root = 当前工作目录；默认跳过 node_modules/.git/dist/.trash 等。
 *   --include-tests：把 test/ 与 tests/ 一并纳入扫描（默认跳过）。
 *     用于核对「某函数是否真的没有调用者」——只看产品代码时，仅被测试调用的函数会被误判成死代码
 *     （实例：server/lib/scan.js::recursiveScanAll 被 test/scan-async.test.cjs 调用）。
 *
 * 输出五类判据（每条都给 文件:行 + 所属函数 + 原始表达式）：
 *   ① stat 热点   ：同一函数里 stat/lstat 调用次数 ≥ 阈值（默认 1，即列出全部，便于对照）
 *   ② 重复 stat   ：同一函数里**同一表达式**被 stat ≥2 次（可合并成一次）
 *   ③ 遍历者      ：函数里既有 readdir 又有自递归（或调用已知 walker）⇒ 典型 O(N) 遍历点
 *   ④ 遍历入口    ：recursiveScanAll / walkWithIndex / scanDirShallow / opendirSync 的调用点分布
 *   ⑤ 重复 readdir：同一函数里同一表达式被 readdir ≥2 次
 *
 * 退出码：恒为 0（咨询性工具，不拦提交）。需要门禁时由调用方读 --json 自行判断。
 */

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "release", ".trash", ".auto-update-tmp", "cache-index", "cache-gifs", "test", "tests", "__pycache__"]);
// 这些目录默认跳过，但属于「可放行」集合：加 --include-tests 时照常扫描
// （用途：核对某个函数是否真的没有调用者 —— 只看产品代码会漏掉仅被测试调用的函数）
const TEST_DIRS = new Set(["test", "tests"]);
const EXTS = new Set([".js", ".mjs", ".cjs"]);
const WALKERS = ["recursiveScanAll", "walkWithIndex", "scanDirShallow", "recursiveScan", "walkDir"];

/** 命令行参数 */
function parseArgs(argv) {
  const out = { root: null, json: false, top: 30, includes: [], excludes: [], includeTests: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--top") out.top = parseInt(argv[++i], 10) || 30;
    else if (a === "--include") out.includes.push(argv[++i]);
    else if (a === "--exclude") out.excludes.push(argv[++i]);
    else if (a === "--include-tests") out.includeTests = true;
    else if (!a.startsWith("--") && !out.root) out.root = a;
  }
  out.root = path.resolve(out.root || process.cwd());
  return out;
}

/** 递归收集待扫文件（跳过依赖/产物/测试夹具目录） */
function collectFiles(root, opts) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (opts.excludes.some((s) => rel.includes(s))) continue;
      if (e.isDirectory()) {
        // test/ 与 tests/ 默认跳过（它们是夹具，不是产品代码）；
        // 但跳过会让「只被测试调用的函数」看起来没有调用者 —— 曾据此把 scan.js::recursiveScanAll
        // 误判成死代码。核对「是否真的没有调用者」时加 --include-tests 把这些目录纳入扫描。
        const isTestDir = TEST_DIRS.has(e.name);
        if (SKIP_DIRS.has(e.name) && !(opts.includeTests && isTestDir)) continue;
        walk(full);
      } else if (e.isFile() && EXTS.has(path.extname(e.name))) {
        if (opts.includes.length && !opts.includes.some((s) => rel.includes(s))) continue;
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

const CALL_RE = {
  stat: /(?<![\w.])(?:fs\.)?(statSync|lstatSync|stat)\s*\(/g,
  readdir: /(?<![\w.])(?:fs\.)?(readdirSync|opendirSync|readdir)\s*\(/g,
};
const FUNC_RE = /(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?function\s*\(|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>/g;

/** 取括号内的参数文本（简单配对，够用；不处理字符串里的括号极端情况） */
function argText(line, openIdx) {
  let depth = 0;
  let out = "";
  for (let i = openIdx; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") { depth++; if (depth === 1) continue; }
    if (ch === ")") { depth--; if (depth === 0) break; }
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** 扫一个文件：按行扫，用「函数起始行」粗略归属所属函数（够定位用） */
function scanFile(file, root) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return null; }
  const lines = text.split("\n");
  const rel = path.relative(root, file);
  const findings = { file: rel, stats: [], readdirs: [], dupStats: [], dupReaddirs: [], walkers: [], scanners: [] };
  let currentFn = "(module)";
  const perFnStats = new Map();     // fn -> Map(expr -> [lines])
  const perFnReaddir = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    // 更新当前函数（只看行首缩进较浅的定义，避免把内联回调当函数边界）
    FUNC_RE.lastIndex = 0;
    let m;
    while ((m = FUNC_RE.exec(line)) !== null) {
      const name = m[1] || m[2] || m[3];
      if (name) currentFn = name;
    }
    for (const [kind, re] of Object.entries(CALL_RE)) {
      re.lastIndex = 0;
      let c;
      while ((c = re.exec(line)) !== null) {
        const openIdx = c.index + c[0].length - 1;
        const expr = argText(line, openIdx);
        const rec = { fn: currentFn, line: lineNo, api: c[1], expr };
        if (kind === "stat") {
          findings.stats.push(rec);
          if (!perFnStats.has(currentFn)) perFnStats.set(currentFn, new Map());
          const map = perFnStats.get(currentFn);
          if (!map.has(expr)) map.set(expr, []);
          map.get(expr).push(lineNo);
        } else {
          findings.readdirs.push(rec);
          if (!perFnReaddir.has(currentFn)) perFnReaddir.set(currentFn, new Map());
          const map = perFnReaddir.get(currentFn);
          if (!map.has(expr)) map.set(expr, []);
          map.get(expr).push(lineNo);
        }
      }
    }
    // 遍历者：函数体内出现 readdir，且出现自递归或已知 walker 调用
    for (const w of WALKERS) {
      if (new RegExp(`\\b${w}\\s*\\(`).test(line) && w !== currentFn) {
        findings.walkers.push({ fn: currentFn, line: lineNo, calls: w });
      }
    }
  }
  // 重复项
  for (const [fn, map] of perFnStats) {
    for (const [expr, ls] of map) if (ls.length >= 2 && expr) findings.dupStats.push({ fn, expr, lines: ls });
  }
  for (const [fn, map] of perFnReaddir) {
    for (const [expr, ls] of map) if (ls.length >= 2 && expr) findings.dupReaddirs.push({ fn, expr, lines: ls });
  }
  // 扫描实现（跨函数重复的判据）：同一函数里既 readdir 又 stat ⇒ 一个「逐文件扫描」实现。
  // 这类函数越多，说明「同一件事」被实现了多遍（例如索引遍历 / 单层扫描 / 压缩包扫描各一套）——
  // 真正的重复往往是**跨函数/跨文件**的，函数内表达式去重抓不到（实测 0 处），所以必须有这条。
  for (const fn of perFnStats.keys()) {
    if (!perFnReaddir.has(fn)) continue;
    const statCount = Array.from(perFnStats.get(fn).values()).reduce((s, a) => s + a.length, 0);
    const readdirCount = Array.from(perFnReaddir.get(fn).values()).reduce((s, a) => s + a.length, 0);
    findings.scanners.push({ fn, stats: statCount, readdirs: readdirCount });
  }
  return findings;
}

function main() {
  const opts = parseArgs(process.argv);
  const files = collectFiles(opts.root, opts);
  const results = files.map((f) => scanFile(f, opts.root)).filter(Boolean);

  const totals = { files: files.length, stats: 0, readdirs: 0, dupStats: 0, dupReaddirs: 0, walkerCalls: 0 };
  for (const r of results) {
    totals.stats += r.stats.length;
    totals.readdirs += r.readdirs.length;
    totals.dupStats += r.dupStats.length;
    totals.dupReaddirs += r.dupReaddirs.length;
    totals.walkerCalls += r.walkers.length;
  }
  // 按 stat 次数排序（热点文件）
  const hot = results
    .map((r) => ({ file: r.file, stats: r.stats.length, readdirs: r.readdirs.length, dupStats: r.dupStats.length }))
    .filter((x) => x.stats || x.readdirs)
    .sort((a, b) => b.stats - a.stats || b.readdirs - a.readdirs)
    .slice(0, opts.top);

  const dupStats = results.flatMap((r) => r.dupStats.map((d) => ({ file: r.file, ...d })));
  const dupReaddirs = results.flatMap((r) => r.dupReaddirs.map((d) => ({ file: r.file, ...d })));
  const walkerCalls = results.flatMap((r) => r.walkers.map((w) => ({ file: r.file, ...w })));

  if (opts.json) {
    process.stdout.write(JSON.stringify({ root: opts.root, totals, hot, dupStats, dupReaddirs, walkerCalls }, null, 2) + "\n");
    return;
  }

  console.log(`FS 热点静态扫描：${opts.root}`);
  console.log(`  扫描文件 ${totals.files} 个 ｜ stat 调用点 ${totals.stats} ｜ readdir 调用点 ${totals.readdirs}`);
  console.log(`  重复 stat（同函数同表达式）${totals.dupStats} 处 ｜ 重复 readdir ${totals.dupReaddirs} 处 ｜ walker 调用点 ${totals.walkerCalls}`);
  console.log("\n── ① 热点文件（按 stat 调用点数排序）──");
  for (const h of hot) console.log(`  ${String(h.stats).padStart(3)} stat  ${String(h.readdirs).padStart(2)} readdir  ${h.file}`);
  console.log("\n── ② 重复 stat（可合并成一次）──");
  if (!dupStats.length) console.log("  （无）");
  for (const d of dupStats.slice(0, opts.top)) console.log(`  ${d.file}  ${d.fn}()  表达式「${d.expr}」被 stat ${d.lines.length} 次（行 ${d.lines.join(",")}）`);
  console.log("\n── ③ 重复 readdir ──");
  if (!dupReaddirs.length) console.log("  （无）");
  for (const d of dupReaddirs.slice(0, opts.top)) console.log(`  ${d.file}  ${d.fn}()  表达式「${d.expr}」被 readdir ${d.lines.length} 次（行 ${d.lines.join(",")}）`);
  console.log("\n── ④ 遍历入口（walker 调用点：同一棵树被走几遍看这里）──");
  if (!walkerCalls.length) console.log("  （无）");
  for (const w of walkerCalls.slice(0, opts.top)) console.log(`  ${w.file}:${w.line}  ${w.fn}() → ${w.calls}()`);

  // ⑥ 逐文件扫描实现（跨函数重复的判据）：函数内既有 readdir 又有 stat ⇒ 一个扫描实现。
  //    这类实现越多，越可能对同一批目录各扫一遍（优化时应合并到同一个索引/缓存上）。
  const scanners = results.flatMap((r) => r.scanners.map((s) => ({ file: r.file, ...s })))
    .sort((a, b) => (b.stats + b.readdirs) - (a.stats + a.readdirs));
  console.log("\n── ⑥ 逐文件扫描实现（readdir + stat 同时出现在同一函数 ⇒ 一个扫描器）──");
  if (!scanners.length) console.log("  （无）");
  for (const s of scanners.slice(0, opts.top)) {
    console.log(`  ${s.file}  ${s.fn}()  stat×${s.stats} readdir×${s.readdirs}`);
  }
  console.log(`  ⇒ 共 ${scanners.length} 个扫描实现；若 >1，说明「逐文件取属性」这件事被实现了多遍（各自独立遍历）。`);
}

main();
