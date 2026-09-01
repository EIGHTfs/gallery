# 拾光集 — 局域网 Mod 图片画廊（零依赖）

> 取代旧画廊项目（旧 `gbmd-gallery` / `gallery` 已被删除，经验已全部并入本文档）。
> 访问入口：`http://<NAS-IP>:8081/`（如 `http://10.10.10.4:8081/`）。
> **零依赖**：纯 Node.js 内置模块（`http`/`fs`/`path`/`crypto`/`zlib`/`child_process`），不依赖 express/cors/multer，不需要 npm install，不需要 python3 静态服务。

## 一、项目是什么

一个跑在 NAS 局域网里的图片浏览画廊：按文件目录层级浏览图片、压缩包内图直出、序列帧合成 GIF、侧边栏目录树、分类筛选、i18n 中英、设置页（标题/图标/分类/目录/上传）、可选登录保护设置页。

**一个进程同时服务静态页 + API**（`node server.js` 即可），不需要额外开 python3 静态服务器，不需要 node_modules。

- 页面 + API：`http://<NAS-IP>:8081/`（同一个进程）

## 二、快速启动

目录结构学 `gamebanana-mods-downloader-server`：后端 `server/`，网页 `server/public/`，启动 `./start-linux.sh`（默认 **restart**）。

```bash
cd /Game.Patch\ N\ MOD/gallery          # SA6400 部署目录（CIFS 即 /vol02/1000-0-1c60be7b/gallery）
./start-linux.sh                        # 默认 restart，端口 8081
./start-linux.sh start --port 8081
./start-linux.sh stop
./start-linux.sh status
./start-linux.sh --set-password "新密码"
```

改完前端/后端代码后：**必须升 index.html 里的 `?v=` 版本号**（当前 39），否则用户浏览器缓存旧 JS/CSS 不生效（强刷 `Ctrl+F5` 可绕过，但对外发布务必升版本号）。

## 三、文件左右（文件结构说明）

| 文件 | 作用 | 备注 |
|---|---|---|
| `server/server.js` | 零依赖 API（默认 :8081，同端口静态页+API） | 纯 Node 内置模块 |
| `server/auth.js` | 登录：scrypt、session、HttpOnly cookie | 仿 gbmd-v3 |
| `server/config.json` | 设置：title/favicon/categories/directories/密码哈希 | 实时读，gitignore |
| `server/sessions.json` | session 持久化 | gitignore |
| `server/favorites.json` | 收藏 | gitignore |
| `server/public/` | 网页：index.html / app.js / style.css / api-client.js / locales / favicon | 学 downloader |
| `start-linux.sh` | 启停（默认 restart，`--port`，`--set-password`） | PID /tmp/gallery.pid，日志 server/server.log |
| `tools/` | `7zz`、`ffmpeg`/`ffmpeg-lib` | GIF/解压 |
| `uploads/` | 游客上传 | gitignore |
| `cache-gifs/` | GIF 缓存 | gitignore |

## 四、架构与工作方式

### 数据流
```
NAS 磁盘目录/压缩包 ──> server.js ──GET /api/directories、/api/images、/api/media、/api/zip/...──> 前端渲染
config.json ──────────────── GET/POST /api/gallery（设置，POST 需登录）
```

- 浏览（GET /api/*）：游客可访问全部内容。
- 设置（POST /api/gallery、上传、分类目录管理）：设置了密码后需登录（默认游客，未设密码则开放）。

### API 一览（server.js）
| API | 作用 | 鉴权 |
|---|---|---|
| `GET /api/directories` | 目录列表 | 开放 |
| `GET /api/images` | 图片列表（含目录扫描、zip 扫描） | 开放 |
| `GET /api/media?file=` | 图片流 | 开放 |
| `GET /api/zip/scan?dir=` | 压缩包条目 `{images}` | 开放 |
| `GET /api/zip/img?zip=&file=` | 压缩包内图片 | 开放 |
| `GET /api/gif?dir=&dur=` | 目录内序列帧合成 GIF | 开放 |
| `GET /api/zip/gif?zip=&file=&dur=` | 压缩包内序列帧合成 GIF | 开放 |
| `POST /api/upload` | 上传图片（无 targetDir → 本地 uploads/；有 targetDir → 需登录，写入真实目录） | 开放（无 targetDir）/**需登录**（有 targetDir） |
| `GET /api/gallery` | 读设置（剥离密码哈希） | 开放 |
| `POST /api/gallery` | 保存设置 | **需登录** |
| `GET /api/auth/status` | `{passwordSet, authed, sessionHours}` | 开放 |
| `POST /api/auth/login` | 校验密码、签发 HttpOnly cookie | 开放 |
| `POST /api/auth/logout` | 注销、清 cookie | 开放 |
| `GET /api/favorites` | 收藏图片列表 | 开放 |
| `POST /api/favorites` | 添加收藏 | **需登录** |
| `DELETE /api/favorites` | 移除收藏 | **需登录** |
| `GET /api/uploaded` | 列出本地 uploads/ 目录图片（游客上传持久） | 开放 |

### 前端关键点（app.js）
- **同源 API**：零依赖后静态页与 API 同端口，`API_ROOT=''`，`credentials:'same-origin'`（原跨端口动态 host 方案已废弃，见坑①）。
- **目录树**：`buildDirTreeFor()` + `renderDirTree()` 递归渲染，深层高亮需祖先链展开（见坑⑦）。
- **折叠+分组（foldChain）**：`currentScope()` 收集子目录 → **统一规则：有子文件夹就分组（不管1个多个、不管有无直图），无子文件夹就拍平图片**；分组递归（分组里的分组也是分组），嵌套分组独占一行、字体逐层缩小区分层级；分组默认折叠，展开状态存 `localStorage('galleryExpandedGroups')`。
  - 分组交互：**名称部分点击=进入该目录**，**后面▲/▼符号=折叠/展开**（用户原话「前面进入文件夹，后面展开折叠」）。
  - 分组自身如有直图，直图作为分组内首个叶子项（不丢失）。
- **按目录导航（navByDir）**：每个根目录各自记录 `currentPath`（`navByDir: Map<rootPath, currentPath>`），切换分类时恢复该目录上次路径；localStorage 按浏览器天然隔离（不同设备各自独立路径）。
- **侧边栏折叠/展开**：已展开（ancestor）的节点点击=折叠不导航；未展开的节点点击=展开+导航；折叠状态存 `localStorage('galleryCollapsedTreeNodes')`。
- **路径后退/前进**：面包屑前后有 `< >` 按钮，`navHistory` 栈记录每次导航状态，后退/前进移动指针恢复 `{activeDir, currentPath, activeFilter}`；初始状态入栈，导航后 `pushNavHistory()` 截断前进栈。
- **Lightbox 滑动切换**：触摸水平滑动（`touchstart/touchmove/touchend`，dx>40 切换）、鼠标滚轮（`wheel`，防默认滚动）、键盘左右键、Prev/Next 按钮——四种切换方式。
- **Lightbox 下载**：`fetch` blob → `URL.createObjectURL` → `a.download`；回退 `window.open`。
- **卡片行预览滑动**：**没点开时**在图片行上按住横向拖动 → 行滚动（`gridDrag` mousedown/mousemove/mouseup，位移>4px 判定为拖动并 `preventDefault`；捕获阶段拦截 click 防误开卡片）——用户原话「点开滑动确实实现了，但我其实想要的是没点开时那种的滑动」。
- **收藏功能**：预设"🩷 收藏"分类（不可删改）；`favorites.json` 持久化；`GET /api/favorites`（开放，游客可看）；`POST/DELETE /api/favorites`（需登录）；lightbox 🩷 按钮切换收藏，已收藏卡片显示 ❤️ 角标；收藏视图平铺所有收藏图片；**收藏 src 规范化 `normalizeFavSrc()`**：旧数据若存完整 URL（含端口）→ 转成相对 `/api/media?file=...`（修复重启后收藏图片裂开，见坑⑱）。
- **收藏 Lightbox 来源路径**：在收藏分类打开图片时，下方描述额外显示 `📁 来源绝对路径`（存 `path` 字段；老收藏用 `root` 兜底）——用户原话「收藏里面的图片可以点开后描述来源路径」。
- **上传权限**（用户原话「上传功能不能上传到收藏目录；不登录只能上传到预设分类游客，项目本地实际存储」）：`handleFiles()` 判定——①`activeFilter==="favorites"` 时禁止上传（提示"收藏分类不可上传"）；②未登录（游客）→ 只能上传到预设「👤 游客」分类，文件存项目本地 `uploads/`（`/api/upload` 无 targetDir）；③登录后 → 若当前在真实目录 `activeDir`，带 `targetDir` 上传直接写入该目录（`/api/upload?targetDir=`，服务端校验登录+目录存在），否则存本地。游客分类图片 = 服务端 `/api/uploaded`（持久）+ 本次会话前端上传（按 src 去重）。
- **顶部分类可滑动导航**：`.nav-scroll` 包裹（`flex:1; min-width:0; overflow-x:auto`）内分类按钮横向滑动；搜索框窄一半（`width:100px`，聚焦 130px）——用户原话「顶部分类太多会很挤，搞成一个div包裹（动态宽度）里面分类可以滑动，搜索编辑框也就顺带窄一半」。
- **压缩包折叠**：`galleryCollapsedZips` 持久化收起/展开。
- **GIF 合成**：`detectFramesFromNames()` 识别连续数字帧 → 请求 `/api/gif` 或 `/api/zip/gif`；缓存 `cache-gifs/`。
- **长按/右键**：~~`contextmenu` 仅 img preventDefault；无 pointerdown 监听，不影响滑动与单击~~ **已按用户要求放开**（2026-09-01 注释掉 contextmenu 屏蔽与 img 的 user-select/touch-callout/user-drag，允许长按/右键保存图片）。
- **登录 UI**：`refreshAuth()` 读 `/api/auth/status` → 未登录只显 🔒 无 ⚙，登录后只显 ⚙ 无 🔒（退出登录入口移到设置面板内 `#settingsLogout`）。
- **设置面板**：右侧固定浮层（`position:fixed; right:-420px→0`），折叠展开不挤压图片区域。
- **i18n**：`LANGS=['zh-CN','en']`、`localStorage('galleryLang')`、`t(key,vars)`、`data-i18n` 静态填充。
- **性能优化**：① 服务端 scan cache（`IMAGE_SCAN_CACHE`，30s mtime 探测，首次 9.7s→缓存 0.19s）；② `dirAgg` 预计算（每张图向所有祖先目录贡献，`statDir` O(N)→O(1)，render 6.2s→176ms）；③ `<img loading="lazy" decoding="async">` 延迟加载。

## 五、开始的坑（踩坑全记录，重点）

### 坑①（已解决）localhost 局域网访问没数据 ⚠️（零依赖后同源，已不复现）
- **历史现象**：旧版 `api.js` 硬编码 `const API_BASE = 'http://localhost:3000/api'`。本机访问正常，但**局域网其他设备访问 `http://10.10.10.4:8080/` 时，页面里所有 API 请求都发到「访问者自己电脑的 localhost:3000」→ 连不上 → 画廊空白/没数据/报错**。
- **历史修复**：前端 API 地址用 `window.location.hostname` 动态拼。
- **2026-09 零依赖重构后**：静态页与 API **同一进程同一端口 8080**，前端 `API_ROOT=''`、`API_BASE='/api'`（相对路径），无论从哪个地址访问都自动同源，彻底消灭跨端口问题。
- **防再犯**：写 Web 前端，凡是跨设备访问的服务，API 地址用相对路径/`window.location` 动态拼，**绝不硬编码 localhost/127.0.0.1/端口**。收工前用局域网真实 IP 验证一遍。

### 坑② API 前缀 `/api` 必须完整
- 曾把资源 URL 用不含 `/api` 的 `API_ROOT` 拼（如 `API_ROOT + '/media?...'`），导致 404。
- 规则：接口全走 `API_BASE + '/api/...'`；`apiUrl()` 只用于拼媒体直链时也要注意——GIF/zip 图片一律走带 `/api` 的 `/api/gif`、`/api/zip/gif`、`/api/zip/img`。

### 坑③ 压缩包显示需求三连坑（用户批评过"自己误解错了还又改回来"）
1. 平铺成散图（错）
2. 独立显示「压缩包」分组/标题（错）
3. **压缩包内图直接显示在文件夹分组、不显示压缩包标题**（对）
- 用户说"不要显示压缩包" = 不显示压缩包本身，但要显示内图；"解析到压缩包那一层" = 压缩包内图要解析出来。zip 组**无标题**，异步加载内图并入同名 mod 文件夹分组（散图+压缩包同框）。
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
- 修复③（折叠/展开）：用户原话「已展开点击=折叠不导航，未展开点击=展开+导航」。加 `collapsedTreeNodes` Set（`localStorage('galleryCollapsedTreeNodes')`），展开条件 = `(active || isAncestor) && !collapsedTreeNodes.has(nodeKey)`；点击已展开节点→折叠（加入 set），点击未展开→导航进入（自动展开）。

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
- 用户明确否决窄屏适配：手机窄屏下 sidebar 240px、.main 窄，**保持现状**，不做响应式折行改动。图片横向滑动只影响文件夹图片行。

### 坑⑭ 登录语义 + 上传权限
- 「不登录也能访问，不强制登录，默认游客，登录了才能显示和修改设置」：
  - 浏览全部 GET 开放；
  - 设置了密码后，未登录只显 🔒 无 ⚙；登录成功只显 ⚙ 无 🔒，退出登录入口在设置面板内；
  - 游客点设置弹登录框，登录成功自动打开设置；
  - **未设密码时全部开放**，`--set-password` 设密码后启用登录限制。
- **上传权限**（用户原话「上传功能不能上传到收藏目录；除此之外其他目录登录之后可以上传；不登录只能上传到预设分类游客，项目本地实际存储」）：
  - 收藏分类禁止上传（前端拦截提示）；
  - 未登录（游客）只能上传到预设「游客」分类，文件存项目本地 `uploads/`；
  - 登录后上传到其他真实目录（`/api/upload?targetDir=`，服务端校验登录 + 目录存在）。

### 坑⑮ config.json 实时读
- 每次请求 `loadConfig()` 实时读文件，改 config.json 无需重启 API。
- `GET /api/gallery` 返回前 `publicConfig()` **剥离 passwordHash/passwordSalt**（绝不能让前端拿到哈希）。

### 坑⑯ GIF 合成判断
- 只有目录内文件名是「连续数字帧」（如 `image_001.png`…）才合成 GIF；单张图/非数字命名显示原图，不做 GIF（用户配的 `light1 拷贝.png` 之类显示原图属正常）。

### 坑⑰ 统一分组规则（3种展示→1种）
- **旧逻辑**：①有直图就拍平 ②无直图+1子目录→合并前缀 ③无直图+多子目录→分组 → 同结构目录出现3种不同展示，用户反馈「怎么搞出3种情况了，明明都应该是同一种」。
- **新逻辑**（用户原话「里面有单独图片，但这种情况下不影响，分组是里面有许多文件夹就分组」）：**有子文件夹→分组（不管1个多个、不管有无直图）；无子文件夹→拍平图片**。分组自身有直图时，直图作为分组内首个叶子项（不丢失）。
- **自动下钻**：`render()` 开头循环——当前层无直图且仅一个子目录（group/hasSub）时自动推进 `currentPath` 并 `saveNav()`（防死循环：guard 40 次 + `currentPath === only.relPath` 即停）。

### 坑⑱ 收藏图片重启后裂开（favorites.json 存了带端口的完整 URL）⚠️
- **现象**：收藏的图片重启/换端口后不显示（裂开）。`favorites.json` 里 `src` 存的是**完整 URL**（如 `http://fnos.local:3000/api/media?file=...`），零依赖重构后旧端口 `:3000` 已不存在 → 图片 404。
- **根因**：收藏时把 `p.src` 原样存盘，旧版 `p.src` 是动态 host + `:3000` 拼出来的完整 URL；端口一变就失效。
- **修复**（app.js `normalizeFavSrc()`）：加载收藏时把完整 URL 转成相对路径（`new URL(src)` 只保留 `pathname+search` → `/api/media?file=...`）；新增收藏时也先 normalize 再存。
- **防再犯**：**任何要持久化的资源地址一律存相对路径，绝不存带主机/端口的完整 URL**；换端口/换机不失效。

## 六、开发自检清单（改代码后必做）

```bash
node --check server/server.js && node --check app.js && node --check server/auth.js
./start-linux.sh restart --port 8081
curl -s http://10.10.10.4:8081/api/auth/status
curl -s http://10.10.10.4:8081/api/gallery | python3 -m json.tool
# 用局域网真实 IP 访问 http://10.10.10.4:8081/ ，不要用 localhost 自欺
```

- 升 `?v=` 版本号后，让用户强刷一次。
- 登录相关回归用 CDP 脚本（verify_front.js 系），注意先 mock `window.prompt`。
- 测试脚本如果误改 config.json（如把目录 category 改成 `"all"`），记得手动恢复。

## 七、部署环境事实（迁移后核对）

- 本机 fnOS：`/vol02/1000-0-1c60be7b/...`（旧 SA6400 为 `/volume13/...`，CIFS 共享同一份）。
- 本项目目录：`/vol02/1000-0-1c60be7b/gallery/`（SA6400 共享 `Game.Patch N MOD/gallery`，与 downloader 同级）。
- 参考项目（勿删）：`/vol02/1000-0-1c60be7b/gamebanana-mods-downloader-server/`（下载器，start-linux.sh 模板来源）。
- git：本项目已 init，`sessions.json`/`node_modules`/`cache-gifs`/`uploads`/`*.log` 已 gitignore；改完记得提交。

## 八、遗留

- 上传图片走 `POST /api/upload`（手写 multipart 解析，零依赖）→ 无 targetDir 存本地 `uploads/`，有 targetDir（登录）写真实目录；上传权限见坑⑭。
- 压缩包索引/解析表由本画廊自足（不再依赖 downloader fileIndex.json —— 旧画廊的做法已废弃，本项目直接扫目录 + zip 内图）。
