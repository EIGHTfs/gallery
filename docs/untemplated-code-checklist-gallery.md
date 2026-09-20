# gallery 转模板化分析清单（2026-09-20）

判定基准：**模板化 = 文件在 `assemble.json` 声明 `src→dst`（从模板下发，模板更新自动同步）**。
- 模板真源：`dl-server-template/server/`（framework / templates / project/blueprint）
- 项目：`gallery/`（拾光集 Gallery，git 2 提交）
- 已核对日期：2026-09-20（git 44c6d1f 之后，本地工作区快照）

## 结论先行

**gallery 已是标准模板化架构，无 A/B 类问题**。它从初始提交就走 `_gallery-style` 模板下发（服务端业务 app.js/lib/routes + 前端全在模板里），与 gbmd/iwara 的「模板骨架 + 项目自研业务」是两种细分模式。全量实测：模板 23 文件 ↔ 项目**零改版、零缺失**；服务端/前端文件无一游离（除运行期与惯例产物）。

## 一、已核对为模板化 ✓（无需动）

| 组 | 文件 | 来源 |
|---|---|---|
| 框架全套 | server/core、auth、config/、http、route、store、update、assemble、search 无 | `server/framework/` 下发（gallery 无 search-date-range，图片画廊无此功能，合理） |
| 布局通用件 | server/boot.cjs、server/public/theme-init.js、auto-update-card.js | `server/project/blueprint/` 下发（三项目通用） |
| 风格业务 | server/app.js、lib/（archive/auto-update/config/gif/scan/util）、routes/（archive/auth/auto-update/browse/favorites/gallery/upload）、public/（api-client/app.js/favicon/index/locales/style.css） | `server/templates/_gallery-style/` 下发，23 文件与项目 md5 全一致 |
| 启动 | start.sh | `server/lib/start.sh` 下发，与模板一致（0fa56ae7） |

注：lib/util.js 此前看似游离，实测已在 `_gallery-style/server/lib/` 模板内（6 个 lib），项目与模板一致 f9cc861d。

## 二、C 类：游离/废弃文件（清理类）

| # | 文件 | 状态 | 建议 |
|---|---|---|---|
| C1 | `.trash/config.json.bak-20260920` | 0.26KB 配置备份，`.gitignore` 的 `.trash/` 已覆盖（未入库） | 直接删除（本就在回收站） |

## 三、D 类：运行期/数据文件（gitignore 覆盖，正常不入库）

- `server/config.json`、`server/server.log`、`server/sessions.json`、`uploads/`（上传数据）
- `tools/`（ffmpeg 及依赖库 84 文件 / 154M，注释明示「不入库，由部署时另行放置」，对照 iwara/gbmd 同忽略 tool 二进制）

## 四、E 类：项目自持（非模板范畴，备查不动）

- `README.md`（31KB，已写明「2026-09-19 起接入 dl-server-template 框架」架构说明）
- `assemble.json`（组装清单，品牌段 title=拾光集/logo=favicon.svg/icon=favicon.png）
- `.gitignore`

## 五、小问题（非模板化，建议顺手处理）

- **README 悬空引用**：README 写「本次改动见 `CHANGELOG-框架接入.md`」，但该文件**不存在**（根目录/git 均无）——二选一：补建该文档，或删掉 README 里这句引用
- **C1**（见上）：`.trash/config.json.bak-20260920` 回收站残留

## 六、惯例确认（与 gbmd/iwara 一致，不动）

- `server/public/brand.json` 入库：gallery/gbmd/iwara **三项目全部入库跟踪**（组装产物入库惯例，brand 段缺键时由组装重建），统一处理，非 gallery 特有问题

## 六、gallery vs downloader 双模板模式（结构说明）

- **gallery**：业务也在模板里（`_gallery-style` 含 server/app.js、lib/、routes/）——唯一实例、业务板式适合模板化，clone 即得
- **downloader 系（gbmd/iwara）**：模板只给骨架（`_downloader-style` 前端+样式+主题），下载器业务（downloader/search/mapping 等）留项目自研——业务重、多项目差异大
- 两系并存是既有设计，非本次改动范围

## 建议动作（待你确认）

1. **C1**：删 `.trash/config.json.bak-20260920`（回收站内残留）
2. **README 悬空引用**：补 `CHANGELOG-框架接入.md` 或删掉 README 里那句「本次改动见 CHANGELOG-框架接入.md」
3. **其余**：gallery 无更多模板化缺口，保持现状即可；如要更彻底，可选：README 里补「双模板模式」说明（低优先）

（本清单为分析产物，已逐项实测，待人工复核后执行）