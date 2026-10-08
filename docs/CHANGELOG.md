# 版本列表

> 本文件是**版本记录的唯一维护位置**（README 只留一句指向这里）。
>
> 维护方式：由 dsh-git-push 插件的 `scripts/doc-version.mjs` 从 **git log** 聚合 ——
> `gen` 打印 / `apply` 写盘 / `check` 查漂移（有漂移非零退出，可接 CI）。
> 规则：**只有发版/功能提交的标题写版本号**（如 `feat: 1.8.0 — …`）；簿记类提交（同步文档等）标题里不要出现 X.Y.Z，
> 否则每次提交都会让标记块漂移。
>
> 下面「历史版本」是启用该工具之前手写的记录，原样保留（在标记块之外，不会被 `apply` 覆盖）。

<!-- dshgp-version:start -->
## 版本列表

| 版本 | 内容 |
|------|------|

<!-- dshgp-version:end -->

## 历史版本（工具启用前，人工维护）

| 版本 | 日期 | 内容 |
|---|---|---|
| — | 2026-10-09 | **版本记录外置到本文件**：README 的「九、版本记录」整表迁出到 `docs/CHANGELOG.md`，README 只留一句指向；本文件分两段——标记块 `<!-- dshgp-version:start/end -->` 由 dsh-git-push 的 `scripts/doc-version.mjs` 从 git log 聚合（`gen` 打印 / `apply` 写盘 / `check` 查漂移），块外的「历史版本」原样保留（不被 `apply` 覆盖）。迁移做三重校验：表体逐字节 sha 一致、README 章节列表不变、`check` 退出码 0 |
| — | 2026-10-08 | **压缩包图片按 mod 语义分流 + 修复 rar/7z 条目解析（4 条规则）**：此前压缩包内图片一律「按序列帧无脑合成 GIF」。现按四条规则处理：①包名带间隔（`@40ms`/`2s`，Pixiv 图包）→ 按该间隔合成 GIF、不翻转；②含 `.ini`（3DMigoto mod）→ 包内图片倒置存储，输出前 180° 翻转（`ffmpeg -vf vflip,hflip`，群晖 ffmpeg 缺 png/jpg muxer 故用单帧 GIF 承载）；③两者都无 → 不合成、原样显示；④含 ini 且是序列且 ini 有 `$speed` → 按 `1000/(fps×$speed)` 换算帧间隔合成（`$speed` 是 3dmigoto 动画 ini 的每帧递进量；`fps` 走 API 参数、默认 60）。接口变化：`/api/zip/scan` 回传 `hasIni`/`speed` 供前端门控，`/api/zip/gif` 增加 `fps` 参数，含 ini 的单图走 `/api/zip/img` 翻转。**同时修两个 rar/7z 解析 bug**：①`SEVEN_ZIP` 探测未传 `versionArgs:["i"]`、默认用 `-version`（7-Zip 系实测 exit 7）→ 7zz/7z 被判「不可用」并返回裸名，导致 rar/7z 列条目与 ini 检测全部静默失效；②`7z l` 的 Compressed 列可能为空，旧正则硬要求两个数字 → 空列的行整条丢弃（图片与 ini 一起漏检）。修复后实测真光锥包目录 279 个压缩包中 168 个识别出 ini（修复前 0）。回归测试 `test/zip-ini-gif.test.cjs`（28 项，覆盖 zip 与 7z 双分支） |
| — | 2026-10-08 | **修复「设置→添加图片目录」无法返回上一级**：`queryRoot()` 把越界请求静默钳回 `resolveFsRoot()`（= 已配置目录的公共前缀），而只配了一个图片目录时该前缀恰好等于该目录本身 → 目录浏览器永远上不去（实测：请求 `.../[Cygames]` 仍返回 `.../賽馬娘Pretty Derby`，📁↑ 点了像坏了一样）。修法：新增浏览天花板 `resolveBrowseLimit()`（显式配置 `GALLERY_FS_ROOT`/`config.fsRoot` 时以其为界，未配置则到文件系统根）与 `browseRoot()`；`/api/directories` 增加 `opts.authed` —— 已登录按新上限浏览、未登录维持原限制（不扩大暴露面），并回传 `limit`/`clamped`/`canUp`；前端目录浏览器据 `clamped` 提示「已到最上层」、到顶禁用 ↑。回归测试 `test/dir-browser-up.test.cjs`（9 项） |
| — | 2026-10-08 | **模板下发件入库，修复远程 auto-update 永远拉不到新版**：`server/core/` 等 8 个框架子目录与 `server/boot.cjs`、`server/lib/cjs-bootstrap.cjs` 此前被 `.gitignore` 当「组装产物」忽略；而部署端以 github 模式远程 `auto-update` 从本仓库拉代码，被忽略的文件不进仓库 = 部署端永远拿不到新版 —— `server/update/auto-update.js` 本身就是自动更新的实现，忽略它等于让它无法自更新（实测部署端停在 730 行旧版：间隔 300 秒、无失败退避）。现已入库 26 个文件；`server/update/auto-update.js` 同步为 38291 B 新版（github 模式默认间隔 3600 秒、连续失败按设定值 ×2 退避最多 3 次、不再排除 `server/boot.cjs`）；`server/public/auto-update-card.js` 同步（默认间隔 3600、上限 86400）。本 README 与 `.gitignore` 的「组装产物」措辞一并修正为「模板下发件」 |
| — | 2026-09-20 | **同步模板统一工具探测模块**：`server/lib/gif.js`（ffmpeg 选用）、`server/lib/archive.js`（7zz→7z 回退）、`server/store/data-backup.js`（zip/unzip）改走 `server/tool/tool-detect.js`（环境变量 → `tool/` 与 `tools/` → 系统路径，每级可用性实测、失败降级）；清单新增 `server/tool/tool-detect.js` 下发条目。工具探测行为不变（找不到仍兜底系统路径/裸名），只是查找逻辑统一且多一层可用性防护 |
| — | 2026-09-20 | **移除搬模板带进来的无引用文件 `search-date-range.cjs`**：该文件是「按时间搜索的日期窗口解析」，本项目既没有按时间搜索的路由、前后端也都没有引用它（全库 grep 为空）——gallery 不需要这个能力，它是清单从别的项目整份复制时一起带进来的。这类文件不报错、只是静静躺在项目里，要等有人照着它改代码才发现（本仓库此前已有同类先例：见下条 `login.html` 死代码）。已从 `assemble.json` 移除该条目，项目侧产物在下次组装时即消失。另：模板新增 `--dry-run` 组装预演与 `--check` 的「无引用」告警，专门用来在搬模板时提前发现这类问题 |
| — | 2026-09-19 | **README 同步目录分层**：正文 4 处仍写着旧的 `server/framework/`（顶部说明、目录表、两处「组装产物」清单），与实际结构不符，已改为 8 个框架子目录的实际路径。目录表由 1 行拆为 2 行，分别列入口/路由/鉴权/HTTP 与 配置/存储/更新/组装 |
| — | 2026-09-19 | **框架目录按功能分层**：`server/framework/` 由平铺 22 个文件改为 8 个子目录（`core/` `route/` `auth/` `http/` `config/` `store/` `update/` `assemble/`），功能边界从目录结构可读。清单相应由整目录条目改为逐文件条目；受影响文件的相对引用（含 `app.js` 的框架入口、`routes/*`、`lib/auto-update.js`）已同步改写。本项目自身业务代码除引用路径外无改动 |
| — | 2026-09-19 | **移除独立登录页，改为页面内登录弹窗**：本项目登录一直走 `index.html` 的 🔒 弹窗（`loginModal` + `POST /api/login`），`public/login.html` 是无人引用的死代码，却仍被组装清单分发、且内容是带 `@brand:` 占位符的蓝图旧版——占位符由运行期分片装配器替换，而静态页不走装配，故页面上会直接显示 `@brand:title@` 与裂图。现从清单移除 `blueprint/login.html`/`login.js` 两条，删除 `public/login.html`、`public/login.js`，`server/app.js` 的 `loginPath` 改为空串（配合框架 1.7.14 的「无独立登录页」支持） |
| — | 2026-09-19 | **接入 dl-server-template 框架**：`server/app.js` 由 1152 行单体拆为装配层 + `lib/` + `routes/`；自研 `auth.js` 由框架 `framework/auth.js` 取代；新增自动更新能力；上传改原生 handler（绕开框架 JSON 预读）；`routes/auth.js`、`routes/auto-update.js` 改用 `routes-adapter` 复用框架通用件（消除与 gbmd 的重复实现）；前端鉴权端点由 `/api/auth/*` 改为框架 `/api/status|login|logout`；启动脚本换成模板通用 `start.sh` |
