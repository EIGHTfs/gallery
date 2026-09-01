# 目录扫描缓存与懒刷新（2026-08-24 加入）

## 背景

CIFS 网络挂载上递归 `readdirSync` 极慢——原神 gamebanana 目录 8559 个子目录/5.1 万文件，一次全量扫描耗时 **9.7 秒**；`loadAPIImages()` 串行请求每个配置目录时，总等待时间 = 各目录扫描之和（两个目录可能 >20s），页面完全卡死。

用户原话："手动添加了游戏目录，能加载，但是好卡……你是不是纯前端加载的，应该是前端加载逻辑问题。"

## 架构

借鉴旧项目（gbmd-gallery）的 `autoRefreshIngest` 机制：

| 层次 | 做法 | 效果 |
|------|------|------|
| 服务端 `/api/images` | 递归扫描一次后缓存 `{images, dirMtimes}`；后续请求 30s 内不 stat（直返缓存，0.19s），30s 后做一次性 mtime 探针（stat 全部已知目录 ≈2.8s），任一变化则全树重扫 | 正常浏览秒回；内容变化时最多 2.8s 探针 |
| 前端 `loadAPIImages` | `Promise.all(directories.map(...))` 并行请求所有目录 | 多目录总等待 = max(各目录耗时)，非 sum |
| 前端 `currentScope` | 排序按钮点击后 `sortBy` 状态切换 → render() → subDirs 与 group children 按新规则排序 | 修复"排序点完顺序不变"的 bug |

## 关键代码

- `server.js: IMAGE_SCAN_CACHE`（Map，key=绝对路径）
- `server.js: recursiveScanAll(dir)` 全树扫描 + 收集所有目录 mtime
- `server.js: scanCacheStillValid(cached)` 探针验证
- `app.js: loadAPIImages` 中 `Promise.all` 替代 `for...of`
- `app.js: render` 中 groups.forEach 展开前对 kids 排序

## 已知限制

- 文件内容修改（同名覆盖）不改变目录 mtime，缓存感知不到——需等 30s 兜底或刷新页面触发全量重扫
- 新增顶层目录结构（新增子目录树）会更新父目录 mtime，会被探测到
- 内存缓存占用：每目录 ≈ images 数组大小（原神 32188 张 × ~200B ≈ 6.4MB）
