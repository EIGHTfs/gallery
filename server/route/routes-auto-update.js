// ============================================================
// 路由：自动更新（/api/auto-update）——框架层·通用
// 2026-09-06 新增：服务端代码自动更新 + 优雅重启
// 2026-09-16 通用化：无项目特有内容，注入 api.autoUpdate 即可用
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, readBody, cfg, autoUpdate } = api;

  // GET /api/auto-update/status
  route("GET", "/api/auto-update/status", (req, res) => {
    const cfgNow = cfg.readConfig();
    const status = autoUpdate.getStatus();
    // githubToken 仅存配置文件手改，不回传前端（脱敏为空串）
    const config = Object.assign({}, cfgNow.autoUpdate || {});
    delete config.githubToken;
    return sendJson(res, 200, {
      ok: true,
      config: config,
      status: status
    });
  });

  // POST /api/auto-update/config
  // { enabled, mode, interval } —— github 模式的仓库/分支/Token 不在前端设置，
  // 只存 config 手改；本端点不接收也不覆盖这三个字段。
  route("POST", "/api/auto-update/config", async (req, res) => {
    const body = await readBody(req);
    const cfgNow = cfg.readConfig();
    const cur = cfgNow.autoUpdate || {};

    const next = {
      enabled: body.enabled !== undefined ? !!body.enabled : cur.enabled,
      mode: body.mode || cur.mode || "watch",
      // 缺省 3600 秒（1 小时）：github 模式每次检查要打一次 GitHub API，而多数项目每天推送不足 3 次
      interval: body.interval ? parseInt(body.interval, 10) : (cur.interval || 3600)
    };
    // github 模式字段仅从配置文件继承（前端不提交，也不允许通过 body 覆盖）
    for (const k of ["githubRepo", "githubBranch", "githubToken"]) {
      if (cur[k] !== undefined) next[k] = cur[k];
    }

    cfgNow.autoUpdate = next;
    cfg.writeConfig(cfgNow);

    // 重新启停监控
    autoUpdate.stop();
    autoUpdate.start(next, async () => {
      // 重启回调：保存当前任务状态（已 pause 的任务下次启动自动恢复）
      console.log("[auto-update] 重启回调：任务状态已保存");
    }, (msg) => {
      console.log("[auto-update] " + msg);
    });

    return sendJson(res, 200, { ok: true, autoUpdate: next });
  });

  // POST /api/auto-update/check
  // 手动触发一次 github 模式检查（不等定时轮询），等待完成后返回检查结果
  route("POST", "/api/auto-update/check", async (req, res) => {
    const cfgNow = cfg.readConfig();
    const au = cfgNow.autoUpdate || {};
    if (!au.enabled || au.mode !== "github") {
      return sendJson(res, 400, { ok: false, error: "仅 github 模式支持手动检查" });
    }
    const before = autoUpdate.getStatus().lastCheck || null;
    autoUpdate.checkGitHubUpdate(au);
    // 轮询等待检查完成（网络/下载/应用最长约 10 秒），完成后把结果回给前端
    let result = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const now = autoUpdate.getStatus().lastCheck || null;
      if (now && now !== before && now.time !== (before && before.time)) { result = now; break; }
      // 若进程已重启（lastCheck 内存态清空），退出等待
      if (autoUpdate.getStatus().restarting && now === null) break;
    }
    return sendJson(res, 200, { ok: true, check: result });
  });

  // POST /api/auto-update/restart
  // 手动触发重启（不依赖文件变更检测）
  route("POST", "/api/auto-update/restart", async (req, res) => {
    autoUpdate.scheduleRestart();
    return sendJson(res, 200, { ok: true, message: "2 秒后重启" });
  });
};