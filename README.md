# 拾光集 — 局域网 Mod 图片画廊

> 访问入口：`http://<NAS-IP>:8081/`（如 `http://10.10.10.193:8081/`）。
> **零依赖**：纯 Node.js 内置模块（`http`/`fs`/`path`/`crypto`/`zlib`/`child_process`），
> 不依赖 express/cors/multer，不需要 npm install，不需要 python3 静态服务。
>
> **2026-09-19 起接入 `dl-server-template` 框架**：HTTP 服务/鉴权/路由工厂/配置/自动更新
> 改用框架通用件，项目只保留业务代码。前端与后端资产由 `assemble.json` 声明、
> `setup.sh` 组装生成（`server/core/` 等 8 个框架子目录与 `server/boot.cjs` 是组装产物）。
> 本次改动见 `CHANGELOG-框架接入.md`。

## 一、项目是什么

一个跑在 NAS 局域网里的图片浏览画廊：按文件目录层级浏览图片、压缩包内图直出、序列帧合成 GIF、侧边栏目录树、分类筛选、i18n 中英、设置页（标题/图标/分类/目录/上传）、可选登录保护设置页。

**一个进程同时服务静态页 + API**（`./start.sh` 或 `node server/boot.cjs`），不需要额外开 python3 静态服务器，不需要 node_modules。

- 页面 + API：`http://<NAS-IP>:8081/`（同一个进程）

## 二、快速启动

后端 `server/`，网页 `server/public/`，启动 `./start.sh`（默认 **restart**）。

```bash
cd <项目根>
./start.sh                     # 默认 restart，端口自动读 config.schema.json（8081）
./start.sh start
./start.sh stop
./start.sh status              # 进程/监听/HTTP 健康检查/日志尾
./start.sh --port 9000         # 临时换端口
./start.sh --set-password "新密码"
```

`start.sh` 是 `dl-server-template` 的**通用启停脚本**（三项目同一份，md5 一致）：
PID 落项目根 `<项目名>.pid`、启动前等端口真正释放、8 秒健康检查 `/api/status`、
日志超 10MB 自动轮转、`setsid` 守护（脱离终端）。默认端口按 `config.schema.json`
的 `port.default` 自动取值，故各项目无需改脚本。

**局域网访问**：服务监听 `::`（含 IPv4），不绑 127.0.0.1，局域网设备可直接访问
`http://<NAS-IP>:8081/`。

改完前端/后端代码后：**必须升 index.html 里的 `?v=` 版本号**（当前 43），否则用户浏览器缓存旧 JS/CSS 不生效（强刷 `Ctrl+F5` 可绕过，但对外发布务必升版本号）。

## 三、文件左右（文件结构说明）

**装配层**（项目自研，入库）：

| 文件 | 作用 |
|---|---|
| `assemble.json` | 组装清单：声明从模板取哪些文件到本项目（键=模板内路径，值=本项目路径） |
| `server/app.js` | 入口装配：创建 config/auth、挂路由表、注入 autoUpdate |
| `server/boot.cjs` | CJS 启动器（**.cjs 强制按 CommonJS 加载**，避免父目录 `type:module` 把 `.js` 当 ESM） |
| `server/config.schema.json` | 配置 schema（默认端口 8081 等） |
| `start.sh` | 通用启停脚本（见上） |

**业务代码**（项目自研，入库）：

| 文件 | 作用 |
|---|---|
| `server/lib/config.js` | 画廊配置读写（分类/目录），**写盘时保留密码哈希** |
| `server/lib/scan.js` | 目录递归扫图 + mtime 缓存（首次 9.7s → 缓存 0.19s） |
| `server/lib/archive.js` | 压缩包索引/取图（zip 自解析 + GBK 回退、7zz/rar） |
| `server/lib/gif.js` | 序列帧合成 GIF（ffmpeg） |
| `server/lib/util.js` | 通用件：jsonRes/streamFile/parseQuery/readMultipartUpload 等 |
| `server/lib/auto-update.js` | 自动更新实例（引框架工厂 + 传 gallery 参数与排除项） |
| `server/routes/browse.js` | 浏览：`/api/directories`、`/api/images`、`/api/media`、`/api/dir` |
| `server/routes/gallery.js` | 设置读写：`GET/POST /api/gallery` |
| `server/routes/upload.js` | 上传（原生 handler，**绕开 createRoute 的 JSON 预读**） |
| `server/routes/favorites.js` | 收藏增删查 |
| `server/routes/archive.js` | 压缩包内图 / zip 内 GIF |
| `server/routes/auth.js` | 认证路由**装配**（复用框架通用件，不手写端点逻辑） |
| `server/routes/auto-update.js` | 自动更新路由**装配**（同上） |

**组装产物**（从模板下发，不入库）：

| 文件 | 作用 |
|---|---|
| `server/core/` `server/route/` `server/auth/` `server/http/` | 框架通用件（按功能分层）：入口/路由工厂/鉴权/HTTP 工具 |
| `server/config/` `server/store/` `server/update/` `server/assemble/` | 框架通用件：配置加载/数据存储/自动更新/片段组装 |
| `server/lib/cjs-bootstrap.cjs` | CJS 劫持（由 setup.sh 下发） |

**运行态**（gitignore）：

| 文件 | 作用 |
|---|---|
| `server/config.json` | 设置：title/favicon/categories/directories/密码哈希。**实时读**，改完无需重启 |
| `server/sessions.json` / `server/favorites.json` | 会话 / 收藏持久化 |
| `server/public/` | 网页（组装产物，但含风格层素材） |
| `tools/` | `7zz`、`ffmpeg`/`ffmpeg-lib`（154M，不入库） |
| `uploads/` / `cache-gifs/` | 游客上传 / GIF 缓存 |

## 三之二、接入 dl-server-template 框架（2026-09-19）

### 为什么接

原 `server/app.js` 是 1152 行单体：手写 `http.createServer` + `switch` 路由 + 内联全部业务逻辑；
`server/auth.js` 是 89 行自研鉴权（scrypt + 内存 Map 会话 + 手写 cookie）。这些能力
`dl-server-template` 已有通用实现，且 gbmd/iwara 两个项目在共用——继续自带一份就是重复维护。

### 现在的分层

```
server/app.js          ← 装配层：建 config/auth → 挂路由表 → 启动（只做组装，不写业务）
  ├─ framework/        ← 框架通用件（组装下发）：HTTP、鉴权、路由工厂、配置、备份、自动更新
  ├─ lib/              ← 项目业务能力：config / scan / archive / gif / util
  └─ routes/           ← 项目业务路由：browse / gallery / upload / favorites / archive
                          auth / auto-update 只做「装配」，端点逻辑复用框架通用件
```

**业务路由新增或修改**：在 `server/routes/` 下按表式写（`createRoute`），在 `app.js` 的路由表里挂载。

### 两条必须知道的框架约定

**① createRoute 会预读 POST body（按 JSON 解析）**
框架对 POST 请求会先按 `utf8 + JSON.parse` 预读 body。**上传是 multipart，不能用
`createRoute`**，必须是原生 handler（见 `routes/upload.js`，挂载时传 `{ handler }`）。
用 `createRoute` 处理 multipart 会把二进制按 utf8 解码导致文件损坏。

**② 原生 handler 的 ctx 只有 `{cfg, auth, sendJson}`**
`createServer` 内部组装的 ctx 是固定的三个字段，**不包含 app.js 里自定义的 `ctx`**
（`requireAuth` 等）。原生 handler 里要用鉴权须自行判定，或从 `require("../framework")` 取
`auth.extractToken/isValidSession`（见 `routes/upload.js` 的 `requireAuth()`）。

### 通用件复用的两种范式

框架通用件（`framework/route/routes-auth.js`、`framework/route/routes-auto-update.js`）写的是**闭包式**
`module.exports = function register(api) { api.route("GET","/api/x",fn) }`（为 iwara 的
`route-registry` 设计），而本项目走 **表式** `createRoute`。

这两套范式曾导致 gbmd/gallery 各自手抄一份同逻辑的表式实现——正是通用件注释里
吐槽的「逻辑漂移」来源。现已用 `framework/route/routes-adapter.js` 的 `tableFromRegister()`
把闭包式转成表式，表式项目可直接复用同一份通用件：

```js
// server/routes/auth.js —— 只做装配，不写端点逻辑
const { tableFromRegister } = require("../framework/route/routes-adapter");
const routesAuth = require("../framework/route/routes-auth");
function init(deps) {
  table = tableFromRegister(routesAuth, { sendJson, readBody, cfg: deps.cfg, auth,
                                          setSessionCookie: auth.setSessionCookie });
  return table;
}
```

效果：`routes/auth.js` 89 → 44 行，`routes/auto-update.js` 89 → 37 行，且三项目共用同一份端点逻辑。

### 组装与重建

```bash
# 项目根有 assemble.json 声明取件清单；改完模板后重新组装：
<模板仓库>/setup.sh gallery --to <项目根>/server

# 校验清单一致性（模板源 → 项目目标 逐文件 md5 比对）
<模板仓库>/setup.sh gallery --to <项目根>/server --check
```

`server/core/` 等 8 个框架子目录、`server/boot.cjs`、`server/lib/cjs-bootstrap.cjs` 是组装产物，
**不入库**——clone 后跑一次组装即可得到，勿手改（改在项目侧会被 `--check` 报不一致）。

---

## 四、架构与工作方式

### 数据流
```
NAS 磁盘目录/压缩包 ──> routes/browse.js ──GET /api/directories、/api/images、/api/media──> 前端渲染
config.json ──────────────────────────── GET/POST /api/gallery（设置，POST 需登录）
框架 routes-auth ─────────────────────── /api/login、/api/logout、/api/status、/api/change-password
```

- 浏览（GET /api/*）：游客可访问全部内容。
- 设置（POST /api/gallery、上传到真实目录、收藏增删）：设置了密码后需登录（未设密码则开放）。

### API 一览

**浏览类**（`routes/browse.js`、`routes/archive.js`）：

| API | 作用 | 鉴权 |
|---|---|---|
| `GET /api/directories` | 目录列表 | 开放 |
| `GET /api/images` | 图片列表（含目录扫描、zip 扫描） | 开放 |
| `GET /api/media?file=` | 图片流 | 开放 |
| `GET /api/dir?path=` | 单目录内容（侧边栏树） | 开放 |
| `GET /api/zip/scan?dir=` | 压缩包条目 `{images}` | 开放 |
| `GET /api/zip/img?zip=&file=` | 压缩包内图片 | 开放 |
| `GET /api/gif?dir=&dur=` | 目录内序列帧合成 GIF | 开放 |
| `GET /api/zip/gif?zip=&file=&dur=` | 压缩包内序列帧合成 GIF | 开放 |

**业务类**（项目路由）：

| API | 作用 | 鉴权 |
|---|---|---|
| `GET /api/gallery` | 读设置（剥离密码哈希） | 开放 |
| `POST /api/gallery` | 保存设置 | **需登录** |
| `POST /api/upload` | 上传（无 targetDir → 本地 uploads/；有 targetDir → 写入真实目录） | 开放（无 targetDir）/**需登录**（有 targetDir） |
| `GET /api/favorites` | 收藏列表 | 开放 |
| `POST /api/favorites` | 添加收藏 | **需登录** |
| `DELETE /api/favorites` | 移除收藏 | **需登录** |
| `GET /api/uploaded` | 列出本地 uploads/ 图片 | 开放 |

**认证类**（框架通用件 `framework/route/routes-auth.js`，经 `routes/auth.js` 装配）：

| API | 作用 | 鉴权 |
|---|---|---|
| `GET /api/status` | `{ok, needsSetup, needsAuth, port}`，前端据此决定是否显示 🔒（本项目无独立登录页，登录走页面内弹窗） | 开放 |
| `POST /api/login` | 校验密码、签发 HttpOnly cookie（`remember` 签长会话） | 开放 |
| `POST /api/logout` | 注销、清 cookie | 开放 |
| `POST /api/change-password` | 改密（已设密码须验旧密码） | **需登录** |

> **注意**：端点名从旧的 `/api/auth/status|login|logout` 改为框架的
> `/api/status|login|logout`（其它项目一致）。前端已同步。

**自动更新类**（框架通用件 `framework/route/routes-auto-update.js`）：

| API | 作用 | 鉴权 |
|---|---|---|
| `GET /api/auto-update/status` | 配置 + 运行状态（含 `lastUpdatedAt`） | 开放 |
| `POST /api/auto-update/config` | 改启停/模式/间隔 | 开放 |
| `POST /api/auto-update/check` | 手动触发一次 GitHub 检查 | 开放 |
| `POST /api/auto-update/restart` | 手动重启 | 开放 |

### 前端关键点（app.js）
- **同源 API**：零依赖后静态页与 API 同端口，`API_ROOT=''`，`credentials:'same-origin'`（原跨端口动态 host 方案已废弃，见坑①）。
- **目录树**：`buildDirTreeFor()` + `renderDirTree()` 递归渲染，深层高亮需祖先链展开（见坑⑦）。
- **折叠+分组（foldChain）**：`currentScope()` 收集子目录 → **统一规则：有子文件夹就分组（不管1个多个、不管有无直图），无子文件夹就拍平图片**；分组递归（分组里的分组也是分组），嵌套分组独占一行、字体逐层缩小区分层级；分组默认折叠，展开状态存 `localStorage('galleryExpandedGroups')`。
  - 分组交互：**名称部分点击=进入该目录**，**后面▲/▼符号=折叠/展开**（名称部分进入文件夹，符号部分折叠/展开）。
  - 分组自身如有直图，直图作为分组内首个叶子项（不丢失）。
- **按目录导航（navByDir）**：每个根目录各自记录 `currentPath`（`navByDir: Map<rootPath, currentPath>`），切换分类时恢复该目录上次路径；localStorage 按浏览器天然隔离（不同设备各自独立路径）。
- **侧边栏折叠/展开**：已展开（ancestor）的节点点击=折叠不导航；未展开的节点点击=展开+导航；折叠状态存 `localStorage('galleryCollapsedTreeNodes')`。
- **路径后退/前进**：面包屑前后有 `< >` 按钮，`navHistory` 栈记录每次导航状态，后退/前进移动指针恢复 `{activeDir, currentPath, activeFilter}`；初始状态入栈，导航后 `pushNavHistory()` 截断前进栈。
- **Lightbox 滑动切换**：触摸水平滑动（`touchstart/touchmove/touchend`，dx>40 切换）、鼠标滚轮（`wheel`，防默认滚动）、键盘左右键、Prev/Next 按钮——四种切换方式。
- **Lightbox 下载**：`fetch` blob → `URL.createObjectURL` → `a.download`；回退 `window.open`。
- **卡片行预览滑动**：**没点开时**在图片行上按住横向拖动 → 行滚动（`gridDrag` mousedown/mousemove/mouseup，位移>4px 判定为拖动并 `preventDefault`；捕获阶段拦截 click 防误开卡片）（需求为「未点开时即可横向拖动」，而非仅在灯箱内滑动）。
- **收藏功能**：预设"🩷 收藏"分类（不可删改）；`favorites.json` 持久化；`GET /api/favorites`（开放，游客可看）；`POST/DELETE /api/favorites`（需登录）；lightbox 🩷 按钮切换收藏，已收藏卡片显示 ❤️ 角标；收藏视图平铺所有收藏图片；**收藏 src 规范化 `normalizeFavSrc()`**：旧数据若存完整 URL（含端口）→ 转成相对 `/api/media?file=...`（修复重启后收藏图片裂开，见坑⑱）。
- **收藏 Lightbox 来源路径**：在收藏分类打开图片时，下方描述额外显示 `📁 来源绝对路径`（存 `path` 字段；老收藏用 `root` 兜底）（在收藏分类打开图片时额外显示来源路径）。
- **上传权限**（收藏目录不可上传；未登录只能上传到预设「游客」分类，文件存项目本地）：`handleFiles()` 判定——①`activeFilter==="favorites"` 时禁止上传（提示"收藏分类不可上传"）；②未登录（游客）→ 只能上传到预设「👤 游客」分类，文件存项目本地 `uploads/`（`/api/upload` 无 targetDir）；③登录后 → 若当前在真实目录 `activeDir`，带 `targetDir` 上传直接写入该目录（`/api/upload?targetDir=`，服务端校验登录+目录存在），否则存本地。游客分类图片 = 服务端 `/api/uploaded`（持久）+ 本次浏览期内前端上传（按 src 去重）。
- **顶部分类可滑动导航**：`.nav-scroll` 包裹（`flex:1; min-width:0; overflow-x:auto`）内分类按钮横向滑动；搜索框窄一半（`width:100px`，聚焦 130px）（顶部分类过多时横向滑动；搜索框相应收窄）。
- **压缩包折叠**：`galleryCollapsedZips` 持久化收起/展开。
- **GIF 合成**：`detectFramesFromNames()` 识别连续数字帧 → 请求 `/api/gif` 或 `/api/zip/gif`；缓存 `cache-gifs/`。
- **长按/右键**：~~`contextmenu` 仅 img preventDefault；无 pointerdown 监听，不影响滑动与单击~~ **已放开**（2026-09-01 注释掉 contextmenu 屏蔽与 img 的 user-select/touch-callout/user-drag，允许长按/右键保存图片）。
- **登录 UI**：`refreshAuth()` 读 **`/api/status`**（框架端点，返回 `needsAuth`）→ 未登录只显 🔒 无 ⚙，登录后只显 ⚙ 无 🔒（退出登录入口移到设置面板内 `#settingsLogout`）。
- **设置面板**：右侧固定浮层（`position:fixed; right:-420px→0`），折叠展开不挤压图片区域。
- **i18n**：`LANGS=['zh-CN','en']`、`localStorage('galleryLang')`、`t(key,vars)`、`data-i18n` 静态填充。
- **性能优化**：① 服务端 scan cache（`IMAGE_SCAN_CACHE`，30s mtime 探测，首次 9.7s→缓存 0.19s）；② `dirAgg` 预计算（每张图向所有祖先目录贡献，`statDir` O(N)→O(1)，render 6.2s→176ms）；③ `<img loading="lazy" decoding="async">` 延迟加载。

## 五、开始的坑（踩坑全记录，重点）

### 坑①（已解决）localhost 局域网访问没数据 ⚠️（零依赖后同源，已不复现）
- **历史现象**：旧版 `api.js` 硬编码 `const API_BASE = 'http://localhost:3000/api'`。本机访问正常，但**局域网其他设备访问 `http://10.10.10.4:8080/` 时，页面里所有 API 请求都发到「访问者自己电脑的 localhost:3000」→ 连不上 → 画廊空白/没数据/报错**。
- **历史修复**：前端 API 地址用 `window.location.hostname` 动态拼。
- **2026-09 零依赖重构后**：静态页与 API **同一进程同一端口 8081**，前端 `API_ROOT=''`、`API_BASE='/api'`（相对路径），无论从哪个地址访问都自动同源，彻底消灭跨端口问题。
- **防再犯**：写 Web 前端，凡是跨设备访问的服务，API 地址用相对路径/`window.location` 动态拼，**绝不硬编码 localhost/127.0.0.1/端口**。收工前用局域网真实 IP 验证一遍。

### 坑② API 前缀 `/api` 必须完整
- 曾把资源 URL 用不含 `/api` 的 `API_ROOT` 拼（如 `API_ROOT + '/media?...'`），导致 404。
- 规则：接口全走 `API_BASE + '/api/...'`；`apiUrl()` 只用于拼媒体直链时也要注意——GIF/zip 图片一律走带 `/api` 的 `/api/gif`、`/api/zip/gif`、`/api/zip/img`。

### 坑③ 压缩包显示需求三连坑
1. 平铺成散图（错）
2. 独立显示「压缩包」分组/标题（错）
3. **压缩包内图直接显示在文件夹分组、不显示压缩包标题**（对）
- 「不要显示压缩包」= 不显示压缩包本身，但要显示内图；"解析到压缩包那一层" = 压缩包内图要解析出来。zip 组**无标题**，异步加载内图并入同名 mod 文件夹分组（散图+压缩包同框）。
- **压缩包条目要么是图片（内联显示），要么不显示**（用户不想看到 .ini 等解析文本）；无图片的压缩包整组隐藏。
- **压缩包条目绝不能当普通图片走 `/img`**：imgList 跳过 isZip、聚合跳过 zip、server 端 `/img` 对 zip 403（三层修复，防 img.bin 重复显示）。

### 坑④ zip 条目名 GBK 解码
- 中文 zip 条目名多为 GBK，`buf.toString('utf8')` 硬解出乱码。
- 修复：`TextDecoder('utf-8', {fatal:true})` 严格解码失败回退 `TextDecoder('gbk')`。

### 坑⑤ 7z l 列序 bug
- 7z l 表格列序：`Date Time Attr Size Compressed Name`，正则分组 `m[1]=Attr, m[2]=Size, m[3]=Name`。
- 曾写成 `name: m[2], size: parseInt(m[1])`（Size 当名字、Attr 当大小）→ rar images 全空、others 把数字当文件名。正确：`name: m[3].trim(), size: parseInt(m[2],10)`，图片判断用 `m[3]`。

### 坑⑥ RAR m3:25 需新版 7-Zip
- 旧 `7z 16.02`（/usr/bin/7z）解不了 RAR `m3:25`（报 Unsupported Method），遇「scan 有图取图空」先查条目 Method。
- 本项目 `tools/7zz` = 官方新版 7-Zip 26.02；SEVEN_ZIP 指向它。
- 7z 16.02 对 GBK 文件名输出 `?`（字节在 7z 层丢失，rar/7z 分支无法恢复原中文名；zip 分支自解析不受影响）。

### 坑⑦ 侧边栏深层高亮不渲染 + 子目录项缺 data-root + 只能展开不能折叠
- 曾仅当 `active`（路径精确等于 activePath）才递归展开 → `Mods/.Mods/(gamebanana)/女武神` 这种深层永远不渲染。
- 修复①（isAncestor）：`isAncestor = !!activePath && (activePath === child.relPath || activePath.startsWith(child.relPath + '/'))`，祖先链也要递归展开。
- 修复②（data-root）：`renderTreeChildren` 生成的子目录项只有 `data-path` 没有 `data-root` → 点击后 `item.dataset.root=undefined` → `activeDir=undefined` → 侧边栏全收起。修复：给所有子目录项也加 `data-root=rootPath`。
- 修复③（折叠/展开）：规则为「已展开点击=折叠不导航，未展开点击=展开+导航」。加 `collapsedTreeNodes` Set（`localStorage('galleryCollapsedTreeNodes')`），展开条件 = `(active || isAncestor) && !collapsedTreeNodes.has(nodeKey)`；点击已展开节点→折叠（加入 set），点击未展开→导航进入（自动展开）。

### 坑⑧ 新增分类后下拉不刷新
- `addCategoryBtn` handler 没调 `renderDirectories()` → 设置页 Directories 下拉看不到新分类。
- 规则：改名/改色/新增/删除分类后**必须** `renderDirectories()`；删除分类 → 引用该分类的目录回退 `"all"`（下拉含 all 选项）。

### 坑⑨ 跨端口 Cookie 不携带（登录后仍显示游客）⚠️（零依赖后已解决）
- **历史**：旧版页面 :8080、API :3000 是**跨源**，前端用 `credentials:'include'` 不够，服务端还得开 CORS 凭证；缺一步 → 带 cookie 请求被拦截 → `/api/auth/status` 永远 `authed:false` → 登录「成功」刷新后又变游客（真实教训）。
- **2026-09 零依赖重构后**：静态页与 API **同一端口**，天然同源，无需 CORS；前端 `credentials:'same-origin'` 即可。此坑彻底消灭。

### 坑⑩ 横向滚动下卡片宽度塌缩成 0
- `.dir-grid` 改 flex 横向后，`.card img` 若仍 `position:absolute` → 图片不参与布局 → 卡片宽度 0、图片 0 宽。
- 修复：横向行内图片改流式撑宽（`position:static; height:100%; width:auto`），卡片 `height: var(--card-h); width:auto`。图片高度加大用 `--card-h`（桌面 `clamp(260px,min(56vh,30vw),640px)`，竖屏更高）。

### 坑⑪ 改代码必须升版本号
- 前端无构建流程，index.html 用 `?v=18/19` 引 JS/CSS。改了 app.js/api-client.js/style.css/index.html 必须升版本号，否则用户浏览器用缓存旧文件。
- 验证"新代码真的生效"：curl 服务端返回的文件内容含新标记，别只看磁盘文件。

### 坑⑫ CDP headless 中 `prompt()` 永久阻塞
- CDP headless 里 `prompt()` 永不返回（无对话框）。测试脚本先 `window.prompt = () => '测试值'` 再点按钮。
- **2026-09 分类/目录添加已改内联 UI**（分类=内联输入框 + 目录=📂 目录浏览器），不再用 `prompt()`，此坑不再触发。

### 坑⑬ 手机布局不要改
- 窄屏适配已明确否决：手机窄屏下 sidebar 240px、.main 窄，**保持现状**，不做响应式折行改动。图片横向滑动只影响文件夹图片行。

### 坑⑭ 登录语义 + 上传权限
- 「不登录也能访问，不强制登录，默认游客，登录了才能显示和修改设置」：
  - 浏览全部 GET 开放；
  - 设置了密码后，未登录只显 🔒 无 ⚙；登录成功只显 ⚙ 无 🔒，退出登录入口在设置面板内；
  - 游客点设置弹登录框，登录成功自动打开设置；
  - **未设密码时全部开放**，`--set-password` 设密码后启用登录限制。
- **上传权限**（收藏目录不可上传；其他目录登录后可上传；未登录只能上传到预设「游客」分类，文件存项目本地）：
  - 收藏分类禁止上传（前端拦截提示）；
  - 未登录（游客）只能上传到预设「游客」分类，文件存项目本地 `uploads/`；
  - 登录后上传到其他真实目录（`/api/upload?targetDir=`，服务端校验登录 + 目录存在）。

### 坑⑮ config.json 实时读
- 每次请求 `loadConfig()` 实时读文件，改 config.json 无需重启 API。
- `GET /api/gallery` 返回前 `publicConfig()` **剥离 passwordHash/passwordSalt**（绝不能让前端拿到哈希）。

### 坑⑯ GIF 合成判断
- 只有目录内文件名是「连续数字帧」（如 `image_001.png`…）才合成 GIF；单张图/非数字命名显示原图，不做 GIF（用户配的 `light1 拷贝.png` 之类显示原图属正常）。

### 坑⑰ 统一分组规则（3种展示→1种）
- **旧逻辑**：①有直图就拍平 ②无直图+1子目录→合并前缀 ③无直图+多子目录→分组 → 同结构目录出现3种不同展示。
- **新逻辑**（有子文件夹就分组，哪怕该目录同时含直图也不影响分组）：**有子文件夹→分组（不管1个多个、不管有无直图）；无子文件夹→拍平图片**。分组自身有直图时，直图作为分组内首个叶子项（不丢失）。
- **自动下钻**：`render()` 开头循环——当前层无直图且仅一个子目录（group/hasSub）时自动推进 `currentPath` 并 `saveNav()`（防死循环：guard 40 次 + `currentPath === only.relPath` 即停）。

### 坑⑱ 收藏图片重启后裂开（favorites.json 存了带端口的完整 URL）⚠️
- **现象**：收藏的图片重启/换端口后不显示（裂开）。`favorites.json` 里 `src` 存的是**完整 URL**（如 `http://fnos.local:3000/api/media?file=...`），零依赖重构后旧端口 `:3000` 已不存在 → 图片 404。
- **根因**：收藏时把 `p.src` 原样存盘，旧版 `p.src` 是动态 host + `:3000` 拼出来的完整 URL；端口一变就失效。
- **修复**（app.js `normalizeFavSrc()`）：加载收藏时把完整 URL 转成相对路径（`new URL(src)` 只保留 `pathname+search` → `/api/media?file=...`）；新增收藏时也先 normalize 再存。
- **防再犯**：**任何要持久化的资源地址一律存相对路径，绝不存带主机/端口的完整 URL**；换端口/换机不失效。

## 六、开发自检清单（改代码后必做）

```bash
# 1. 语法检查（全部后端模块）
for f in server/app.js server/lib/*.js server/routes/*.js; do node --check "$f" || echo "FAIL $f"; done

# 2. 启停 + 健康检查（脚本自带 8s 健康检查）
./start.sh restart
./start.sh status

# 3. 端点回归
for ep in /api/status /api/directories /api/images /api/gallery /api/favorites /api/uploaded /api/auto-update/status; do
  printf '%-28s %s\n' "$ep" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8081$ep")"
done

# 4. 用局域网真实 IP 访问，不要用 localhost 自欺
curl -s -o /dev/null -w '%{http_code}\n' http://10.10.10.193:8081/
```

- 改前端后**必须升 `index.html` 里的 `?v=` 版本号**（当前 43），否则浏览器用缓存旧 JS/CSS。
- 登录回归：未登录写操作须 401，登录后须 200（cookie 名 `session`）。
- 测试脚本若误改 `config.json`（如目录 category 被改成 `"all"`），记得恢复。

## 七、部署环境事实（迁移后核对）

- 当前部署目录：`<工作区>/gallery/`（工作区即 NAS 上的开发目录）。
- Node：`/var/packages/DeepSeekHarness-NAS/target/bin/node`（v22.23.2）。
- 同源项目（同一套框架与启停脚本）：`gamebanana-mods-downloader/`（8642）、`iwara-downloader/`（有自己的 `tool/node`）。
- 模板仓库：`dl-server-template/`（本项目的前端/后端框架素材与 `start.sh` 都来自它）。
- git：本项目已 init。已 gitignore：`sessions.json`/`favorites.json`/`config.json`/`cache-gifs/`/`uploads/`/`tools/`/`*.log`/lock 文件。
  `server/core/` 等 8 个框架子目录、`server/boot.cjs`、`server/lib/cjs-bootstrap.cjs` 是组装产物，同样不入库。

## 八、遗留

- 上传图片走 `POST /api/upload`（手写 multipart 解析，零依赖）→ 无 targetDir 存本地 `uploads/`，有 targetDir（登录）写真实目录；上传权限见坑⑭。
- 压缩包索引/解析表由本画廊自足（不再依赖 downloader fileIndex.json —— 旧画廊的做法已废弃，本项目直接扫目录 + zip 内图）。

## 九、版本记录

| 版本 | 日期 | 内容 |
|---|---|---|
| — | 2026-09-20 | **同步模板统一工具探测模块**：`server/lib/gif.js`（ffmpeg 选用）、`server/lib/archive.js`（7zz→7z 回退）、`server/store/data-backup.js`（zip/unzip）改走 `server/tool/tool-detect.js`（环境变量 → `tool/` 与 `tools/` → 系统路径，每级可用性实测、失败降级）；清单新增 `server/tool/tool-detect.js` 下发条目。工具探测行为不变（找不到仍兜底系统路径/裸名），只是查找逻辑统一且多一层可用性防护 |
| — | 2026-09-20 | **移除搬模板带进来的无引用文件 `search-date-range.cjs`**：该文件是「按时间搜索的日期窗口解析」，本项目既没有按时间搜索的路由、前后端也都没有引用它（全库 grep 为空）——gallery 不需要这个能力，它是清单从别的项目整份复制时一起带进来的。这类文件不报错、只是静静躺在项目里，要等有人照着它改代码才发现（本仓库此前已有同类先例：见下条 `login.html` 死代码）。已从 `assemble.json` 移除该条目，项目侧产物在下次组装时即消失。另：模板新增 `--dry-run` 组装预演与 `--check` 的「无引用」告警，专门用来在搬模板时提前发现这类问题 |
| — | 2026-09-19 | **README 同步目录分层**：正文 4 处仍写着旧的 `server/framework/`（顶部说明、目录表、两处「组装产物」清单），与实际结构不符，已改为 8 个框架子目录的实际路径。目录表由 1 行拆为 2 行，分别列入口/路由/鉴权/HTTP 与 配置/存储/更新/组装 |
| — | 2026-09-19 | **框架目录按功能分层**：`server/framework/` 由平铺 22 个文件改为 8 个子目录（`core/` `route/` `auth/` `http/` `config/` `store/` `update/` `assemble/`），功能边界从目录结构可读。清单相应由整目录条目改为逐文件条目；受影响文件的相对引用（含 `app.js` 的框架入口、`routes/*`、`lib/auto-update.js`）已同步改写。本项目自身业务代码除引用路径外无改动 |
| — | 2026-09-19 | **移除独立登录页，改为页面内登录弹窗**：本项目登录一直走 `index.html` 的 🔒 弹窗（`loginModal` + `POST /api/login`），`public/login.html` 是无人引用的死代码，却仍被组装清单分发、且内容是带 `@brand:` 占位符的蓝图旧版——占位符由运行期分片装配器替换，而静态页不走装配，故页面上会直接显示 `@brand:title@` 与裂图。现从清单移除 `blueprint/login.html`/`login.js` 两条，删除 `public/login.html`、`public/login.js`，`server/app.js` 的 `loginPath` 改为空串（配合框架 1.7.14 的「无独立登录页」支持） |
| — | 2026-09-19 | **接入 dl-server-template 框架**：`server/app.js` 由 1152 行单体拆为装配层 + `lib/` + `routes/`；自研 `auth.js` 由框架 `framework/auth.js` 取代；新增自动更新能力；上传改原生 handler（绕开框架 JSON 预读）；`routes/auth.js`、`routes/auto-update.js` 改用 `routes-adapter` 复用框架通用件（消除与 gbmd 的重复实现）；前端鉴权端点由 `/api/auth/*` 改为框架 `/api/status|login|logout`；启动脚本换成模板通用 `start.sh` |
