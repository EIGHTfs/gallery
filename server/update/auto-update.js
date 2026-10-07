// ============================================================
// 自动更新（框架层 · 通用）：零依赖文件监控 + 优雅重启 + GitHub 拉取
//
// 用户场景：开发机改完代码 → 推送 GitHub → 服务端自动拉取 + 重启
//   不需要每次手动同步代码重启。
//
// 三种模式：
//   1. watch 模式（默认）：监控 server/ 目录文件变更 → 防抖后重启
//   2. git 模式（可选）：定时 git pull → 有变更则重启
//   3. github 模式（2026-09-07 新增）：定时从 GitHub 拉取更新，
//      不需要服务端有 .git（裸目录部署也能用）
//
// 实现要点：
//   - 零依赖（Node.js 内置 fs / https / child_process）
//   - 防抖 2 秒（连续保存不反复重启）
//   - 优雅关停（当前下载任务标记 paused，等重启后 resume）
//   - 配置可控（config autoUpdate: { enabled, mode, interval, githubRepo, ... }）
//
// 通用化（2026-09-16）：从 gbmd 提取，项目差异全部参数化：
//   - githubRepo / githubBranch / githubToken：从 cfg.autoUpdate 读取
//     （缺省用 DEFAULT_REPO，创建实例时可传项目默认仓库覆盖）
//   - User-Agent：跟随项目名（默认 auto-update，可传 projectName 覆盖）
//   - GITHUB_EXCLUDE：运行态数据文件按项目配置追加（createAutoUpdate 第二个参数）
//   - 启动入口：createAutoUpdate(opts)（opts.projectName / defaultRepo / extraExclude）
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, execSync } = require("child_process");
// require-sibling 自举：定位同框架内的兄弟模块（不受本文件落点影响）。
//
// 历史：早期 framework/ 是平铺的，本文件可能放 framework/ 也可能被拼到 lib/，
// 于是靠 try 同目录、catch 向上找 "../framework" 兜底。
// 现在 framework/ 按功能分子目录（core/route/http/store/...），兄弟模块既不同级、
// 也不在祖先链上（本文件在 update/，marker-manifest 在 store/），故改为：
// 按已知相对路径逐个试，再用祖先链兜底——无论本文件落在哪都能找到。
function _findRequireSibling() {
  const direct = [
    "../http/require-sibling.js",              // framework/<子目录>/ → framework/http/
    "./require-sibling.js",                    // 同目录（整体拷到 lib/ 时）
    "../require-sibling.js",                   // lib/ → 旁边
    "../framework/http/require-sibling.js",    // 上一层的 framework/ 里
    "../framework/require-sibling.js",         // 上一层 framework/ 平铺版
  ];
  for (const p of direct) {
    try { return require(p); } catch (_) { /* 试下一个 */ }
  }
  // 祖先链兜底：从本文件目录逐级向上，找 require-sibling.js 或 <dir>/http/require-sibling.js
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    for (const rel of ["require-sibling.js", path.join("http", "require-sibling.js")]) {
      const cand = path.join(dir, rel);
      try { if (fs.existsSync(cand)) return require(cand); } catch (_) { /* 继续 */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("auto-update: 找不到 require-sibling.js（framework 目录结构可能已变更）");
}

const { requireUp } = _findRequireSibling();

// 候选目录：向上找到 framework 根，把它的各子目录与自身目录都作为候选。
// 按名找模块时逐个试，故框架内部再调整子目录布局也不必改这里。
function _frameworkSearchDirs() {
  const dirs = [__dirname];
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (_) { names = []; }
    // 认定 framework 根：含这些特征子目录的那一层
    if (names.includes("core") || names.includes("route") || names.includes("http")) {
      for (const n of names) dirs.push(path.join(dir, n));
      dirs.push(dir);
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dirs;
}

const { manifestPaths } = requireUp(__dirname, "marker-manifest.js", {
  dirs: _frameworkSearchDirs(),
});

// tree-copy：安全树复制 + 排除规则共享实现（auto-update 与 apply-staged-update.cjs 共用）
const { createTreeCopier } = requireUp(__dirname, "tree-copy.js", {
  dirs: _frameworkSearchDirs(),
});

// 平台兼容开关：win32 由 Node 运行时自动识别（Windows 文件锁 → 暂存式更新）；
// AUTO_UPDATE_FORCE_STAGED=1 强制走暂存分支（Linux 测试/模拟用，可验暂存→apply 全链路）。
function isWinCompat() {
  return process.platform === "win32" || process.env.AUTO_UPDATE_FORCE_STAGED === "1";
}

/**
 * 创建 auto-update 实例（框架层统一入口）。
 * @param {object} opts
 * @param {string} opts.projectName     项目显示名（User-Agent / 日志前缀，如 "gamebanana-mods-downloader"）
 * @param {string} opts.defaultRepo     缺省 GitHub 仓库（如 "owner/repo"，config 可覆盖）
 * @param {string[]} [opts.extraExclude] 追加运行态数据文件（相对项目根，如 ["json/xxx.json"]）
 * @param {string[]} [opts.extraChmodScripts] 追加需恢复可执行位的脚本（相对项目根）
 * @param {string} [opts.pidFileName]   PID 文件名（缺省 = 项目根目录名.pid）
 */
function createAutoUpdate(opts) { // dsh-skip-func-length 既有超长工厂函数（约 540 行），本文件多处已有 dsh-skip-quality 豁免，待专项重构拆分
  const projectName = (opts && opts.projectName) || "auto-update";
  const defaultRepo = (opts && opts.defaultRepo) || "";
  const extraExclude = (opts && opts.extraExclude) || [];
  const extraChmodScripts = (opts && opts.extraChmodScripts) || [];

  // 本文件位于服务端一级子目录（lib/ 或 framework/），上一级即 server/
  const SERVER_DIR = path.join(__dirname, "..");
  const ROOT_DIR = path.join(SERVER_DIR, "..");
  const PID_FILE = path.join(ROOT_DIR, (opts && opts.pidFileName) || path.basename(ROOT_DIR) + ".pid");
  // github 模式状态文件（记录上次应用的 commit sha，不入库）
  const STATE_FILE = path.join(ROOT_DIR, ".auto-update-state.json");

  // ── 间隔与失败退避（2026-10-08）──────────────────────────────
  // 各模式默认间隔（秒）。watch 是文件事件驱动，不需要间隔 → null；
  // git 是本地 git pull（成本极低）→ 300；github 每次要打一次 GitHub API（有配额），
  // 而绝大多数项目每天推送不超过 3 次、5 分钟一轮 99% 是白跑 → 默认 1 小时（3600）。
  const DEFAULT_INTERVAL_SEC = { watch: null, git: 300, github: 3600 };
  const INTERVAL_MIN_SEC = 30;      // 下限：防止误填 1 秒把 GitHub 打爆
  const INTERVAL_MAX_SEC = 86400;   // 上限：1 天
  const BACKOFF_MAX_STEPS = 3;      // 连续失败最多回避 3 次（1h→2h→4h→8h，之后维持 8h）

  /** 规范检查间隔：缺省/非法 → 取该模式默认值；有效值夹到 [INTERVAL_MIN_SEC, INTERVAL_MAX_SEC] */
  function normInterval(cfg, mode) {
    const def = DEFAULT_INTERVAL_SEC[mode];
    if (def === null) return null;                       // watch：不需要间隔
    const raw = cfg ? cfg.interval : undefined;
    if (raw === undefined || raw === null || raw === "" || isNaN(Number(raw))) return def;
    return Math.min(Math.max(Math.floor(Number(raw)), INTERVAL_MIN_SEC), INTERVAL_MAX_SEC);
  }

  /**
   * 连续失败时的实际间隔（毫秒）= 设定值 × 2^min(连续失败次数, BACKOFF_MAX_STEPS)。
   * 以 base=3600s 为例：失败 1 次→7200s、2 次→14400s、3 次→28800s，之后维持 28800s；
   * 任意一次成功即把失败连击归零、立即回到 base。手动「立即检查」不计入连击。
   */
  function intervalMsWithBackoff(baseSec, failStreak) {
    const steps = Math.min(Math.max(failStreak, 0), BACKOFF_MAX_STEPS);
    return baseSec * Math.pow(2, steps) * 1000;
  }

  // github 模式下禁止覆盖的运行态/敏感文件（相对项目根，前缀或精确匹配）
  // 排除规则分三类（isExcluded 按类匹配，避免「以 . 开头一律当后缀」的误判）：
  const GITHUB_EXCLUDE = [
    // 运行态配置（含密码/gbCookie/下载路径，本机权威，绝不覆盖）
    "server/config.json",
    // 启停入口：重启依赖它们，被远端旧版覆盖会导致「重启变关闭」
    "start.sh",
    "start-linux.sh",
    "start-macos.sh",
    "start-windows.bat",
    // server/boot.cjs 原也在此列（怕被远端旧版覆盖导致起不来）。2026-10-08 移出：
    // 它是零依赖启动器，权威源在本模板（清单 src → server/boot.cjs），继续排除会让它的修复
    // （进程级 uncaughtException/unhandledRejection 兜底）永远进不到部署端。
    // 安全性：更新是「先落盘校验 → 再重启」，boot.cjs 在重启时才被加载，写坏也只会落到下一轮。
    "server/setup.sh",
    // 运行态索引/任务/会话
    "json/index",
    "json/sessions.json",
    "json/download_task.json",
    "json/search_cache.json",
    "json/search_task.json",
    "json/userdata-manifest.json",
    // 测试日志目录 / 本模式状态文件
    "test/logs",
    ".auto-update-state.json"
  ].concat(extraExclude);
  // 任意层级目录名（系统元数据 / 依赖 / 构建产物 / 本模式临时目录）
  const GITHUB_EXCLUDE_DIR = ["@eaDir", "node_modules", "_test-download", "dist", "release", ".auto-update-tmp"];
  // 后缀规则（日志 / PID / 备份残留）
  const GITHUB_EXCLUDE_SUFFIX = [".log", ".pid", ".bak"];

  // 树复制器（共享实现）：排除清单快照进闭包，动态清单（userdata-manifest）按需加载。
  // 注意：GITHUB_EXCLUDE 在此之后不能再被重新赋值（构造时已引用原数组），
  //   后续若需追加排除项请直接改上方数组定义。
  const treeCopier = createTreeCopier({
    rootDir: ROOT_DIR,
    excludePaths: GITHUB_EXCLUDE,
    excludeDirs: GITHUB_EXCLUDE_DIR,
    excludeSuffix: GITHUB_EXCLUDE_SUFFIX,
    loadExtraExcludes: () => loadUserdataExcludes(),
    onSkip: (rel) => _log("跳过(排除): " + rel),
  });

  let watcher = null;
  let debounceTimer = null;
  let gitInterval = null;
  let githubInterval = null;
  let restarting = false;
  let _onRestart = null;
  let _onStatus = null;
  // 应用更新期间的 watch 挂起标记：copyTreeSafe 逐文件写盘会逐个触发 watch，
  //   导致日志刷屏，且最后一次写入与重启之间没有静置时间（重启紧贴写盘末尾）。
  let applying = false;
  // 优雅关停钩子：由 app.js 注入，返回 Promise，等待在途 HTTP 响应写完再退出。
  let _onShutdown = null;
  // github 模式最近一次检查结果（内存态，供 /api/auto-update/check 与前端展示）
  let lastCheck = null;

  /** 启动监控 */
  function start(cfg, onRestart, onStatus) {
    _onRestart = onRestart;
    _onStatus = onStatus;
    stop(); // 先清旧
    if (!cfg || !cfg.enabled) {
      _log("autoUpdate 未启用");
      return { enabled: false };
    }
    const mode = cfg.mode || "watch";
    _log(`autoUpdate 启动: mode=${mode}`);
    if (mode === "git") {
      startGitWatch(cfg);
    } else if (mode === "github") {
      startGitHubWatch(cfg);
    } else {
      startFileWatch();
    }
    return { enabled: true, mode, interval: normInterval(cfg, mode) };
  }

  /** 停止监控 */
  function stop() {
    if (watcher) { try { watcher.close(); } catch (_) {} watcher = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    // 两者现在都是「递归 setTimeout」的句柄（退避要动态间隔，setInterval 固定间隔做不到）
    if (gitInterval) { clearTimeout(gitInterval); gitInterval = null; }
    if (githubInterval) { clearTimeout(githubInterval); githubInterval = null; }
    restarting = false;
  }

  /**
   * 变更是否应触发重启。
   *
   * 不该触发重启的三类：
   *   1. 运行态数据文件——由源码注释自动汇总（写文件处标注 //runtime-manifest.json 注释，见 marker-manifest.js），
   *      避免清单与代码脱节：业务运行时频繁写这些文件，触发重启会导致「登录一次重启一次」
   *   2. public/fragments/ HTML 片段——由 fragment-assembler 按 mtime 热更新，
   *      改片段刷新即生效，重启反而打断下载任务
   *   3. 项目通过 extraWatchExclude 追加的路径
   */
  let runtimePaths = [];
  try {
    runtimePaths = manifestPaths({
      root: ROOT_DIR,
      json: "runtime-manifest.json",
      scanDirs: ["server"],
    });
  } catch (e) {
    _log("运行态清单扫描失败（仅用内置规则）: " + (e && e.message));
  }
  const extraWatchExclude = (opts && opts.extraWatchExclude) || [];

  // 清单里的基线文件名集合（fs.watch 回调常只给文件名，需按名匹配）
  const runtimeBasenames = new Set(runtimePaths.map((r) => String(r).replace(/\\/g, "/").split("/").pop()));

  function shouldRestartFor(filename) {
    if (!filename) return false;
    if (!/\.(js|cjs|html|css|json)$/i.test(filename)) return false;
    const p = String(filename).replace(/\\/g, "/");
    if (p.startsWith("json/")) return false;
    if (p.includes("public/fragments/") || p.startsWith("fragments/")) return false;

    // 运行态清单（源码注释自动生成）
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (runtimeBasenames.has(base)) return false;
    for (const rel of runtimePaths) {
      const r = String(rel).replace(/\\/g, "/").replace(/\/+$/, "");
      if (p === r || p.startsWith(r + "/")) return false;
    }

    // 导入导出用户数据清单（userdata-manifest.json 标记的运行态）：watch 也不重启
    // 覆盖 json/ 之外的运行态目录（avatar / server/thumbs 等）
    for (const rel of loadUserdataExcludes()) {
      const r = String(rel).replace(/\\/g, "/").replace(/\/+$/, "");
      if (p === r || p.startsWith(r + "/")) return false;
    }

    if (extraWatchExclude.some((rule) => p === rule || p.endsWith("/" + rule) || p.startsWith(rule + "/"))) return false;
    return true;
  }

  /** watch 模式：监控 server/ 目录文件变更 */
  function startFileWatch() {
    watcher = fs.watch(SERVER_DIR, { recursive: false }, (event, filename) => {
      if (applying) return; // 应用更新自身写盘触发的变更，不是用户改动，忽略
      if (!shouldRestartFor(filename)) return;
      _log(`检测到变更: ${filename}`);
      scheduleRestart();
    });
    // 递归监控 server/ 子目录（routes/ lib/ utils/ public/ services/）
    for (const sub of ["routes", "lib", "utils", "services", "public"]) {
      watchRecursive(path.join(SERVER_DIR, sub));
    }
  }

  function watchRecursive(dir) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
      fs.watch(dir, { recursive: true }, (event, filename) => {
        if (applying) return; // 应用更新自身写盘触发的变更，不是用户改动，忽略
      if (!shouldRestartFor(filename)) return;
        _log(`检测到变更: ${filename}`);
        scheduleRestart();
      });
    } catch (_) { /* 目录不存在 */ }
  }

  /** git 模式：定时 git pull → 有变更则重启（连续失败按设定值 ×2 退避，最多 3 次） */
  function startGitWatch(cfg) {
    const baseSec = normInterval(cfg, "git");
    let failStreak = 0;

    /** 用递归 setTimeout 排下一轮（setInterval 间隔固定，承载不了动态退避） */
    function scheduleNext() {
      if (gitInterval) { clearTimeout(gitInterval); gitInterval = null; }
      const delay = intervalMsWithBackoff(baseSec, failStreak);
      if (failStreak > 0) _log(`git 检查连续失败 ${failStreak} 次，${Math.round(delay / 1000)}s 后再试`);
      gitInterval = setTimeout(doGitPull, delay);
    }

    function doGitPull() {
      if (restarting) { scheduleNext(); return; }   // 重启中不计失败，按当前档位排下一轮
      let failed = false;
      try {
        const before = execSync("git rev-parse HEAD", { cwd: ROOT_DIR, timeout: 5000 }).toString().trim();
        execSync("git pull --ff-only", { cwd: ROOT_DIR, timeout: 30000 });
        const after = execSync("git rev-parse HEAD", { cwd: ROOT_DIR, timeout: 5000 }).toString().trim();
        if (before !== after) {
          _log(`git pull 检测到更新: ${before.slice(0, 8)} → ${after.slice(0, 8)}`);
          scheduleRestart();
        }
      } catch (e) {
        failed = true;
        _log("git pull 失败: " + (e.message || String(e)).slice(0, 100));
      }
      failStreak = failed ? failStreak + 1 : 0;      // 成功即归零，立即回到基础间隔
      scheduleNext();
    }

    doGitPull(); // 首次立即执行
  }

  /** github 模式：定时检查 GitHub 更新（连续失败按设定值 ×2 退避，最多 3 次） */
  function startGitHubWatch(cfg) {
    const baseSec = normInterval(cfg, "github");
    let failStreak = 0;

    /** 用递归 setTimeout 排下一轮（退避要动态间隔，setInterval 固定间隔做不到） */
    function scheduleNext() {
      if (githubInterval) { clearTimeout(githubInterval); githubInterval = null; }
      const delay = intervalMsWithBackoff(baseSec, failStreak);
      if (failStreak > 0) _log(`github 检查连续失败 ${failStreak} 次，${Math.round(delay / 1000)}s 后再试`);
      githubInterval = setTimeout(doCheck, delay);
    }

    function doCheck() {
      const settle = () => {
        const r = (lastCheck && lastCheck.result) || "error";
        if (r === "error") failStreak += 1;                        // 失败 → 下一轮翻倍退避
        else if (r !== "skip" && r !== "baseline") failStreak = 0;  // 成功 → 立即回到基础间隔
        scheduleNext();
      };
      const p = checkGitHubUpdate(cfg);
      if (p && typeof p.then === "function") p.then(settle, settle);
      else settle();   // 同步返回的分支（重启中 / 未配置 githubRepo）
    }

    doCheck(); // 首次立即检查
  }

  /** 检查一次 GitHub 更新（可被 /api/auto-update/check 手动触发，结果记录到 lastCheck） */
  function checkGitHubUpdate(cfg) {
    if (restarting) {
      _log("github 检查跳过：正在重启中");
      lastCheck = { time: Date.now(), result: "skip", message: "正在重启中，跳过检查" };
      return;
    }
    const repo = (cfg && cfg.githubRepo) || defaultRepo;
    const branch = (cfg && cfg.githubBranch) || "main";
    const token = (cfg && cfg.githubToken) || "";
    if (!repo) {
      lastCheck = { time: Date.now(), result: "error", message: "未配置 githubRepo" };
      _log("github 模式检查更新: 未配置 githubRepo");
      return;
    }
    _log(`github 模式检查更新: ${repo}@${branch}`);
    const state = readState();
    // 返回这个 Promise：定时调度器要等异步链路落定后才统计成功/失败（退避依据）；
    // 手动触发路径（路由）仍按 lastCheck 轮询取结果，故此改动对既有调用方透明。
    return getGitHubLatest(repo, branch, token).then((latest) => {
      if (!latest || !latest.sha) {
        lastCheck = { time: Date.now(), result: "error", message: "查询 GitHub 失败（无返回）" };
        return;
      }
      const newSha = latest.sha;
      const newDate = latest.committedAt || "";

      // 首次运行（无状态文件）：只建立基线，不应用更新、不重启。
      // 此时无法判断本机与远端谁新——若按 sha 比较会把「无记录」误判为有新版本，
      // 导致启动即全量覆盖代码并重启（覆盖 start.sh/boot.cjs 时会让服务起不来）。
      if (!state.lastSha && !state.lastCommitDate) {
        saveState({ lastSha: newSha, lastCommitDate: newDate, updatedAt: Date.now() });
        const msg = `首次运行，已记录基线版本 ${newSha.slice(0, 8)}${newDate ? "（" + fmtDateCn(newDate) + " 北京时间）" : ""}，不执行更新`;
        _log(msg);
        lastCheck = { time: Date.now(), result: "baseline", message: msg, latestSha: newSha, latestCommitDate: newDate };
        return;
      }

      // 判新：优先按提交时间比较（直观、不怕分叉/远端回退——时间更早或相同不拉取）；
      // 旧状态文件没有 lastCommitDate 时降级为 sha 比较，保证兼容。
      let isNew;
      if (state.lastCommitDate && newDate) {
        isNew = Date.parse(newDate) > Date.parse(state.lastCommitDate);
      } else {
        isNew = state.lastSha !== newSha;
      }
      if (!isNew) {
        const msg = `已是最新（本地 ${fmtVersion(state)} vs 远端 ${newSha.slice(0, 8)} ${fmtDateCn(newDate)}，北京时间）`;
        _log(`github 无新版本（本地 ${fmtVersion(state)} vs 远端 ${newSha.slice(0, 8)}${newDate ? " " + fmtDateCn(newDate) : ""}，北京时间）`);
        lastCheck = { time: Date.now(), result: "latest", message: msg, latestSha: newSha, latestCommitDate: newDate };
        // 兼容升级：旧状态只有 lastSha 无 lastCommitDate，补记一次以便下次用时间比较
        if (!state.lastCommitDate && state.lastSha === newSha) {
          saveState({ lastSha: newSha, lastCommitDate: newDate || "", updatedAt: Date.now() });
        }
        return;
      }
      _log(`github 检测到新版本: ${fmtVersion(state)} → ${newSha.slice(0, 8)}${newDate ? " (" + fmtDateCn(newDate) + " 北京时间)" : ""}`);
      applyGitHubUpdate(repo, branch, token, newSha).then(() => {
        saveState({ lastSha: newSha, lastCommitDate: newDate, updatedAt: Date.now() });
        const msg = `已更新到 ${newSha.slice(0, 8)}（${fmtDateCn(newDate)} 北京时间），2 秒后重启`;
        _log("github 代码已更新，2 秒后重启");
        lastCheck = { time: Date.now(), result: "updated", message: msg, latestSha: newSha, latestCommitDate: newDate };
        scheduleRestart();
      }).catch((e) => {
        lastCheck = { time: Date.now(), result: "error", message: "更新应用失败: " + (e && e.message || String(e)).slice(0, 200) };
        _log("github 更新应用失败: " + (e && e.message || String(e)).slice(0, 200));
      });
    }).catch((e) => {
      lastCheck = { time: Date.now(), result: "error", message: "检查失败: " + (e && e.message || String(e)).slice(0, 200) };
      _log("github 检查失败: " + (e && e.message || String(e)).slice(0, 200));
    });
  }

  /** 状态版本的可读描述（提交时间统一北京时间，否则退回 sha 前缀） */
  function fmtVersion(state) {
    if (state.lastCommitDate) return fmtDateCn(state.lastCommitDate);
    return state.lastSha ? state.lastSha.slice(0, 8) : "无";
  }

  /** ISO 时间 → 北京时间（UTC+8）"YYYY-MM-DD HH:mm"，固定时区不随服务器/浏览器变化 */
  function fmtDateCn(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const bj = new Date(d.getTime() + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
  }

  /** 查仓库指定分支最新 commit 的 sha + 提交时间（api.github.com Commits API） */
  function getGitHubLatest(repo, branch, token) {
    const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`;
    const headers = {
      "User-Agent": projectName,
      "Accept": "application/vnd.github+json"
    };
    if (token) headers["Authorization"] = "token " + token;
    return httpsGet(url, headers).then((buf) => {
      try {
        const j = JSON.parse(buf.toString("utf8"));
        if (!j || !j.sha) return null;
        const date = j.commit && j.commit.committer && j.commit.committer.date;
        return { sha: j.sha, committedAt: (date && String(date)) || "" };
      } catch (_) { return null; }
    });
  }

  /** 查仓库指定分支最新 commit sha（api.github.com Git Data API） */
  function getGitHubRefSha(repo, branch, token) {
    const url = `https://api.github.com/repos/${repo}/git/ref/heads/${branch}`;
    const headers = {
      "User-Agent": projectName,
      "Accept": "application/vnd.github+json"
    };
    if (token) headers["Authorization"] = "token " + token;
    return httpsGet(url, headers).then((buf) => {
      try {
        const j = JSON.parse(buf.toString("utf8"));
        return j && j.object && j.object.sha ? j.object.sha : null;
      } catch (_) { return null; }
    });
  }

  /** 下载 tarball → 解压 → 安全复制到项目根
   *  sha 形式 URL（/tar.gz/<sha>）按 commit 寻址、内容不可变，避免分支形式
   *  （/tar.gz/refs/heads/<branch>）在推送后 CDN 缓存未刷新时拉到旧包；失败回退分支形式 */
  function applyGitHubUpdate(repo, branch, token, sha) {
    // 复制期间挂起 watch：逐文件写盘会各自触发一次变更事件（日志刷屏），
    //   且最后一次写盘与重启之间没有静置时间。这里整体标记，写完再清除。
    applying = true;
    const done = () => { applying = false; };
    const tmpDir = path.join(ROOT_DIR, ".auto-update-tmp");
    const tgzPath = path.join(tmpDir, "repo.tar.gz");
    const extractDir = path.join(tmpDir, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    const shaUrl = `https://codeload.github.com/${repo}/tar.gz/${sha}`;
    const branchUrl = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
    const headers = { "User-Agent": projectName, "Accept": "application/octet-stream" };
    if (token) headers["Authorization"] = "token " + token;
    const fetchTar = (url) => httpsGet(url, headers).then((buf) => {
      fs.writeFileSync(tgzPath, buf);
      return buf;
    });
    return fetchTar(shaUrl).catch(() => fetchTar(branchUrl)).then((buf) => {
      _log(`tarball 下载完成: ${buf.length} bytes`);
      // 解压（strip 顶层 <repo>-<sha>/ 目录）
      const tar = findTar();
      execSync(`"${tar}" -xzf "${tgzPath}" -C "${extractDir}" --strip-components=1`, { timeout: 60000 });
      _log("tarball 解压完成");
      if (isWinCompat()) {
        // Windows 暂存式更新：运行中的服务锁定已加载文件，在线覆盖会 EPERM。
        // 解压目录整体改名到 .auto-update-staged/<sha>，写 pending 标记，
        // 触发 start-windows.bat restart；bat 停旧进程后由
        // apply-staged-update.cjs 应用覆盖（此时无锁）再拉起新进程。
        const stagedDir = path.join(ROOT_DIR, ".auto-update-staged", sha);
        try { fs.rmSync(stagedDir, { recursive: true, force: true }); } catch (_) {}
        fs.mkdirSync(path.dirname(stagedDir), { recursive: true }); // 父目录 .auto-update-staged/ 可能不存在
        fs.renameSync(extractDir, stagedDir);
        fs.writeFileSync(path.join(ROOT_DIR, ".auto-update-pending.json"), JSON.stringify({
          sha,
          repo,
          branch,
          time: Date.now(),
          excludePaths: GITHUB_EXCLUDE,
          excludeDirs: GITHUB_EXCLUDE_DIR,
          excludeSuffix: GITHUB_EXCLUDE_SUFFIX,
        }, null, 2), "utf8");
        _log(`暂存更新完成 ${sha.slice(0, 8)}，触发 start-windows.bat restart 应用`);
        // 只清理 tmp 残留（tgz 包），保留 staged 目录与 pending 标记
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        return;
      }
      // 安全复制：覆盖/新增代码，绝不触碰运行态与敏感文件，也不删除目标多余文件
      copyTreeSafe(extractDir, ROOT_DIR);
      // 恢复脚本可执行位（git 模式不需要，tarball 里 *.sh 可能是 644）
      chmodScripts(ROOT_DIR);
      // 清理临时目录
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }).then((v) => { done(); return v; }, (e) => { done(); throw e; });
  }

  /** 找到系统 tar（github 模式解压用） */
  function findTar() {
    if (isWinCompat()) {
      // Windows：Win10 1803+ 自带 bsdtar（支持 -xzf/-C/--strip-components）；
      //   git for windows 的 tar 兜底。stdio ignore 避免 >/dev/null 在 cmd 下失效。
      const winCandidates = [
        "tar",
        "C:\\Program Files\\Git\\usr\\bin\\tar.exe",
        "C:\\Program Files (x86)\\Git\\usr\\bin\\tar.exe",
      ];
      for (const c of winCandidates) {
        try {
          execSync(`"${c}" --version`, { timeout: 3000, stdio: "ignore" });
          return c;
        } catch (_) { /* 下一个 */ }
      }
      return "tar";
    }
    const candidates = ["/usr/bin/tar", "/bin/tar", "/usr/local/bin/tar", "tar"];
    for (const c of candidates) {
      try {
        execSync(`"${c}" --version`, { timeout: 3000, stdio: "ignore" });
        return c;
      } catch (_) { /* 下一个 */ }
    }
    return "tar";
  }

  /** 安全复制：把 src 下的代码树复制到 dst（覆盖/新增），跳过运行态与敏感路径
   *  （委托 tree-copy.js 共享实现，与 apply-staged-update.cjs 同一套逻辑） */
  function copyTreeSafe(src, dst, relBase) {
    return treeCopier.copyTreeSafe(src, dst, relBase);
  }

  // 缓存 userdata-manifest.json 的排除路径（30s 过期；读失败用空列表不影响主流程）
  let _userdataRel = null;
  let _userdataLoaded = 0;
  /** 读取 data-backup 生成的 userdata-manifest.json（导入导出用户数据清单），
   *  把其中标记的运行态文件/目录并入排除判断——auto-update 与导入导出共用同一份清单：
   *  源码 //userdata-manifest.json 注释里写的运行态，github 模式不覆盖、watch 模式不重启。 */
  function loadUserdataExcludes() {
    const now = Date.now();
    if (_userdataRel && now - _userdataLoaded < 30000) return _userdataRel;
    const out = [];
    try {
      const mf = path.join(ROOT_DIR, "json", "userdata-manifest.json");
      if (fs.existsSync(mf)) {
        const m = JSON.parse(fs.readFileSync(mf, "utf8"));
        for (const f of m.files || []) if (f && f.rel) out.push(f.rel);
        for (const d of m.dirs || []) if (d && d.rel) out.push(d.rel);
      }
    } catch (_) {}
    _userdataRel = out;
    _userdataLoaded = now;
    return out;
  }

  /** 判断相对路径是否命中排除清单（精确匹配或前缀匹配，委托 tree-copy 共享实现） */
  /** 是否排除：任意层级目录名 / 后缀 / 精确路径或目录前缀 */
  function isExcluded(relPath) {
    return treeCopier.isExcluded(relPath);
  }

  /** 恢复 *.sh 与 scripts/installer 可执行位（tarball 里可能丢失） */
  function chmodScripts(rootDir) {
    const scripts = ["start.sh", "start-linux.sh", "start-macos.sh", "scripts/installer"]
      .concat(extraChmodScripts);
    for (const rel of scripts) {
      const f = path.join(rootDir, rel);
      try { if (fs.existsSync(f)) fs.chmodSync(f, 0o755); } catch (_) {}
    }
  }

  /** 读取 github 模式状态（上次应用的 sha） */
  function readState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {};
      }
    } catch (_) {}
    return {};
  }

  /** 保存 github 模式状态 */
  function saveState(obj) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8"); } catch (_) {}
  }

  /** 零依赖 HTTPS GET，跟随 301/302（最多 5 跳），返回 Buffer */
  function httpsGet(url, headers, redirects) {
    redirects = redirects || 0;
    if (redirects > 5) return Promise.reject(new Error("重定向次数过多"));
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: headers || {} }, (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          const next = new URL(loc, url).toString();
          httpsGet(next, headers, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode + " " + url));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", reject);
      req.setTimeout(30000, () => { req.destroy(new Error("请求超时")); });
    });
  }

  /** 防抖重启（2 秒内多次变更只触发一次） */
  function scheduleRestart() {
    if (restarting) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    _log("防抖 2s 后重启...");
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      doRestart();
    }, 2000);
  }

  /** 执行重启：触发 ./start.sh restart 后退出本进程 */
  async function doRestart() {
    if (restarting) return;
    restarting = true;
    _log("开始重启...");
    try {
      if (_onRestart) await _onRestart();
    } catch (e) {
      _log("重启回调异常: " + (e.message || String(e)));
    }
    // 重启走项目启停脚本（唯一入口）：
    //   Linux/macOS → ./start.sh restart；Windows → start-windows.bat restart。
    //   延迟 detached 触发 → stop(杀本进程) → start(拉起新进程)。
    //   不能本进程 exit(0) 后指望外部拉起——脚本无守护循环；也不能自己 spawn——
    //   与脚本的 PID 管理冲突。先触发再退出，两不冲突。
    const logFile = path.join(SERVER_DIR, "server.log");
    let launched = false;
    try {
      if (isWinCompat()) {
        const bat = "start-windows.bat"; // 相对项目根（cwd=ROOT_DIR），避免中文/空格路径在 cmd 代码页下乱码
        const relLog = path.join("server", "server.log"); // 同上，相对路径
        const child = spawn("cmd.exe", ["/c", `timeout /t 1 /nobreak >nul & call "${bat}" restart >> "${relLog}" 2>&1`], {
          cwd: ROOT_DIR,
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          env: process.env
        });
        child.unref();
        launched = true;
        _log(`已触发 start-windows.bat restart（1 秒后执行，日志 ${relLog}）`);
      } else {
        const startSh = path.join(ROOT_DIR, "start.sh");
        if (fs.existsSync(startSh)) {
          fs.mkdirSync(SERVER_DIR, { recursive: true });
          const out = fs.openSync(logFile, "a");
          // 用 sh 显式解释执行，而非 `exec start.sh`：
          //   工作区可能挂在 noexec 的 CIFS 上，脚本没有可执行位时 exec 会
          //   Permission denied，导致重启失败而本进程已退出 → 服务直接死掉。
          //   `sh start.sh` 只要求可读，不要求可执行位。
          const child = spawn("/bin/sh", ["-c", `sleep 1; /bin/sh "${startSh}" restart >> "${logFile}" 2>&1`], {
            cwd: ROOT_DIR,
            detached: true,
            stdio: ["ignore", out, out],
            env: process.env
          });
          fs.closeSync(out);
          child.unref();
          launched = true;
          _log(`已触发 ./start.sh restart（1 秒后执行，日志 ${logFile}）`);
        } else {
          _log("未找到 start.sh，跳过自动重启");
        }
      }
    } catch (e) {
      _log("触发重启失败: " + (e.message || String(e)));
    }
    // 退出前先排空在途 HTTP 响应：静态资源（style.css 等）带 Content-Length，
    //   若进程在传输中被 process.exit 硬终止，浏览器会收到截断的响应并解析出半套
    //   样式/脚本——表现就是「刚更新完页面样式不对，刷新几次又好了」。
    // 钩子由 app.js 注入（停止接收新连接 + 等在途响应结束）；无钩子时退回原有延迟。
    const waitShutdown = _onShutdown
      ? Promise.resolve()
          .then(() => _onShutdown())
          .catch((e) => { _log("关停钩子异常: " + (e && e.message || String(e))); })
      : new Promise((r) => setTimeout(r, 500));
    // 兜底：钩子自身卡住时也要退出，避免服务永久悬挂
    const timeout = new Promise((r) => setTimeout(() => {
      _log("关停等待超时（8s），强制退出");
      r();
    }, 8000));
    Promise.race([waitShutdown, timeout]).then(() => {
      _log("执行 process.exit(0)");
      process.exit(0);
    });
  }

  /** 获取状态 */
  function getStatus() {
    const state = readState();
    return {
      enabled: !!watcher || !!gitInterval || !!githubInterval,
      mode: watcher ? "watch" : (gitInterval ? "git" : (githubInterval ? "github" : "none")),
      restarting,
      hasDebounce: !!debounceTimer,
      // github 模式：上次应用 sha / 提交时间 / 检查时间 / 最近一次检查结果
      lastSha: state.lastSha || "",
      lastCommitDate: state.lastCommitDate || "",
      lastUpdatedAt: state.updatedAt || 0,
      lastCheck: lastCheck
    };
  }

  function _log(msg) {
    console.log(`[${projectName}/auto-update] ${msg}`);
    if (_onStatus) _onStatus(msg);
  }

  /** 注入优雅关停钩子（app.js 在 listen 后调用） */
  function setShutdownHook(fn) { _onShutdown = fn; }

  return {
    start, stop, getStatus, scheduleRestart, doRestart, setShutdownHook,
    checkGitHubUpdate, getGitHubRefSha, getGitHubLatest,
    applyGitHubUpdate, isExcluded, copyTreeSafe,
    // 间隔与退避（纯函数，无副作用）—— 导出给 test/ 直接验证，
    // 避免测试为了取值去真的启动监控（那会触发 git pull / GitHub 请求）
    normInterval, intervalMsWithBackoff,
    DEFAULT_INTERVAL_SEC, INTERVAL_MIN_SEC, INTERVAL_MAX_SEC, BACKOFF_MAX_STEPS
  };
}

module.exports = { createAutoUpdate };