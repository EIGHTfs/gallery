// auto-update-card.js — 自动更新卡片（蓝图通用·自包含）
// 用法：页面里插入 @frag:auto-update-card 卡片 HTML 后，调用 AutoUpdateCard.mount() 即可。
// 不依赖项目 api()/setStatus()/$()，内部自封装 fetch；任何 dl-server-template 系项目直接可用。
// 实测接口（各项目 routes/auto-update.js 提供，1:1 对齐）：
//   GET  /api/auto-update/status   → { ok, config:{enabled,mode,interval}, status:{enabled,mode,lastSha,lastCommitDate,...} }
//   POST /api/auto-update/config   → { enabled, mode, interval }
//   POST /api/auto-update/check    → { ok, check:{result:"latest"|"updated"|"error", message} }
//   POST /api/auto-update/restart  → { ok }
// 说明：刻意不用 IIFE 包整份（审计把整体当单函数、行数超阈值），改为顶层函数集合，
//       每个函数各司其职且都短；结尾统一挂到 window.AutoUpdateCard。
"use strict";

const AU_POLL_DELAY_MS = 1500;    // 重启/检查后回读状态的延迟
const AU_DEFAULT_INTERVAL = 300;  // 拉取模式的缺省间隔（秒）

function auEl(id) {
  return document.getElementById(id);
}

async function auApi(path, method, body) {
  const opt = { method: method || "GET", headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  let payload = null;
  try { payload = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
  if (!res.ok && !payload) throw new Error("HTTP " + res.status + " " + path);
  if (payload && payload.ok === false) throw new Error(payload.error || "请求失败");
  return payload || {};
}

function auSetStatus(el, text, cls) {
  if (text) el.textContent = text;
  el.className = "status" + (cls ? " " + cls : "");
}

/** 时间戳 → 「YYYY-MM-DD HH:mm（北京时间）」；ISO 无效时原样返回 */
function auFmtCommitDate(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso;
  const bj = new Date(dt.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

/** 拉取模式（git/github）才需要间隔输入；watch 模式隐藏 */
function auSyncIntervalRow() {
  const mode = auEl("autoUpdateMode").value;
  auEl("autoUpdateIntervalRow").style.display = (mode === "git" || mode === "github") ? "flex" : "none";
}

/** 状态行文案：监控中显示模式与本地版本，未启用显示提示 */
function auInfoText(state) {
  if (!state.enabled) return "⏸ 未启用";
  const localVer = state.lastCommitDate
    ? auFmtCommitDate(state.lastCommitDate) + "（北京时间）"
    : (state.lastSha ? state.lastSha.slice(0, 8) : "");
  const modeName = {
    watch: "文件监控",
    git: "定时 git pull",
    github: `GitHub 拉取${localVer ? "（本地版本 " + localVer + "）" : ""}`,
  };
  return `✅ 监控中（mode=${state.mode}, ${modeName[state.mode] || state.mode}）`;
}

/** 把配置填回表单 + 刷新状态行 */
function auRenderStatus(cfg, state) {
  auEl("autoUpdateToggle").checked = !!cfg.enabled;
  auEl("autoUpdateMode").value = cfg.mode || "watch";
  auEl("autoUpdateInterval").value = cfg.interval || AU_DEFAULT_INTERVAL;
  auSyncIntervalRow();
  auSetStatus(auEl("autoUpdateInfo"), auInfoText(state), state.enabled ? "ok" : "");
}

async function auLoadStatus() {
  try {
    const resp = await auApi("/api/auto-update/status");
    if (!resp.ok) return;
    auRenderStatus(resp.config || {}, resp.status || {});
  } catch (_) { /* 获取自动更新状态失败：保持界面原样 */ }
}

/** 检查结果 → 状态栏文案 */
function auCheckText(check) {
  if (check && check.result === "latest") return ["✅ " + check.message, "ok"];
  if (check && check.result === "updated") return ["🔄 " + check.message, "ok"];
  if (check && check.result === "error") return ["❌ " + check.message, "err"];
  return ["🔍 已触发检查（进程可能已重启，请刷新页面查看）", ""];
}

async function auOnSave(toggle) {
  const st = auEl("autoUpdateStatus");
  try {
    await auApi("/api/auto-update/config", "POST", {
      enabled: toggle.checked,
      mode: auEl("autoUpdateMode").value,
      interval: parseInt(auEl("autoUpdateInterval").value, 10) || AU_DEFAULT_INTERVAL,
    });
    auSetStatus(st, "✅ 已保存" + (toggle.checked ? "，监控已启动" : "，监控已停止"), "ok");
    auLoadStatus();
  } catch (err) {
    auSetStatus(st, "保存失败: " + err.message, "err");
  }
}

async function auOnCheck() {
  const st = auEl("autoUpdateStatus");
  auSetStatus(st, "🔍 检查中...", "");
  try {
    const resp = await auApi("/api/auto-update/check", "POST");
    const resultPair = auCheckText(resp.check);
    auSetStatus(st, resultPair[0], resultPair[1]);
    setTimeout(auLoadStatus, AU_POLL_DELAY_MS);
  } catch (err) {
    auSetStatus(st, "检查失败: " + err.message, "err");
  }
}

async function auOnRestart() {
  const st = auEl("autoUpdateStatus");
  if (!confirm("确认立即重启服务端？当前下载任务将暂停，重启后自动恢复。")) return;
  try {
    await auApi("/api/auto-update/restart", "POST");
    auSetStatus(st, "🔄 2 秒后重启...", "ok");
    setTimeout(() => auSetStatus(auEl("autoUpdateInfo"), "⏳ 服务端重启中...", ""), AU_POLL_DELAY_MS);
  } catch (err) {
    auSetStatus(st, "重启失败: " + err.message, "err");
  }
}

/** 绑定卡片上的四个控件 */
function auBindCard() {
  const toggle = auEl("autoUpdateToggle");
  auLoadStatus();
  auEl("autoUpdateMode").addEventListener("change", auSyncIntervalRow);
  auEl("autoUpdateSaveBtn").addEventListener("click", () => auOnSave(toggle));
  auEl("autoUpdateCheckBtn").addEventListener("click", auOnCheck);
  auEl("autoUpdateRestartBtn").addEventListener("click", auOnRestart);
}

function auMount() {
  if (!auEl("autoUpdateToggle")) return; // 卡片未插入
  auBindCard();
}

if (typeof window !== "undefined") {
  window.AutoUpdateCard = { mount: auMount, loadStatus: auLoadStatus };
}
