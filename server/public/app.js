(() => {
  /* ─── State ─── */
  let activeFilter  = "all";    // selected category name, or "all"
  let activeDir     = null;     // 当前配置根目录 path
  let currentPath   = "";       // 当前相对路径（相对根目录，""=根）
  let searchQuery   = "";
  let sortBy        = "name";   // "name" | "count" | "time"
  let lightboxIdx   = -1;
  // “顶部导航栏前后加< >实现文件路径后退前进”
  let navHistory = [];           // 路径历史栈 [{activeDir, currentPath, activeFilter}, ...]
  let navHistoryIdx = -1;        // 当前指针（-1=空栈）
  let navHistorySuppress = false; // 恢复历史时不 push（防循环）
  // “增加收藏功能🩷，预设个不可删改的收藏分类，点了收藏的图片都会在里面平铺；登录用户可点收藏，游客可以看”
  let favoriteImages = [];       // 收藏图片列表 [{src, name, title, cat, ...}]
  let favoriteSrcs = new Set();  // 收藏 src 集合（快速查找）
  let authedUser = false;        // 是否登录（登录后才能点收藏）
  let galleryTitle  = "崩坏3";
  let favicon       = "";   // 由设置页决定：emoji 或图片 URL
  let loading       = false;

  let categories = [];          // [{ name, label, color }]
  let directories = [];         // [{ path, category }]
  let apiImages  = [];          // from server filesystem
  let userImages = [];          // locally uploaded
  let uploadedImages = [];      // 服务端 uploads/ 目录图片（游客上传，重启后仍可见）
  let lbList = [];              // 当前 lightbox 可浏览数组
  let collapsedZips = new Set(); // 手动收起的压缩包（key=zip路径）
  // 折叠状态持久化：localStorage
  const ZIPS_KEY = 'galleryCollapsedZips';
  const GROUPS_KEY = 'galleryExpandedGroups';
  const TREENODES_KEY = 'galleryCollapsedTreeNodes';
  let expandedGroups = new Set(); // 手动展开的分组（默认折叠，key=分组名）
  let collapsedTreeNodes = new Set(); // “侧边栏只能展开不能折叠”→ 手动折叠的侧边栏节点（key=rootPath|relPath）

  function loadCollapsed() {
    try {
      const z = JSON.parse(localStorage.getItem(ZIPS_KEY) || '[]');
      if (Array.isArray(z)) collapsedZips = new Set(z);
      const g = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]');
      if (Array.isArray(g)) expandedGroups = new Set(g);
      const tn = JSON.parse(localStorage.getItem(TREENODES_KEY) || '[]');
      if (Array.isArray(tn)) collapsedTreeNodes = new Set(tn);
    } catch (_) {}
  }
  function saveCollapsed() {
    try {
      localStorage.setItem(ZIPS_KEY, JSON.stringify([...collapsedZips]));
      localStorage.setItem(GROUPS_KEY, JSON.stringify([...expandedGroups]));
      localStorage.setItem(TREENODES_KEY, JSON.stringify([...collapsedTreeNodes]));
    } catch (_) {}
  }

  /* ─── 国际化：语言 JSON 驱动 ─── */
  const LANGS = ['zh-CN', 'en'];
  let lang = localStorage.getItem('galleryLang') || 'zh-CN';
  if (!LANGS.includes(lang)) lang = 'zh-CN';
  let i18n = {};   // 当前语言字典

  async function loadLang(l) {
    lang = l;
    localStorage.setItem('galleryLang', lang);
    try {
      const res = await fetch(`./locales/${lang}.json?t=${Date.now()}`);
      i18n = await res.json();
    } catch (e) {
      console.warn('lang load failed:', e);
      i18n = {};
    }
    document.documentElement.lang = lang;
    applyI18nStatic();
    const lb = document.getElementById("langBtn");
    if (lb) { lb.textContent = lang === "en" ? "EN" : "中"; lb.title = t("langSwitch"); }
    renderNavBtns();
    renderDirTree();
    render();
    renderSettings();
  }

  // 读取当前语言文本，支持 {n} 占位符
  function t(key, vars) {
    let s = i18n[key] != null ? i18n[key] : key;
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }

  // 一次性填充 index.html 的 data-i18n 静态文本
  function applyI18nStatic() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (i18n[key] != null) el.textContent = i18n[key];
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
      const key = el.dataset.i18nPh;
      if (i18n[key] != null) el.placeholder = i18n[key];
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.dataset.i18nTitle;
      if (i18n[key] != null) el.title = i18n[key];
    });
  }

  /* ─── DOM refs ─── */
  const gallery        = document.getElementById("gallery");
  const breadcrumb     = document.getElementById("breadcrumb");
  const dirTree        = document.getElementById("dirTree");
  const lightbox       = document.getElementById("lightbox");
  const lbImgCur       = document.getElementById("lbImgCur");
  const lbImgPrev      = document.getElementById("lbImgPrev");
  const lbImgNext      = document.getElementById("lbImgNext");
  const lbCarousel     = document.getElementById("lbCarousel");
  const lbInfo         = document.getElementById("lbInfo");
  const empty          = document.getElementById("empty");
  const collapseBtn    = document.getElementById("sidebarToggle");
  const app            = document.querySelector(".app");
  const searchInput    = document.getElementById("search");
  const settingsPanel  = document.getElementById("settingsPanel");
  const settingsBtn    = document.getElementById("settingsBtn");
  const loginBtn       = document.getElementById("loginBtn");
  const loginModal     = document.getElementById("loginModal");
  const loginClose     = document.getElementById("loginClose");
  const loginPassword  = document.getElementById("loginPassword");
  const loginError     = document.getElementById("loginError");
  const loginSubmit    = document.getElementById("loginSubmit");
  const galleryTitleInput = document.getElementById("galleryTitleInput");
  const faviconInput      = document.getElementById("faviconInput");
  const categoryList   = document.getElementById("categoryList");
  const dirList        = document.getElementById("dirList");
  const imageList      = document.getElementById("imageList");
  const uploadBtn      = document.getElementById("uploadBtn");
  const fileInput      = document.getElementById("fileInput");

  /* ─── Toast / Notification ─── */
  let toastTimer = null;
  function showNotification(msg, type = "info") {
    let toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = "toast show " + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  /* ─── Slug helper ─── */
  function slugify(text) {
    return text.toLowerCase().trim()
      .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "") || "cat-" + Date.now().toString(36);
  }

  /* ─── 标签页标题 + 图标（由设置页/config 决定） ─── */
  // “标签页图标也替换顶部栏的◆这个图标”——favicon 同时更新浏览器标签和顶部栏 logo
  function applyTabMeta() {
    document.title = galleryTitle || "拾光集";
    let fav = (favicon || "").trim();
    let href = "./favicon.svg";
    let logoContent = "◆"; // 默认
    if (fav) {
      if (/^https?:\/\//i.test(fav) || fav.startsWith("data:") || fav.startsWith("/") || fav.startsWith("./") || fav.startsWith("..")) {
        href = fav;
        logoContent = ""; // 图片 URL，用 <img> 显示
      } else {
        // emoji/单字符 → 内嵌 SVG 生成 data URI
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#7c5cfc"/><text x="32" y="42" font-size="38" text-anchor="middle" dominant-baseline="middle">${escapeHTML(fav)}</text></svg>`;
        href = "data:image/svg+xml," + encodeURIComponent(svg);
        logoContent = fav; // emoji 直接显示在顶部栏
      }
    }
    // 浏览器标签页图标
    let icon = document.querySelector('link[rel="icon"]');
    if (!icon) { icon = document.createElement("link"); icon.rel = "icon"; document.head.appendChild(icon); }
    icon.href = href;
    // 顶部栏 logo 图标（“替换顶部栏的◆”）
    const logoIcon = document.getElementById("logoIcon");
    if (logoIcon) {
      if (logoContent && !logoContent.startsWith("http")) {
        logoIcon.textContent = logoContent;
        logoIcon.innerHTML = ""; // 清除可能有的 img
        logoIcon.textContent = logoContent;
      } else if (logoContent === "" && fav) {
        logoIcon.textContent = "";
        logoIcon.innerHTML = `<img src="${escapeHTML(fav)}" alt="" style="width:1.2em;height:1.2em;vertical-align:middle"/>`;
      }
    }
  }

  /* ─── 登录：游客可浏览，登录后才能修改设置 ─── */
  let authed = false;       // 当前会话已登录
  let passwordSet = false;  // 服务端是否设置了访问密码

  async function refreshAuth() {
    try {
      const s = await window.API.apiAuthStatus();
      authed = !!s.authed;
      passwordSet = !!s.passwordSet;
    } catch (e) {
      authed = false; passwordSet = false;
    }
    updateAuthUI();
  }

  // 设置面板内「设置/修改密码」相关元素（提前取引用，updateAuthUI 会用到）
  const pwOldEl = document.getElementById("pwOld");
  const pwNewEl = document.getElementById("pwNew");
  const pwConfirmEl = document.getElementById("pwConfirm");
  const pwSubmitBtn = document.getElementById("pwSubmit");
  const pwErrorEl = document.getElementById("pwError");
  const pwOkEl = document.getElementById("pwOk");

  // 已设密码 → 显示旧密码框、按钮文案改「修改密码」；未设 → 首次设置
  function syncPasswordUI() {
    if (pwOldEl) pwOldEl.style.display = passwordSet ? "block" : "none";
    if (pwSubmitBtn) pwSubmitBtn.textContent = t(passwordSet ? "pwChange" : "pwSet");
  }

  function updateAuthUI() {
    if (!loginBtn || !settingsBtn) return;
    // “登录之前设置按钮不显示，点击锁了输入正确密码，显示设置按钮。然后不再显示🔒的图片”
    if (!passwordSet) {
      // 未设密码：无需登录，设置直接可用，不显锁
      loginBtn.style.display = "none";
      settingsBtn.style.display = "inline-block";
    } else if (authed) {
      // 已登录：只显⚙设置，不显🔒/🔓（logout 移到设置面板内）
      loginBtn.style.display = "none";
      settingsBtn.style.display = "inline-block";
    } else {
      // 游客：只显🔒登录，不显⚙设置
      loginBtn.style.display = "inline-block";
      loginBtn.textContent = "🔒";
      loginBtn.title = t("login");
      settingsBtn.style.display = "none";
    }
    // 设置面板内的 logout 按钮
    const settingsLogout = document.getElementById("settingsLogout");
    if (settingsLogout) settingsLogout.style.display = (passwordSet && authed) ? "block" : "none";
    syncPasswordUI();
  }

  function openLoginModal() {
    if (!loginModal) return;
    loginModal.classList.add("open");
    loginError.style.display = "none";
    loginPassword.value = "";
    setTimeout(() => loginPassword.focus(), 50);
  }
  function closeLoginModal() {
    if (loginModal) loginModal.classList.remove("open");
  }
  async function doLogin() {
    const pw = loginPassword.value || "";
    const r = await window.API.apiLogin(pw);
    if (r && r.ok) {
      authed = true;
      authedUser = true;            // 登录后立即可收藏（原来只设 authed，收藏按钮仍报未登录）
      closeLoginModal();
      updateAuthUI();
      showNotification(t("loginSuccess") || "登录成功", "success");
      // 登录后自动打开设置
      settingsPanel.classList.add("open");
      renderSettings();
      loadFavorites();              // 刷新收藏状态（authedUser / 收藏列表）
    } else {
      loginError.style.display = "block";
    }
  }
  async function doLogout() {
    await window.API.apiLogout();
    authed = false;
    authedUser = false;
    favoriteImages = [];
    favoriteSrcs = new Set();
    updateAuthUI();
    settingsPanel.classList.remove("open");
    showNotification(t("logoutSuccess") || "已退出登录", "success");
  }

  /* ─── Init: load config ─── */
  async function init() {
    loadCollapsed();
    await refreshAuth();
    try {
      const data = await window.API.apiGet("/gallery");
      galleryTitle = data.title || "崩坏3";
      favicon      = data.favicon || "";
      categories   = Array.isArray(data.categories) ? data.categories : [];
      directories  = Array.isArray(data.directories) ? data.directories : [];
      window.__GALLERY_FS_ROOT = data.fsRoot || "/";
    } catch (e) {
      console.warn("API init failed:", e);
    }
    await loadLang(lang);
    document.querySelector(".logo-text").textContent = galleryTitle;
    galleryTitleInput.value = galleryTitle;
    faviconInput.value = favicon;
    applyTabMeta();
    renderNavBtns();
    renderDirTree();
    render();
    await loadAPIImages();
    restoreNav();
    pushNavHistory();  // “顶部导航栏前后加< >实现后退前进”→ 初始状态入历史栈，导航后才能后退
    await loadFavorites();  // 加载收藏列表
    await loadUploaded();   // 加载服务端 uploads/ 目录图片（游客分类）
    renderDirTree();
    render();
  }

  /* ─── 游客分类图片（服务端 uploads/ 目录，重启后仍可见）─── */
  async function loadUploaded() {
    try {
      const list = await window.API.apiGet('/uploaded');
      uploadedImages = Array.isArray(list) ? list : [];
    } catch (_) { uploadedImages = []; }
  }

  /* ─── 收藏功能（“增加收藏功能🩷，预设个不可删改的收藏分类，登录可点收藏，游客可看”）─── */
  // 规范化收藏 src：旧数据可能存了完整 URL（含端口），重启/换端口后裂开
  // “重启过后，收藏下的图片裂开不能显示”→ 统一转成相对 /api/... 路径
  function normalizeFavSrc(src) {
    if (!src) return src;
    // 已经是相对路径 → 直接用
    if (!/^https?:\/\//i.test(src)) return src;
    try {
      const u = new URL(src);
      // 完整 URL → 只保留 pathname+search（同源后相对路径即可）
      return u.pathname + u.search;
    } catch (_) { return src; }
  }
  // 从 src 提取完整文件路径：/api/media?file=<urlencoded绝对路径> 或完整URL
  // 旧收藏没存 path，只有 root（根目录）；完整路径藏在 src 的 file 参数里
  // “图片路径明明有全路径，目录描述你只到根目录”→ 解析 file 参数补全
  function getPathFromSrc(src) {
    if (!src) return "";
    try {
      let file = src;
      // 若为完整 URL（http://host/api/media?file=...），取 pathname+search
      if (/^https?:\/\//i.test(src)) {
        const u = new URL(src);
        file = u.pathname + u.search;
      }
      const m = file.match(/[?&]file=([^&]+)/);
      if (!m) return "";
      const decoded = decodeURIComponent(m[1]);
      // 只保留绝对路径部分（若含主机前缀则去掉）
      return decoded;
    } catch (_) { return ""; }
  }
  async function loadFavorites() {
    try {
      const [favs, auth] = await Promise.all([
        window.API.apiGet('/favorites'),
        // 用 apiAuthStatus()（内部把框架 /status 的 needsAuth 转成 authed）判定登录态；
        // 不要直接 apiGet('/status')——框架返回 needsAuth 字段而非 authed，
        // 裸取 auth.authed 恒为 undefined → 已设密码时登录了 authedUser 仍为 false（收藏提示未登录）
        window.API.apiAuthStatus()
      ]);
      // 规范化 src（兼容旧数据完整 URL）
      favoriteImages = (Array.isArray(favs) ? favs : []).map(f => ({ ...f, src: normalizeFavSrc(f.src) }));
      favoriteSrcs = new Set(favoriteImages.map(f => f.src));
      authedUser = auth.needsSetup === true ? true : auth.authed === true;
    } catch (_) { favoriteImages = []; favoriteSrcs = new Set(); }
  }
  async function toggleFavorite(p) {
    if (!authedUser) { showNotification(t("loginFirst") || "请先登录", "warn"); return; }
    const src = normalizeFavSrc(p.src);
    if (!src) return;
    if (favoriteSrcs.has(src)) {
      // 移除收藏
      await window.API.apiDelete('/favorites', { src });
      favoriteSrcs.delete(src);
      favoriteImages = favoriteImages.filter(f => f.src !== src);
    } else {
      // 添加收藏（存相对 src + 来源路径，lightbox 里可显示路径）
      // “收藏里面的图片可以点开后描述来源路径”→ 保存 path/root
      const item = {
        src, name: p.name, title: p.title || p.name, cat: p.cat,
        dir: p.parentDir || p.dir, size: p.size,
        root: p.rootPath || activeDir,
        path: p.path || "",   // 绝对路径（lightbox 显示用）
      };
      await window.API.apiPost('/favorites', item);
      favoriteSrcs.add(src);
      favoriteImages.push({ ...item, src });
    }
    render();
  }

  /* ─── Load images: assign each to deepest matching directory ─── */
  // onlyRoot：只刷新指定根目录（上传后局部刷新，其他目录保留旧数据）
  // noCache：强制服务端跳过扫描缓存重新扫描（上传后立即看到新图）
  async function loadAPIImages(onlyRoot, noCache) {
    if (loading) return;
    loading = true;
    showNotification(t("loadingImages"), "info");

    const targets = onlyRoot
      ? directories.filter(d => d.path === onlyRoot)
      : directories;

    const rawMap = new Map();   // imagePath -> raw image
    // 并行请求目标目录（不串行等待；后端有扫描缓存后每个请求毫秒级）
    const results = await Promise.all(targets.map(async dir => {
      try {
        const qs = `/images?root=${encodeURIComponent(dir.path)}&recursive=true` + (noCache ? '&noCache=true' : '');
        return await window.API.apiGet(qs);
      } catch (e) {
        console.warn(`Failed to load ${dir.path}:`, e.message);
        return null;
      }
    }));
    for (const imgData of results) {
      if (!imgData) continue;
      for (const im of (imgData.images || [])) rawMap.set(im.path, im);
    }

    const deepest = [...directories].sort((a, b) => b.path.length - a.path.length);
    const mapped = Array.from(rawMap.values()).map(im => {
      const d = deepest.find(x => im.path.startsWith(x.path))
             || directories[0]
             || { category: "all", path: "" };
      // 真实目录层级：相对根目录的子路径
      const rootPath = d.path || "";
      const relPath = rootPath && im.path.startsWith(rootPath + "/")
        ? im.path.slice(rootPath.length + 1)
        : im.path;
      const slashIdx = relPath.lastIndexOf("/");
      const parentDir = slashIdx > 0 ? relPath.slice(0, slashIdx) : "";
      return {
        ...im,
        src:  window.API.apiUrl(im.url),
        rootPath,        // 所属配置根目录
        relPath,         // 相对根目录的完整相对路径（含文件名）
        parentDir,       // 相对根目录的父目录路径（"" 表示直接在根目录）
        cat:    d.category,
        dirId:  d.path,
        dirName: d.path.split("/").pop() || "Root",
        title: im.name.replace(/\.(jpg|jpeg|png|webp|gif)$/i, ""),
      };
    });

    if (onlyRoot) {
      // 只刷新该 root：保留其他 root 的图片，替换本 root 的
      apiImages = [...apiImages.filter(x => x.rootPath !== onlyRoot), ...mapped];
    } else {
      apiImages = mapped;
    }

    loading = false;
    showNotification(t("loadedImages", { n: apiImages.length }), "success");
    render();
  }

  /* ─── Nav buttons: one per category ─── */
  // “顶部的分类点了没有切换路径的功能，希望实现默认是根目录，分别记录用户点进去了哪个目录”
  // 【原代码】点击分类只设 activeFilter，不切换 activeDir → 分类筛选但目录不变
  // 【改为】点击分类 → 进入该分类对应根目录（默认根层），每个目录各自记录路径
  function renderNavBtns() {
    const nav = document.getElementById("nav");
    // "全部" 按钮 + "收藏" 按钮 + "游客"按钮（“预设个不可删改的收藏分类”“不登录只能上传到预设分类游客”）
    nav.innerHTML = `
      <button class="nav-btn ${activeDir === null && activeFilter !== "favorites" && activeFilter !== "guest" ? "active" : ""}" data-filter="all">${escapeHTML(t("all"))}</button>
      <button class="nav-btn ${activeFilter === "favorites" ? "active" : ""}" data-filter="favorites" style="${activeFilter === "favorites" ? "background:#e63946;color:#fff" : "color:#e63946"}">🩷 ${escapeHTML(t("favorites") || "收藏")}</button>
      <button class="nav-btn ${activeFilter === "guest" ? "active" : ""}" data-filter="guest" style="${activeFilter === "guest" ? "background:#2f9e44;color:#fff" : "color:#2f9e44"}">👤 ${escapeHTML(t("guest") || "游客")}</button>
      ${categories.map(c => {
        // 该分类下第一个目录是否就是当前 activeDir
        const dirs = directories.filter(d => d.category === c.name);
        const isActive = dirs.some(d => d.path === activeDir);
        return `
        <button class="nav-btn ${isActive ? "active" : ""}"
                data-filter="${c.name}"
                style="${isActive ? `background:${c.color};color:#fff` : ""}">
          ${escapeHTML(c.label)}
        </button>`;
      }).join("")}
    `;
    nav.querySelectorAll(".nav-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const filter = btn.dataset.filter;
        if (filter === "all") {
          // "全部" → 回到概览
          if (activeDir) { navByDir[activeDir] = currentPath; saveNav(); }
          activeDir = null;
          currentPath = "";
          activeFilter = "all";
          saveNav(); pushNavHistory();
          renderNavBtns();
          renderDirTree();
          render();
        } else if (filter === "favorites") {
          // 收藏 → 进入收藏视图（“点了收藏的图片都会在里面平铺”）
          if (activeDir) { navByDir[activeDir] = currentPath; saveNav(); }
          activeDir = null;
          currentPath = "";
          activeFilter = "favorites";
          saveNav(); pushNavHistory();
          renderNavBtns();
          renderDirTree();
          render();
        } else if (filter === "guest") {
          // 游客 → 显示本地上传图片（预设分类，不可删改）
          if (activeDir) { navByDir[activeDir] = currentPath; saveNav(); }
          activeDir = null;
          currentPath = "";
          activeFilter = "guest";
          saveNav(); pushNavHistory();
          renderNavBtns();
          renderDirTree();
          render();
        } else {
          // 点击分类 → 进入该分类对应的第一个根目录
          const dir = directories.find(d => d.category === filter);
          if (dir) switchDir(dir.path);
        }
      });
    });
  }

  /* ─── Directory tree (sidebar, hierarchical) ─── */
  // 构建当前根目录的完整目录树（只含实际存在图片的层级）
  function buildDirTreeFor(rootPath) {
    const root = { name: rootPath.split("/").pop() || rootPath, relPath: "", children: new Map() };
    apiImages.forEach(p => {
      if (p.rootPath !== rootPath) return;
      const parts = (p.relPath || "").split("/").filter(Boolean);
      parts.pop(); // 去掉文件名
      let node = root;
      let acc = "";
      parts.forEach(part => {
        acc = acc ? acc + "/" + part : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, relPath: acc, children: new Map() });
        node = node.children.get(part);
      });
    });
    return root;
  }

  function renderDirTree() {
    if (!categories.length) { dirTree.innerHTML = ""; return; }
    let html = `<li class="dir-item ${activeDir === null ? "active" : ""}"
        data-root="all"><span class="dir-icon">◈</span><span>${escapeHTML(t("all"))}</span></li>`;

    // Group configured roots by category
    const catOrder = {};
    categories.forEach((c, i) => catOrder[c.name] = i);
    const grouped = {};
    directories.forEach(d => {
      const cat = catOrder[d.category] !== undefined ? d.category : (categories[0]?.name || "all");
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(d);
    });

    const activeRoot = activeDir;
    const activePath = currentPath;

    categories.forEach(c => {
      const dirs = grouped[c.name] || [];
      if (!dirs.length) return;
      html += `<li class="dir-group">
        <span class="dir-group-label" style="color:${c.color}">
          <span class="dot" style="background:${c.color}"></span>${escapeHTML(c.label)}
        </span>
        <ul>`;
      dirs.forEach(d => {
        const name = d.path.split("/").pop() || d.path;
        const isActiveRoot = activeRoot === d.path;
        // 高亮当前激活的文件夹节点
        const cls = (activeRoot === d.path && !currentPath) ? "active" : "";
        html += `<li class="dir-item ${cls}" data-root="${escapeHTML(d.path)}" data-path="">
          <span class="dir-icon">${isActiveRoot ? "🗂" : "📁"}</span><span title="${escapeHTML(d.path)}">${escapeHTML(name)}</span>
        </li>`;
        // 若当前就在这个根目录内，展开它的子目录树
        if (isActiveRoot) {
          const tree = buildDirTreeFor(d.path);
          html += renderTreeChildren(tree, activePath, 1, d.path);
        }
      });
      html += `</ul></li>`;
    });
    dirTree.innerHTML = html;
  }

  // “侧边栏只能展开不能折叠”→ 已展开(ancestor)点击=折叠不导航；未展开点击=展开+导航
  // 【原代码】展开条件 = active || isAncestor（无法手动折叠）
  // 【改为】展开条件 = (active || isAncestor) && !collapsedTreeNodes.has(key)（手动折叠后不展开）
  function renderTreeChildren(parentNode, activePath, depth, rootPath) {
    let html = "";
    parentNode.children.forEach(child => {
      const active = activePath === child.relPath;
      const isAncestor = !!activePath && (activePath === child.relPath || activePath.startsWith(child.relPath + "/"));
      const nodeKey = rootPath + "|" + child.relPath;
      const manuallyCollapsed = collapsedTreeNodes.has(nodeKey);
      const expanded = (active || isAncestor) && !manuallyCollapsed;
      const hasKids = child.children.size > 0;
      // 有子节点且展开着 → ▾；有子节点但折叠 → ▸；无子节点 → 📁
      const icon = hasKids ? (expanded ? "▾" : "▸") : "📁";
      html += `<li class="dir-item ${active ? "active" : ""} ${manuallyCollapsed ? "collapsed" : ""}" data-root="${escapeHTML(rootPath)}" data-path="${escapeHTML(child.relPath)}" data-node-key="${escapeHTML(nodeKey)}" style="padding-left:${30 + depth * 16}px">
        <span class="dir-icon">${icon}</span><span title="${escapeHTML(child.relPath)}">${escapeHTML(child.name)}</span>
      </li>`;
      if (expanded && hasKids) html += renderTreeChildren(child, activePath, depth + 1, rootPath);
    });
    return html;
  }

  function escapeHTML(str) {
    return String(str ?? "").replace(/[&<>"']/g, m => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
  }

  // 时间戳 → 短日期 2024-01-05
  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 字节 → 可读大小
  function fmtSize(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // ─── 路径保存/还原（刷新回到上次文件夹）───
  // “分别记录用户点进去了哪个目录”→ 每个根目录独立记录 currentPath
  // 【原代码】saveNav 只存一个 {activeDir, currentPath} → 切目录会覆盖上个目录的路径
  // 【改为】navByDir: Map<rootPath, currentPath>，每个目录各自记录；activeDir 单独记
  function saveNav() {
    // 同步当前目录路径到 navByDir（“分别记录用户点进去了哪个目录”）
    if (activeDir) navByDir[activeDir] = currentPath;
    try {
      localStorage.setItem("galleryNav", JSON.stringify({
        activeDir,
        navByDir: navByDir
      }));
    } catch (_) {}
  }
  // “顶部导航栏前后加< >实现文件路径后退前进”
  // 路径历史栈：每次导航 push 状态；后退/前进移动指针恢复状态
  function pushNavHistory() {
    if (navHistorySuppress) return;  // 恢复历史时不 push（防循环）
    const state = { activeDir, currentPath, activeFilter };
    // 截断前进栈（当前指针之后的历史丢弃）
    navHistory = navHistory.slice(0, navHistoryIdx + 1);
    // 避免连续重复
    const last = navHistory[navHistory.length - 1];
    if (last && last.activeDir === state.activeDir && last.currentPath === state.currentPath) return;
    navHistory.push(state);
    navHistoryIdx = navHistory.length - 1;
  }
  function navBack() {
    if (navHistoryIdx <= 0) return;
    navHistoryIdx--;
    const s = navHistory[navHistoryIdx];
    navHistorySuppress = true;
    activeDir = s.activeDir; currentPath = s.currentPath; activeFilter = s.activeFilter;
    saveNav(); renderNavBtns(); renderDirTree(); render();
    navHistorySuppress = false;
  }
  function navForward() {
    if (navHistoryIdx >= navHistory.length - 1) return;
    navHistoryIdx++;
    const s = navHistory[navHistoryIdx];
    navHistorySuppress = true;
    activeDir = s.activeDir; currentPath = s.currentPath; activeFilter = s.activeFilter;
    saveNav(); renderNavBtns(); renderDirTree(); render();
    navHistorySuppress = false;
  }

  // 每个根目录各自记录的 currentPath（切换目录时恢复）
  let navByDir = {};   // rootPath -> currentPath

  function restoreNav() {
    try {
      const s = localStorage.getItem("galleryNav");
      if (!s) return;
      const o = JSON.parse(s);
      if (o && o.navByDir) navByDir = o.navByDir;
      if (o && o.activeDir && directories.some(d => d.path === o.activeDir)) {
        activeDir = o.activeDir;
        currentPath = navByDir[activeDir] || "";
      }
    } catch (_) {}
  }

  // 切换根目录时：保存旧目录路径 → 设新 activeDir → 恢复新目录路径
  function switchDir(newDir) {
    // 保存当前目录路径
    if (activeDir) navByDir[activeDir] = currentPath;
    activeDir = newDir;
    currentPath = navByDir[newDir] || "";  // 恢复该目录上次路径（默认根目录）
    activeFilter = "all";
    saveNav();
    pushNavHistory();
    renderNavBtns();
    renderDirTree();
    render();
  }

  // ─── 序列帧检测（搬运自 gbmd-gallery）───
  // names: 图片名数组 → 是否有 ≥3 张“前缀+数字+扩展名”连续帧
  function detectFramesFromNames(names) {
    if (!names || names.length < 3) return false;
    const byPre = {};
    for (const n of names) {
      const m = String(n).match(/^(.*?)(\d+)(\.\w+)$/);
      if (!m) continue;
      (byPre[m[1]] = byPre[m[1]] || []).push(parseInt(m[2], 10));
    }
    let best = 0;
    for (const ns of Object.values(byPre)) {
      ns.sort((a, b) => a - b);
      let run = 1;
      for (let i = 1; i < ns.length; i++) {
        if (ns[i] - ns[i - 1] === 1) { run++; if (run > best) best = run; }
        else run = 1;
      }
      if (ns.length && best < 1) best = ns.length ? 1 : 0;
    }
    return best >= 3;
  }

  // 帧播放时间解析："2s"/"500ms"/"@40ms" → 每帧毫秒；无则 0（默认总时长2秒）
  function parseFrameMs(name) {
    if (!name) return 0;
    let m = String(name).match(/(\d+(?:\.\d+)?)\s*(?:s|sec|秒)/i);
    if (m) { const v = Math.round(parseFloat(m[1]) * 1000); return v > 0 ? v : 0; }
    m = String(name).match(/(\d+)\s*ms/i);
    if (m) { const v = parseInt(m[1], 10); return v > 0 ? v : 0; }
    return 0;
  }

  // ─── 压缩包：当前目录下 zip/7z/rar 扫描 + 内图平铺 ───
  const ZIP_EXT_RE = /\.(zip|7z|rar)$/i;
  function scanZipsInDir(absDir) {
    return window.API.apiGet(`/zip/scan?dir=${encodeURIComponent(absDir)}`)
      .then(j => (j && j.zips) || [])
      .catch(() => []);
  }

  function zipImgUrl(zipPath, fileName) {
    return `${window.API.apiUrl(`/api/zip/img?path=${encodeURIComponent(zipPath)}&file=${encodeURIComponent(fileName)}`)}`;
  }
  function zipGifUrl(zipPath, durMs) {
    return `${window.API.apiUrl(`/api/zip/gif?path=${encodeURIComponent(zipPath)}&dur_ms=${durMs || 0}`)}`;
  }
  function dirGifUrl(absDir, durMs) {
    return `${window.API.apiUrl(`/api/gif?dir=${encodeURIComponent(absDir)}&dur_ms=${durMs || 0}`)}`;
  }

  /* ─── Filtering ─── */
  function getFiltered() {
    let list = [...apiImages, ...userImages];
    if (activeFilter !== "all") list = list.filter(p => p.cat === activeFilter);
    if (activeDir)             list = list.filter(p => p.dirId === activeDir);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p =>
        (p.title || "").toLowerCase().includes(q) ||
        (p.cat || "").toLowerCase().includes(q) ||
        (p.name || "").toLowerCase().includes(q)
      );
    }
    return list;
  }

  /* ─── 当前文件夹的内容：直接子文件夹 + 直接图片 ─── */
  // 目录 relPath -> 所属根目录（"全部" 视图时用于定位进入哪个根）
  /* dsh-skip-func-length：既有渲染主流程，拆分易引入显示回归，待独立重构 */
  function currentScope() {  // dsh-skip-func-length 既有渲染主流程，拆分易引入显示回归，待独立重构
    const subDirs = new Map();   // name -> {name, relPath, root, count, mtime}
    const images = [];
    const dirRoot = new Map();   // dirRelPath -> rootPath

    const pool = [...apiImages, ...userImages];
    // 第一遍：收集该根下所有目录路径（分类过滤影响目录可见性）
    pool.forEach(p => {
      const root = p.rootPath || p.dirId || "Uploaded";
      if (activeDir && root !== activeDir) return;
      if (activeFilter !== "all" && p.cat !== activeFilter) return;
      const rel = p.rootPath ? (p.relPath || "") : "";
      const parts = rel.split("/").filter(Boolean);
      parts.pop(); // 去掉文件名
      let acc = "";
      parts.forEach(part => {
        acc = acc ? acc + "/" + part : part;
        if (!dirRoot.has(acc)) dirRoot.set(acc, root);
      });
    });

    // 直接子文件夹：目录路径是 currentPath 的一级子
    const prefix = currentPath ? currentPath + "/" : "";
    dirRoot.forEach((root, d) => {
      const isChild = currentPath ? (d.startsWith(prefix) && !d.slice(prefix.length).includes("/"))
                                  : (!d.includes("/"));
      if (!isChild) return;
      const name = currentPath ? d.slice(prefix.length) : d;
      if (!subDirs.has(name)) subDirs.set(name, { name, relPath: d, root, count: 0, mtime: 0, hasSub: false, leafImages: [] });
    });

    // 判断每个子文件夹是否还有更深的子文件夹
    subDirs.forEach(sd => {
      for (const d of dirRoot.keys()) {
        if (d.startsWith(sd.relPath + "/")) { sd.hasSub = true; break; }
      }
    });

    // 第二遍：统计每个子文件夹的图片数量与最新时间，并收集当前目录直接图片
    pool.forEach(p => {
      const root = p.rootPath || p.dirId || "Uploaded";
      if (activeDir && root !== activeDir) return;
      if (activeFilter !== "all" && p.cat !== activeFilter) return;
      const rel = p.rootPath ? (p.relPath || "") : "";
      const parts = rel.split("/").filter(Boolean);
      const dir = parts.slice(0, -1).join("/");
      const mtime = (typeof p.modified === "number" ? p.modified
                    : p.modified ? new Date(p.modified).getTime() : 0) || 0;
      if (dir === currentPath) {
        if (!searchQuery || (p.title || p.name || "").toLowerCase().includes(searchQuery.toLowerCase())) images.push(p);
      }
      // 统计所属子文件夹（递归：包含其下所有层级的图片）
      subDirs.forEach(sd => {
        if (dir === sd.relPath || dir.startsWith(sd.relPath + "/")) {
          sd.count++;
          if (mtime > sd.mtime) sd.mtime = mtime;
          // 叶子文件夹：收集直接图片用于平铺
          if (!sd.hasSub && dir === sd.relPath) sd.leafImages.push(p);
        }
      });
    });

    /* ── 折叠 + 分组：无直图的纯子文件夹链 ──
       单链（只有1个子）→ 继续下钻合并前缀；
       分叉（多个子）→ 生成分组：标题=完整公共前缀链，组内=下一层短名文件夹卡片；
       有直图 → 拍平卡片（名含完整链），点击直达。 */
    // 目录父子关系 + 哪些目录有直接图片
    const childMap = new Map();          // 父目录relPath -> [子目录relPath]
    dirRoot.forEach((root, d) => {
      const i = d.lastIndexOf("/");
      const parent = i < 0 ? "" : d.slice(0, i);
      if (!childMap.has(parent)) childMap.set(parent, []);
      childMap.get(parent).push(d);
    });
    const dirHasImg = new Set();         // 有直接图片的目录
    // 预计算 dirAgg：每张图贡献给它路径上所有祖先目录（含自身目录）
    // “只想优化性能，不想改前端显示设计”→ statDir 从 O(N) 遍历 pool 改 O(1) 查表
    // 【思路】foldChain 会递归调 statDir 多次，每次 O(N) → O(S×N) 总慢；预计算后每张图只遍历一次 O(N×depth)
    const dirAgg = new Map();            // dir -> {count, mtime, leafImages}
    for (const p of pool) {
      const root = p.rootPath || p.dirId || "Uploaded";
      if (activeDir && root !== activeDir) continue;
      if (activeFilter !== "all" && p.cat !== activeFilter) continue;
      const rel = p.rootPath ? (p.relPath || "") : "";
      const parts = rel.split("/").filter(Boolean);
      const dir = parts.slice(0, -1).join("/");
      const mt = (typeof p.modified === "number" ? p.modified
                 : p.modified ? new Date(p.modified).getTime() : 0) || 0;
      if (dir) {
        dirHasImg.add(dir);
        // 贡献给 dir 及其所有祖先目录（含后代统计）
        const dirParts = dir.split("/");
        for (let i = dirParts.length; i >= 1; i--) {
          const ancestor = dirParts.slice(0, i).join("/");
          let agg = dirAgg.get(ancestor);
          if (!agg) { agg = { count: 0, mtime: 0, leafImages: [] }; dirAgg.set(ancestor, agg); }
          agg.count++;
          if (mt > agg.mtime) agg.mtime = mt;
          if (i === dirParts.length) agg.leafImages.push(p); // 仅直接目录收集
        }
      }
    }

    // 统计目录卡片信息（O(1) 查 dirAgg，不再遍历 pool）
    // 【原代码】function statDir(relPath, root, displayName) { for (const p of pool) { ... } } → O(N) per call
    // 【改为】“只想优化性能，不想改前端显示设计”→ 查预计算表，显示逻辑不变
    function statDir(relPath, root, displayName) {
      const agg = dirAgg.get(relPath) || { count: 0, mtime: 0, leafImages: [] };
      const hasSub = (childMap.get(relPath) || []).length > 0;
      return { name: displayName, relPath, root, count: agg.count, mtime: agg.mtime, hasSub, leafImages: hasSub ? [] : agg.leafImages };
    }

    // “里面有单独图片，但这种情况下不影响，分组是里面有许多文件夹就分组”“怎么搞出3种情况了，明明都应该是同一种”
    // 【旧逻辑】①有直图就拍平 ②无直图+1子目录→合并前缀 ③无直图+多子目录→分组 → 3种不同展示
    // 【新逻辑】有子文件夹→分组（不管1个多个、不管有无直图）；无子文件夹→拍平图片 → 统一1种展示
    // 分组自身如有直图，直图作为分组内首个叶子项（不丢失）
    function foldChain(rel, displayName, root) {
      const kids = childMap.get(rel) || [];
      if (kids.length > 0) {
        // 有子文件夹 → 分组（不再合并前缀；不再因有直图拍平）
        const children = kids.map(k => {
          const r = foldChain(k, k.split("/").pop(), root);
          if (r && r.card)  return r.card;
          if (r && r.group) return r.group;
          return statDir(k, root, k.split("/").pop());
        });
        // 该目录自身也有直图 → 在 children 前面加一个直图叶子项（不丢失直图）
        if (dirHasImg.has(rel)) {
          const ownAgg = dirAgg.get(rel);
          if (ownAgg && ownAgg.leafImages && ownAgg.leafImages.length) {
            children.unshift({
              name: "(" + t("directImg") + ")", relPath: rel, root,
              count: ownAgg.leafImages.length, mtime: ownAgg.mtime,
              hasSub: false, leafImages: ownAgg.leafImages
            });
          }
        }
        return { group: {
          isGroup: true, name: displayName, relPath: rel, root,
          count: children.reduce((s, c) => s + (c.count || 0), 0),
          mtime: Math.max(0, ...children.map(c => c.mtime || 0)),
          children
        }};
      }
      // 无子文件夹 + 有直图 → 拍平 card
      if (dirHasImg.has(rel)) return { card: statDir(rel, root, displayName) };
      return null; // 无子无图（不应出现）
    }

    // 变换：有子文件夹 → foldChain 分组；无子文件夹 → 保留原样（叶子/空目录）
    // 【旧逻辑】if (dirHasImg.has(sd.relPath) || !kids.length) → 有直图也直接 push 不分组
    // 【新逻辑】只有 !kids.length 才直接 push；有 kids 就走 foldChain → 统一分组
    const flat = [];
    for (const sd of Array.from(subDirs.values())) {
      const kids = childMap.get(sd.relPath) || [];
      if (!kids.length) { flat.push(sd); continue; }
      const r = foldChain(sd.relPath, sd.name, sd.root);
      if (r && r.group) { const g = r.group; if (!flat.find(x => x.isGroup && x.name === g.name)) flat.push(g); }
      else if (r && r.card) { const c = r.card; if (!flat.find(x => x.relPath === c.relPath)) flat.push(c); }
    }

    const list = flat;
    if (sortBy === "count") list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    else if (sortBy === "time") list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    else list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return { subDirs: list, images };
  }

  /* ─── Render gallery (browser: current folder subdirs + images) ─── */
  // 卡片构造（图片/GIF/压缩包内图统一）；opts: { dir, zipName, noGif }
  function makeCard(p, opts = {}) {
    const card = document.createElement("div");
    card.className = "card" + (p.isGif ? " gif-card" : "");
    const title = p.title || p.name || "Untitled";
    const cat   = p.cat   || "unknown";
    const catMeta = categories.find(c => c.name === cat);
    const dir   = opts.dir || p.dirName || p.dir || "";
    const size  = p.size || "";
    const tag = p.isGif
      ? `<span class="card-tag" style="background:rgba(244,114,182,.9)">GIF ${p.frameCount || ""}${escapeHTML(t("gifFramesUnit"))}</span>`
      : `<span class="card-tag" style="background:${catMeta?.color || "rgba(0,0,0,.5)"}">${escapeHTML(catMeta?.label || cat)}</span>`;
    // 已收藏的图片显示 ❤️ 角标（“点了收藏的图片都会在里面平铺”）
    const favMark = favoriteSrcs.has(p.src) ? `<span class="card-fav">❤️</span>` : "";
    card.innerHTML = `
      <img src="${escapeHTML(p.src || "")}" alt="${escapeHTML(title)}" loading="lazy" decoding="async" draggable="false"/>
      ${tag}
      ${favMark}
      <div class="card-overlay">
        <div class="card-title">${escapeHTML(title)}</div>
        <div class="card-meta">${escapeHTML(dir)}${size ? " · " + size : ""}</div>
      </div>`;
    card.addEventListener("click", () => {
      const arr = opts.lbList || [p];
      const idx = arr.findIndex(x => (x.path || x.src) === (p.path || p.src));
      openLightbox(idx >= 0 ? idx : 0, arr);
    });
    return card;
  }

  /* dsh-skip-func-length：既有渲染主流程，拆分易引入显示回归，待独立重构 */
  function render() {  // dsh-skip-func-length 既有渲染主流程，拆分易引入显示回归，待独立重构
    // “增加收藏功能🩷，预设个不可删改的收藏分类，点了收藏的图片都会在里面平铺”
    if (activeFilter === "favorites") {
      gallery.innerHTML = "";
      empty.style.display = "none";
      gallery.style.display = "";
      const sortBar = document.createElement("div");
      sortBar.className = "sort-bar";
      sortBar.innerHTML = `<span class="sort-count">🩷 ${favoriteImages.length} ${escapeHTML(t("imagesCount"))}</span>`;
      gallery.appendChild(sortBar);
      // “收藏里面来自每个分类各一行，不都在一行”→ 按分类分组，每分类一个 section
      // cat 缺失的老收藏：用 root 路径匹配已配置目录反推分类，反推不到才归“未分类”
      const favCat = (p) => {
        if (p.cat) return p.cat;
        const roots = [p.root, p.dir, p.path].filter(Boolean);
        const byPath = [...directories].sort((a, b) => b.path.length - a.path.length);
        for (const r of roots) {
          const hit = byPath.find(d => r && (r === d.path || r.startsWith(d.path + "/")));
          if (hit) return hit.category;
        }
        return "__uncat__";
      };
      const byCat = new Map();
      for (const p of favoriteImages) {
        const cat = favCat(p);
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat).push(p);
      }
      // 分类顺序：按已配置 categories 顺序，未知/未分类放最后
      const catOrder = new Map(categories.map((c, i) => [c.name, i]));
      const keys = [...byCat.keys()].sort((a, b) =>
        (catOrder.has(a) ? catOrder.get(a) : 999) - (catOrder.has(b) ? catOrder.get(b) : 999)
        || a.localeCompare(b, "zh-CN"));
      for (const cat of keys) {
        const imgs = byCat.get(cat);
        const catMeta = categories.find(c => c.name === cat);
        const label = cat === "__uncat__" ? (t("uncategorized") || "未分类") : (catMeta?.label || cat);
        const section = document.createElement("div");
        section.className = "dir-section";
        const header = document.createElement("div");
        header.className = "dir-section-header group";
        header.innerHTML =
          `<span class="dir-section-icon">🩷</span>` +
          `<span class="dir-section-name">${escapeHTML(label)}</span>` +
          `<span class="dir-section-meta">${imgs.length} ${escapeHTML(t("imagesCount"))}</span>`;
        section.appendChild(header);
        const grid = document.createElement("div");
        grid.className = "dir-grid";
        imgs.forEach(p => grid.appendChild(makeCard(p, { dir: p.dir || "", lbList: favoriteImages })));
        section.appendChild(grid);
        gallery.appendChild(section);
      }
      renderBreadcrumb(favoriteImages, favoriteImages.length);
      return;
    }
    // 游客分类（预设，“不登录只能上传到预设分类游客，项目本地实际存储”）
    if (activeFilter === "guest") {
      gallery.innerHTML = "";
      empty.style.display = "none";
      gallery.style.display = "";
      // 服务端 uploads/（持久）+ 本次浏览期内前端上传（去重，按 src）
      const seen = new Set();
      const guestImgs = [];
      [...uploadedImages, ...userImages.filter(p => p.cat === "guest")].forEach(p => {
        const k = p.src || p.id || "";
        if (!k || seen.has(k)) return;
        seen.add(k);
        guestImgs.push(p);
      });
      const sortBar = document.createElement("div");
      sortBar.className = "sort-bar";
      sortBar.innerHTML = `<span class="sort-count">👤 ${guestImgs.length} ${escapeHTML(t("imagesCount"))}</span>`;
      gallery.appendChild(sortBar);
      const grid = document.createElement("div");
      grid.className = "dir-grid";
      guestImgs.forEach(p => grid.appendChild(makeCard(p, { dir: p.dir || "", lbList: guestImgs })));
      gallery.appendChild(grid);
      renderBreadcrumb(guestImgs, guestImgs.length);
      return;
    }
    // 自动下钻：当前层无直图且只有一个折叠链子目录（如 Mods → Mods/.Mods）→ 直接进入内部
    let guard = 0;
    while (guard++ < 40) {
      const sc = currentScope();
      if (sc.images.length) break;                       // 有直图 → 停
      if (sc.subDirs.length !== 1) break;                // 非单目录 → 停
      const only = sc.subDirs[0];
      if (!only.isGroup && !only.hasSub) break;          // 空子目录 → 停（防死循环）
      if (currentPath === only.relPath) break;           // 防重复
      currentPath = only.relPath;
      saveNav();
    }
    const { subDirs, images } = currentScope();
    // 有子文件夹的 → 卡片；无子文件夹的（叶子）→ 平铺图片；分组 → 公共前缀链块
    const groups   = subDirs.filter(sd => sd.isGroup);
    const cardDirs = subDirs.filter(sd => !sd.isGroup && sd.hasSub);
    const leafDirs = subDirs.filter(sd => !sd.isGroup && !sd.hasSub && sd.leafImages.length);
    const totalImgs = images.length + leafDirs.reduce((s, d) => s + d.leafImages.length, 0);

    gallery.innerHTML = "";
    // 纯压缩包目录：无图无子文件夹但可能有压缩包 → 不在此处判空，交给 zip 扫描后决定
    const curAbs0 = activeDir ? (activeDir + (currentPath ? "/" + currentPath : "")) : "";
    if (!groups.length && !cardDirs.length && !leafDirs.length && !images.length && !curAbs0) {
      const pe = empty.querySelector("p"); if (pe) pe.textContent = t("emptyDir");
      empty.style.display = "flex"; gallery.style.display = "none"; return;
    }
    empty.style.display = "none";
    gallery.style.display = "";

    // 排序栏（作用于文件夹：卡片 + 叶子平铺分组）
    if (subDirs.length) {
      const sortBar = document.createElement("div");
      sortBar.className = "sort-bar";
      sortBar.innerHTML = `
        <span class="sort-label">${escapeHTML(t("sort"))}</span>
        <button class="sort-btn ${sortBy === "name" ? "active" : ""}" data-sort="name">${escapeHTML(t("sortName"))}</button>
        <button class="sort-btn ${sortBy === "count" ? "active" : ""}" data-sort="count">${escapeHTML(t("sortCount"))}</button>
        <button class="sort-btn ${sortBy === "time" ? "active" : ""}" data-sort="time">${escapeHTML(t("sortTime"))}</button>
        <span class="sort-count">${subDirs.length} ${escapeHTML(t("folderCount"))}</span>`;
      sortBar.querySelectorAll(".sort-btn").forEach(btn =>
        btn.addEventListener("click", () => {
          sortBy = btn.dataset.sort;
          render();
        })
      );
      gallery.appendChild(sortBar);
    }

    // “分组折叠用的▾太小了改成▲▼。位置应该在后面，点后面▲▼才折叠展开，否则进入”
    // 【原代码】图标在前面(▸)，点名称=展开/折叠，点图标=进入
    // 【改为】名称+meta 在前面(点击=进入)；▲▼符号在后面(点击=折叠/展开)
    groups.forEach(g => {
      const section = document.createElement("div");
      section.className = "dir-section";
      const header = document.createElement("div");
      header.className = "dir-section-header group";
      const collapsed = !expandedGroups.has(g.name);
      const timeStr = g.mtime ? fmtTime(g.mtime) : "";
      const metaText = `${timeStr ? timeStr : ""}${timeStr && g.count ? " · " : ""}${g.count ? g.count + " 张" : ""}${g.children && g.children.length ? " · " + g.children.length + " 项" : ""}`;
      // 前面：名称+meta → 点击=进入该分组目录
      const namePart = document.createElement("span");
      namePart.className = "dir-section-name enter-name";
      namePart.textContent = g.name;
      namePart.style.cursor = "pointer";
      namePart.title = t("enterDir") || "进入";
      namePart.addEventListener("click", () => {
        if (activeDir) {
          currentPath = g.relPath;
          saveNav();
          renderDirTree();
          render();
        }
      });
      const metaPart = document.createElement("span");
      metaPart.className = "dir-section-meta enter-name";
      metaPart.textContent = metaText;
      metaPart.style.cursor = "pointer";
      metaPart.addEventListener("click", () => {
        if (activeDir) {
          currentPath = g.relPath;
          saveNav();
          renderDirTree();
          render();
        }
      });
      // 后面：▲/▼ 折叠/展开符号
      const togglePart = document.createElement("span");
      togglePart.className = "dir-section-toggle";
      togglePart.textContent = collapsed ? "▲" : "▼";
      togglePart.style.cursor = "pointer";
      togglePart.style.fontSize = "1.1em";
      togglePart.style.marginLeft = "auto";
      togglePart.title = t("toggle") || "展开/折叠";
      togglePart.addEventListener("click", (e) => {
        e.stopPropagation();
        if (expandedGroups.has(g.name)) expandedGroups.delete(g.name); else expandedGroups.add(g.name);
        saveCollapsed();
        render();
      });
      header.appendChild(namePart);
      header.appendChild(metaPart);
      header.appendChild(togglePart);
      section.appendChild(header);

      if (!collapsed) {
        // “分组中的分组也是分组，具体区分靠字符大小，外面那层字体大些”
        // 递归渲染 children：嵌套 group → 内层分组(字体小)；card → 文件夹卡片/叶子平铺
        const renderChild = (sd, depth) => {
          // 嵌套分组
          if (sd.isGroup) {
            const subSection = document.createElement("div");
            subSection.className = "dir-section nested-group";
            subSection.style.marginLeft = (depth * 12) + "px";
            const subCollapsed = !expandedGroups.has(sd.name);
            const subHeader = document.createElement("div");
            subHeader.className = "dir-section-header group nested";
            // 内层字体小
            subHeader.style.fontSize = "0.85em";
            const subName = document.createElement("span");
            subName.className = "dir-section-name";
            subName.textContent = sd.name;
            subName.style.cursor = "pointer";
            subName.addEventListener("click", () => {
              if (activeDir) { currentPath = sd.relPath; saveNav(); pushNavHistory(); renderDirTree(); render(); }
            });
            const subMeta = document.createElement("span");
            subMeta.className = "dir-section-meta";
            const st = sd.mtime ? fmtTime(sd.mtime) : "";
            subMeta.textContent = `${st ? st : ""}${st && sd.count ? " · " : ""}${sd.count ? sd.count + " 张" : ""}`;
            subMeta.style.cursor = "pointer";
            subMeta.addEventListener("click", () => {
              if (activeDir) { currentPath = sd.relPath; saveNav(); pushNavHistory(); renderDirTree(); render(); }
            });
            const subToggle = document.createElement("span");
            subToggle.className = "dir-section-toggle";
            subToggle.textContent = subCollapsed ? "▲" : "▼";
            subToggle.style.cursor = "pointer";
            subToggle.style.marginLeft = "auto";
            subToggle.addEventListener("click", (e) => {
              e.stopPropagation();
              if (expandedGroups.has(sd.name)) expandedGroups.delete(sd.name); else expandedGroups.add(sd.name);
              saveCollapsed();
              render();
            });
            subHeader.appendChild(subName);
            subHeader.appendChild(subMeta);
            subHeader.appendChild(subToggle);
            subSection.appendChild(subHeader);
            if (!subCollapsed) {
              const subKids = (sd.children || []).slice();
              if (sortBy === "count") subKids.sort((a, b) => (b.count||0) - (a.count||0) || a.name.localeCompare(b.name));
              else if (sortBy === "time") subKids.sort((a, b) => (b.mtime||0) - (a.mtime||0) || a.name.localeCompare(b.name));
              else subKids.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
              subKids.forEach(k => subSection.appendChild(renderChild(k, depth + 1)));
            }
            return subSection;
          }
          // 叶子目录(hasSub=false 有 leafImages) → 平铺图片
          if (!sd.hasSub && sd.leafImages && sd.leafImages.length) {
            const leafSection = document.createElement("div");
            leafSection.className = "dir-section";
            const leafHeader = document.createElement("div");
            leafHeader.className = "dir-section-header leaf";
            leafHeader.style.fontSize = "0.8em";
            leafHeader.innerHTML = `<span class="dir-section-icon">📂</span><span class="dir-section-name">${escapeHTML(sd.name)}</span>`;
            leafHeader.addEventListener("click", () => {
              if (!activeDir && sd.root) activeDir = sd.root;
              currentPath = sd.relPath; saveNav(); renderDirTree(); render();
            });
            leafSection.appendChild(leafHeader);
            const grid = document.createElement("div");
            grid.className = "dir-grid";
            const isSeq = detectFramesFromNames(sd.leafImages.map(p => p.name));
            if (isSeq && sd.root) {
              const absDir = sd.root + (sd.relPath ? "/" + sd.relPath : "");
              const gifUrl = dirGifUrl(absDir, 0);
              const gifItem = { src: gifUrl, title: t("gifTitle", { name: sd.name, n: sd.leafImages.length }), name: sd.name, isGif: true, frameCount: sd.leafImages.length, cat: sd.leafImages[0]?.cat };
              grid.appendChild(makeCard(gifItem, { dir: sd.name, lbList: [gifItem] }));
            } else {
              sd.leafImages.forEach(p => grid.appendChild(makeCard(p, { dir: sd.name, lbList: sd.leafImages })));
            }
            leafSection.appendChild(grid);
            return leafSection;
          }
          // 有子目录的 → 文件夹卡片
          const fc = document.createElement("div");
          fc.className = "folder-card";
          const ctime = sd.mtime ? fmtTime(sd.mtime) : "";
          fc.innerHTML = `
            <span class="folder-icon">📁</span>
            <span class="folder-name">${escapeHTML(sd.name)}</span>
            <span class="folder-meta">${escapeHTML(ctime)}${ctime && sd.count ? " · " : ""}${sd.count ? sd.count + " 张" : ""}</span>`;
          fc.addEventListener("click", () => {
            if (!activeDir && sd.root) activeDir = sd.root;
            currentPath = sd.relPath; saveNav(); pushNavHistory(); renderDirTree(); render();
          });
          return fc;
        };

        const kids = (g.children || []).slice();
        if (sortBy === "count") kids.sort((a, b) => (b.count||0) - (a.count||0) || a.name.localeCompare(b.name));
        else if (sortBy === "time") kids.sort((a, b) => (b.mtime||0) - (a.mtime||0) || a.name.localeCompare(b.name));
        else kids.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
        // “分组中分组还是独占一行”→ group/leaf 独占一行直接挂 section；folder-card 放 wrap 横排
        let wrap = null;  // 延迟创建 wrap，只有 folder-card 才放进去
        const flushWrap = () => { if (wrap && wrap.children.length) { section.appendChild(wrap); wrap = null; } };
        kids.forEach(sd => {
          const el = renderChild(sd, 1);
          // folder-card → 放 wrap 横排；group/leaf → 先 flush wrap 再独占一行
          if (el.classList.contains("folder-card")) {
            if (!wrap) { wrap = document.createElement("div"); wrap.className = "folder-wrap"; }
            wrap.appendChild(el);
          } else {
            flushWrap();
            section.appendChild(el);
          }
        });
        flushWrap();
      }
      gallery.appendChild(section);
    });

    // 有子文件夹的：竖排卡片，可点击进入
    if (cardDirs.length) {
      const folderWrap = document.createElement("div");
      folderWrap.className = "folder-wrap";
      cardDirs.forEach(sd => {
        const fc = document.createElement("div");
        fc.className = "folder-card";
        const timeStr = sd.mtime ? fmtTime(sd.mtime) : "";
        fc.innerHTML = `
          <span class="folder-icon">📁</span>
          <span class="folder-name">${escapeHTML(sd.name)}</span>
          <span class="folder-meta">${escapeHTML(timeStr)}${timeStr && sd.count ? " · " : ""}${sd.count ? sd.count + " 张" : ""}</span>`;
        fc.addEventListener("click", () => {
          if (!activeDir && sd.root) activeDir = sd.root;
          currentPath = sd.relPath;
          saveNav();
          pushNavHistory();
          renderDirTree(); render();
        });
        folderWrap.appendChild(fc);
      });
      gallery.appendChild(folderWrap);
    }

    // 叶子文件夹：📂+名称 单行标题，下面直接平铺该文件夹图片（序列帧→合成GIF）
    leafDirs.forEach(sd => {
      const section = document.createElement("div");
      section.className = "dir-section";
      const header = document.createElement("div");
      header.className = "dir-section-header leaf";
      header.innerHTML = `<span class="dir-section-icon">📂</span><span class="dir-section-name">${escapeHTML(sd.name)}</span>`;
      header.addEventListener("click", () => {
        if (!activeDir && sd.root) activeDir = sd.root;
        currentPath = sd.relPath;
        saveNav();
        pushNavHistory();
        renderDirTree(); render();
      });
      section.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "dir-grid";
      // 序列帧检测 → 该文件夹用动画GIF替代帧图
      const isSeq = detectFramesFromNames(sd.leafImages.map(p => p.name));
      if (isSeq && sd.root) {
        const absDir = sd.root + (sd.relPath ? "/" + sd.relPath : "");
        const gifUrl = dirGifUrl(absDir, 0);
        const gifItem = { src: gifUrl, title: t("gifTitle", { name: sd.name, n: sd.leafImages.length }), name: sd.name, isGif: true, frameCount: sd.leafImages.length, cat: sd.leafImages[0]?.cat };
        grid.appendChild(makeCard(gifItem, { dir: sd.name, lbList: [gifItem] }));
      } else {
        sd.leafImages.forEach(p => grid.appendChild(makeCard(p, { dir: sd.name, lbList: sd.leafImages })));
      }
      section.appendChild(grid);
      gallery.appendChild(section);
    });

    // 当前文件夹直接图片（平铺；序列帧→合成GIF）
    if (images.length) {
      const grid = document.createElement("div");
      grid.className = "dir-grid";
      const isSeq = detectFramesFromNames(images.map(p => p.name));
      if (isSeq && activeDir) {
        const absDir = activeDir + (currentPath ? "/" + currentPath : "");
        const gifUrl = dirGifUrl(absDir, 0);
        const curName = currentPath.split("/").pop() || t("currentDir");
        const gifItem = { src: gifUrl, title: t("gifTitle", { name: curName, n: images.length }), name: curName, isGif: true, frameCount: images.length };
        grid.appendChild(makeCard(gifItem, { dir: currentPath, lbList: [gifItem] }));
      } else {
        images.forEach(p => grid.appendChild(makeCard(p, { dir: currentPath, lbList: images })));
      }
      gallery.appendChild(grid);
    }

    // 压缩包分组（当前文件夹下 zip/7z/rar，默认展开，可手动收起）
    const curAbs = activeDir ? (activeDir + (currentPath ? "/" + currentPath : "")) : "";
    if (curAbs) {
      scanZipsInDir(curAbs).then(zips => {
        const zipList = zips.filter(z => z.images && z.images.length);
        if (!zipList.length) {
          // 无图无子文件夹（含分组）且无压缩包 → 真·空目录
          if (!cardDirs.length && !leafDirs.length && !groups.length && !images.length) {
            const pe = empty.querySelector("p"); if (pe) pe.textContent = t("emptyDir");
            empty.style.display = "flex"; gallery.style.display = "none";
          }
          return;
        }
        const zipWrap = document.createElement("div");
        zipWrap.className = "zip-wrap";
        zipList.forEach(z => {
          const collapsed = collapsedZips.has(z.path);
          const group = document.createElement("div");
          group.className = "zip-group" + (collapsed ? " collapsed" : "");
          const durMs = parseFrameMs(z.name);
          const isSeq = detectFramesFromNames(z.images.map(i => i.name));
          const head = document.createElement("div");
          head.className = "zip-group-head";
          head.innerHTML = `
            <span class="zip-toggle">${collapsed ? "▸" : "▾"}</span>
            <span class="zip-icon">🗜</span>
            <span class="zip-name">${escapeHTML(z.name)}</span>
            <span class="zip-count">${z.images.length} ${escapeHTML(t("imagesCount"))}</span>`;
          head.addEventListener("click", () => {
            if (collapsedZips.has(z.path)) collapsedZips.delete(z.path); else collapsedZips.add(z.path);
            saveCollapsed();
            render();
          });
          const body = document.createElement("div");
          body.className = "zip-group-body";
          if (!collapsed) {
            const grid = document.createElement("div");
            grid.className = "dir-grid";
            if (isSeq) {
              const gifUrl = zipGifUrl(z.path, durMs);
              const gifItem = { src: gifUrl, title: t("gifTitle", { name: z.name, n: z.images.length }), name: z.name, isGif: true, frameCount: z.images.length };
              grid.appendChild(makeCard(gifItem, { dir: z.name, lbList: [gifItem] }));
            } else {
              const items = z.images.map(im => ({ src: zipImgUrl(z.path, im.name), title: im.name, name: im.name, size: im.size ? fmtSize(im.size) : "" }));
              items.forEach(p => grid.appendChild(makeCard(p, { dir: z.name, lbList: items })));
            }
            body.appendChild(grid);
          }
          group.appendChild(head);
          group.appendChild(body);
          zipWrap.appendChild(group);
        });
        gallery.appendChild(zipWrap);
      });
    }

    renderBreadcrumb(images, totalImgs);
  }

  /* ─── Breadcrumb (hierarchical navigation) ─── */
  function renderBreadcrumb(items, totalImgs) {
    const count = totalImgs != null ? totalImgs : (items && items.length) || 0;
    // “顶部导航栏前后加< >实现文件路径后退前进”
    const canBack = navHistoryIdx > 0;
    const canForward = navHistoryIdx < navHistory.length - 1;
    let html = `<button class="nav-arrow ${canBack ? "" : "disabled"}" id="navBack" title="${escapeHTML(t("back") || "后退")}" ${canBack ? "" : "disabled"}>‹</button>`;
    html += `<span class="crumb ${!activeDir ? "active" : ""}" data-nav-root data-root="all">${escapeHTML(t("home"))}</span>`;
    // 当前激活根目录
    if (activeDir) {
      const rootName = activeDir.split("/").pop() || activeDir;
      const rootActive = !currentPath;
      html += `<span class="crumb-sep">›</span><span class="crumb ${rootActive ? "active" : ""}" data-nav-root data-root="${escapeHTML(activeDir)}" data-path="">${escapeHTML(rootName)}</span>`;
      // 当前路径层级
      if (currentPath) {
        const parts = currentPath.split("/");
        let acc = "";
        parts.forEach((part, i) => {
          acc = acc ? acc + "/" + part : part;
          const isLast = i === parts.length - 1;
          html += `<span class="crumb-sep">›</span><span class="crumb ${isLast ? "active" : ""}" data-nav-root data-root="${escapeHTML(activeDir)}" data-path="${escapeHTML(acc)}">${escapeHTML(part)}</span>`;
        });
      }
    }
    html += `<span class="crumb-sep" style="margin-left:auto;font-size:12px;color:var(--muted)">${count} ${escapeHTML(t("imagesCount"))}</span>`;
    html += `<button class="nav-arrow ${canForward ? "" : "disabled"}" id="navForward" title="${escapeHTML(t("forward") || "前进")}" ${canForward ? "" : "disabled"}>›</button>`;
    breadcrumb.innerHTML = html;
    breadcrumb.querySelectorAll("[data-nav-root]").forEach(el =>
      el.addEventListener("click", () => {
        const root = el.dataset.root;
        const path = el.dataset.path || "";
        if (root === "all") { activeDir = null; currentPath = ""; }
        else { activeDir = root; currentPath = path; }
        saveNav();
        pushNavHistory();
        renderNavBtns(); renderDirTree(); render();
      })
    );
    // 后退/前进按钮
    document.getElementById("navBack")?.addEventListener("click", navBack);
    document.getElementById("navForward")?.addEventListener("click", navForward);
  }

  /* ─── Lightbox ─── */
  function openLightbox(idx, items) {
    lbList = items || [];
    lightboxIdx = idx;
    updateLightbox(lbList);
    lightbox.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function updateLightbox(items) {
    const total = items.length;
    const cur = items[Math.min(lightboxIdx, total - 1)];
    if (!cur) return;
    const prev = items[(lightboxIdx - 1 + total) % total];
    const next = items[(lightboxIdx + 1) % total];
    lbImgCur.src = cur.src || "";
    lbImgPrev.src = prev ? prev.src : "";
    lbImgNext.src = next ? next.src : "";
    lbCarousel.style.transform = "";   // 切换后重置轮播位置
    const title = cur.title || cur.name || "Untitled";
    const catMeta = categories.find(c => c.name === cur.cat);
    const dir = cur.dirName || cur.dir || "";
    // 收藏分类打开 → 下方描述显示来源路径
    const srcPath = (activeFilter === "favorites")
      ? (cur.path || getPathFromSrc(cur.src) || cur.root || "")
      : "";
    lbInfo.innerHTML = `
      <div class="lb-title">${escapeHTML(title)}</div>
      <div class="lb-cat">${escapeHTML(dir)}${cur.size ? " · " + cur.size : ""} · ${escapeHTML(catMeta?.label || cur.cat || "")}</div>
      ${srcPath ? `<div class="lb-path">📁 ${escapeHTML(srcPath)}</div>` : ""}`;
    // 更新收藏按钮状态
    const lbFav = document.getElementById("lbFav");
    if (lbFav) {
      const isFav = favoriteSrcs.has(cur.src);
      lbFav.textContent = isFav ? "❤️" : "🩷";
      lbFav.style.opacity = authedUser ? "1" : "0.5";
      lbFav.title = authedUser ? (isFav ? t("removeFav") || "取消收藏" : t("addFav") || "收藏") : (t("loginFirst") || "请先登录");
    }
  }
  function closeLightbox() {
    lightbox.classList.remove("open");
    document.body.style.overflow = "";
  }
  // 轮播切换动画（“点开图片还是缺少过渡”→ 平滑滑动切换，不硬切）
  // 经典轮播：先把容器平滑滑到目标位置 → transitionend 后换图 → 瞬移回原位（视觉无感）
  let lbAnimating = false;
  function lbSlide(dir) {   // dir: 1=下一张(左滑), -1=上一张(右滑)
    if (!lbList.length || lbAnimating) return;
    lbAnimating = true;
    const slideW = (lbImgCur.offsetWidth || Math.min(window.innerWidth * 0.7, 600)) + 40;  // 当前图宽 + gap 40px
    lbCarousel.style.transition = "transform .32s cubic-bezier(.25,.8,.35,1)";
    lbCarousel.style.transform = `translateX(${-dir * slideW}px)`;
    const done = () => {
      if (!lbAnimating) return;
      lbAnimating = false;
      lbCarousel.style.transition = "none";          // 关闭过渡，瞬移回位
      lightboxIdx = (lightboxIdx + dir + lbList.length) % lbList.length;
      updateLightbox(lbList);                        // 换图 + transform 归零（视觉无感）
      setTimeout(() => { lbCarousel.style.transition = ""; }, 50);
    };
    const onEnd = ev => { if (ev.propertyName === "transform") { lbCarousel.removeEventListener("transitionend", onEnd); done(); } };
    lbCarousel.addEventListener("transitionend", onEnd);
    setTimeout(done, 420);                           // 兜底：transitionend 万一不触发
  }
  function lbPrev() { lbSlide(-1); }
  function lbNext() { lbSlide(1); }

  /* ─── Events ─── */
  // “如果它已展开（是 ancestor），点击应该折叠它（而不是导航到它）。如果是未展开，点击就是展开它并导航到它”
  dirTree.addEventListener("click", e => {
    const item = e.target.closest(".dir-item");
    if (!item) return;
    const root = item.dataset.root;
    const path = item.dataset.path || "";
    const nodeKey = item.dataset.nodeKey || "";
    // 判断当前是否已展开（是 ancestor/active 且未被手动折叠）
    const isAncestor = !!path && (currentPath === path || (currentPath && currentPath.startsWith(path + "/")));
    const isExpanded = isAncestor && !collapsedTreeNodes.has(nodeKey);
    const hasKids = item.querySelector(".dir-icon")?.textContent === "▾" || item.querySelector(".dir-icon")?.textContent === "▸";

    if (root === "all" || !hasKids) {
      // "全部"或叶子节点 → 直接导航
      if (root === "all") { activeDir = null; currentPath = ""; activeFilter = "all"; }
      else {
        if (root) activeDir = root;
        currentPath = path;
        // “选择收藏/游客分类后，不能通过左侧边栏跳转其他分类”→ 点侧边栏目录时切回该目录所属分类
        const dir = directories.find(d => d.path === root);
        if (dir) activeFilter = dir.category;
      }
    } else if (isExpanded) {
      // 已展开 → 折叠（不导航）
      collapsedTreeNodes.add(nodeKey);
      saveCollapsed();
      renderDirTree();
      return;
    } else {
      // 未展开 → 展开 + 导航
      collapsedTreeNodes.delete(nodeKey);
      if (root) activeDir = root;
      currentPath = path;
      if (root) {
        const dir = directories.find(d => d.path === root);
        if (dir) activeFilter = dir.category;
      }
    }
    renderNavBtns();
    saveNav();
    pushNavHistory();
    renderDirTree();
    render();
  });

  searchInput.addEventListener("input", e => { searchQuery = e.target.value; render(); });

  // ─── 语言切换 ───
  const langBtn = document.getElementById("langBtn");
  langBtn.addEventListener("click", () => {
    const next = lang === "en" ? "zh-CN" : "en";
    loadLang(next);
  });

  // ─── 屏蔽图片右键菜单（已注释屏蔽逻辑：允许长按/右键保存图片）───
  // document.addEventListener("contextmenu", e => {
  //   if (e.target.closest("img")) e.preventDefault();
  // }, true);

  // “④下载功能并没有唤起浏览器下载图片，只是跳转到原图”
  // 【原代码】a.href=p.src; a.download=... → 跨源(:3000)图片浏览器忽略 download 属性，直接跳转
  // 【改为】fetch blob → URL.createObjectURL → a.download → 真正下载
  document.getElementById("lbDownload").addEventListener("click", async () => {
    const p = lbList[Math.min(lightboxIdx, lbList.length - 1)];
    if (!p || !p.src) return;
    const filename = (p.name || "image").replace(/[\\/:*?"<>|]/g, "_");
    try {
      const resp = await fetch(p.src, { credentials: "include" });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) {
      // 回退：直接跳转（至少能用）
      window.open(p.src, "_blank");
    }
  });

  document.getElementById("lbClose").addEventListener("click", closeLightbox);
  document.getElementById("lbPrev").addEventListener("click", e => { e.stopPropagation(); lbPrev(); });
  document.getElementById("lbNext").addEventListener("click", e => { e.stopPropagation(); lbNext(); });
  // “登录用户可点收藏，游客可以看”
  document.getElementById("lbFav").addEventListener("click", e => {
    e.stopPropagation();
    const p = lbList[Math.min(lightboxIdx, lbList.length - 1)];
    if (p) toggleFavorite(p).then(() => updateLightbox(lbList));
  });
  lightbox.addEventListener("click", e => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener("keydown", e => {
    if (!lightbox.classList.contains("open")) return;
    if (e.key === "Escape")     closeLightbox();
    if (e.key === "ArrowLeft")  lbPrev();
    if (e.key === "ArrowRight") lbNext();
  });

  // “③点开图片之后，除了按钮切换图片，加上可以滑动切换”
  // “点开图片之后，前后图片也都被点开，中间稍微有几厘米间距，滑动时前后图片一起滑动”
  // → 三图轮播：拖动整个 .lb-carousel 容器（前后图一起动），松手超阈值切换、否则弹回
  let lbDrag = null; // { startX, startY, moved }
  function lbDragStart(x, y) {
    lbDrag = { startX: x, startY: y, moved: false };
    lbCarousel.style.transition = "none";          // 拖动中禁用过渡，跟手
  }
  function lbDragMove(x, y) {
    if (!lbDrag) return;
    const dx = x - lbDrag.startX;
    const dy = y - lbDrag.startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) lbDrag.moved = true;
    if (lbDrag.moved && Math.abs(dx) > Math.abs(dy)) {
      lbCarousel.style.transform = `translateX(${dx}px)`;
    }
  }
  function lbDragEnd(x, y) {
    if (!lbDrag) return;
    const dx = x - lbDrag.startX;
    const moved = lbDrag.moved;
    lbDrag = null;
    if (moved && Math.abs(dx) > 80) {
      // 切换走 lbSlide：从当前拖动位置平滑滑到目标（transitionend 后换图）
      if (dx > 0) lbPrev(); else lbNext();
    } else {
      lbCarousel.style.transition = "transform .3s ease";
      lbCarousel.style.transform = "";                     // 弹回原位
      setTimeout(() => { lbCarousel.style.transition = ""; }, 350);
    }
  }
  // 触摸（绑定到 lightbox，前后图也可见时整体可拖动）
  lightbox.addEventListener("touchstart", e => { lbDragStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  lightbox.addEventListener("touchmove", e => {
    if (lbDrag && lbDrag.moved) e.preventDefault();
    lbDragMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  lightbox.addEventListener("touchend", e => { lbDragEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY); }, { passive: true });
  // 鼠标拖拽（桌面端，与卡片行预览滑动一致）
  lightbox.addEventListener("mousedown", e => {
    if (e.target.closest("button")) return;   // 不拦截按钮点击
    e.preventDefault();
    lbDragStart(e.clientX, e.clientY);
  });
  document.addEventListener("mousemove", e => lbDragMove(e.clientX, e.clientY));
  document.addEventListener("mouseup", e => lbDragEnd(e.clientX, e.clientY));
  // 鼠标滚轮切换（lightbox 打开时）
  lightbox.addEventListener("wheel", e => {
    if (!lightbox.classList.contains("open")) return;
    e.preventDefault();
    if (e.deltaY > 0 || e.deltaX > 0) lbNext();
    else lbPrev();
  }, { passive: false });

  collapseBtn.addEventListener("click", () => {
    app.classList.toggle("collapsed");
    collapseBtn.textContent = app.classList.contains("collapsed") ? "▶" : "◀";
  });

  /* ─── Settings ─── */
  // “展开折叠都是点设置按钮，单独搞个关闭按钮”→ ⚙ 切换 open，✕ 只关不切换
  settingsBtn.addEventListener("click", () => {
    if (passwordSet && !authed) { openLoginModal(); return; }  // 登录后才能修改设置
    const isOpen = settingsPanel.classList.toggle("open");
    if (isOpen) renderSettings();
  });
  // “展开折叠都是点设置按钮，单独搞个关闭按钮”→ 已删 ✕ 关闭按钮，⚙ 即可展开/折叠
  loginBtn.addEventListener("click", () => { if (!authed) openLoginModal(); });
  // 设置面板内 logout 按钮
  const settingsLogoutBtn = document.getElementById("settingsLogout");
  if (settingsLogoutBtn) settingsLogoutBtn.addEventListener("click", () => doLogout());

  // 设置面板内「设置/修改密码」：首次进入无需旧密码，已设密码则须验旧密码
  async function submitPassword() {
    if (!pwNewEl || !pwSubmitBtn) return;
    const next = pwNewEl.value || "";
    if (pwErrorEl) pwErrorEl.style.display = "none";
    if (pwOkEl) pwOkEl.style.display = "none";

    const fail = (msg) => { if (pwErrorEl) { pwErrorEl.textContent = msg; pwErrorEl.style.display = "block"; } };
    if (next.length < 4) return fail(t("pwTooShort"));
    if (next !== (pwConfirmEl ? pwConfirmEl.value : "")) return fail(t("pwMismatch"));
    if (passwordSet && !(pwOldEl && pwOldEl.value)) return fail(t("pwNeedOld"));

    pwSubmitBtn.disabled = true;
    try {
      await window.API.apiPost("/change-password", {
        password: next,
        oldPassword: pwOldEl ? pwOldEl.value : "",
      });
      // 首次设置后服务端即要求登录，本机已是设置态 → 标记为已登录
      passwordSet = true;
      authed = true;
      updateAuthUI();
      syncPasswordUI();
      if (pwOldEl) pwOldEl.value = "";
      pwNewEl.value = "";
      if (pwConfirmEl) pwConfirmEl.value = "";
      if (pwOkEl) pwOkEl.style.display = "block";
    } catch (e) {
      fail(e && e.message ? e.message : t("pwFailed"));
    } finally {
      pwSubmitBtn.disabled = false;
    }
  }

  if (pwSubmitBtn) pwSubmitBtn.addEventListener("click", submitPassword);
  // 确认框回车直接提交
  if (pwConfirmEl) pwConfirmEl.addEventListener("keydown", e => { if (e.key === "Enter") submitPassword(); });

  loginClose.addEventListener("click", closeLoginModal);
  loginSubmit.addEventListener("click", doLogin);
  loginModal.addEventListener("click", e => { if (e.target === loginModal) closeLoginModal(); });
  loginPassword.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  galleryTitleInput.addEventListener("input", e => {
    galleryTitle = e.target.value || "Gallery";
    document.querySelector(".logo-text").textContent = galleryTitle;
    applyTabMeta();
    saveSettings();
  });
  faviconInput.addEventListener("input", e => {
    favicon = e.target.value || "";
    applyTabMeta();
    saveSettings();
  });

  function renderSettings() {
    galleryTitleInput.value = galleryTitle;
    faviconInput.value = favicon;
    renderCategories();
    renderDirectories();
    renderUserImages();
    renderUpdateTime();
    // 自动更新卡片：blueprint 通用件（auto-update-card.js 自包含，mount 幂等）
    if (window.AutoUpdateCard && document.getElementById("autoUpdateToggle")) {
      window.AutoUpdateCard.mount();
    }
  }

  // 更新时间：只读展示自动更新后端上报的 lastUpdatedAt，不含任何操作入口
  async function renderUpdateTime() {
    const el = document.getElementById("updateTimeText");
    if (!el) return;
    try {
      const res = await window.API.apiGet("/auto-update/status");
      const ts = (res && res.status && res.status.lastUpdatedAt) || 0;
      if (!ts) { el.textContent = t("updateTimeNever"); return; }
      const d = new Date(ts);
      const pad = n => String(n).padStart(2, "0");
      el.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (e) {
      // 后端未启用自动更新时接口可能不可达，保持提示文案即可
      el.textContent = t("updateTimeNever");
    }
  }

  function renderCategories() {
    categoryList.innerHTML = categories.map((c, i) => `
      <li class="category-item">
        <label class="category-color" title="${escapeHTML(t("editColor"))}">
          <input type="color" value="${c.color}" data-idx="${i}" class="cat-color-input"/>
        </label>
        <input type="text" value="${escapeHTML(c.label)}" data-idx="${i}" class="cat-name-input" placeholder="${escapeHTML(t("categoryName"))}"/>
        <button class="category-del" data-idx="${i}" title="${escapeHTML(t("delete"))}">✕</button>
      </li>
    `).join("");

    categoryList.querySelectorAll(".cat-name-input").forEach(inp => {
      inp.addEventListener("input", e => {
        const idx = +e.target.dataset.idx;
        categories[idx].label = e.target.value;
        renderNavBtns(); renderDirTree(); renderDirectories(); render();
      });
    });
    categoryList.querySelectorAll(".cat-color-input").forEach(inp => {
      inp.addEventListener("input", e => {
        const idx = +e.target.dataset.idx;
        categories[idx].color = e.target.value;
        renderNavBtns(); renderDirTree(); renderDirectories(); render();
      });
    });
    categoryList.querySelectorAll(".category-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = +btn.dataset.idx;
        const removed = categories[idx].name;
        categories.splice(idx, 1);
        // 引用被删分类的目录 → 回退 "all"
        directories.forEach(d => { if (d.category === removed) d.category = "all"; });
        if (activeFilter === removed) activeFilter = "all";
        renderCategories(); renderNavBtns(); renderDirTree(); renderDirectories(); render();
        saveSettings();
      });
    });
  }

  function renderDirectories() {
    dirList.innerHTML = directories.map((d, i) => `
      <li class="dir-item-settings">
        <span class="dir-icon">📁</span>
        <input type="text" value="${escapeHTML(d.path)}" data-idx="${i}" class="dir-path-input" placeholder="${escapeHTML(t("dirPath"))}"/>
        <select data-idx="${i}" class="dir-cat-select" title="${escapeHTML(t("belongsTo"))}">
          <option value="all" ${d.category === "all" || !d.category ? "selected" : ""}>${escapeHTML(t("all"))}</option>
          ${categories.map(c =>
            `<option value="${c.name}" ${d.category === c.name ? "selected" : ""}>${escapeHTML(c.label)}</option>`
          ).join("")}
        </select>
        <button class="dir-del" data-idx="${i}" title="${escapeHTML(t("delete"))}">✕</button>
      </li>
    `).join("");

    dirList.querySelectorAll(".dir-path-input").forEach(inp => {
      inp.addEventListener("input", e => {
        directories[+e.target.dataset.idx].path = e.target.value;
        renderDirTree(); render();
        saveSettings();
      });
    });
    dirList.querySelectorAll(".dir-cat-select").forEach(sel => {
      sel.addEventListener("change", e => {
        directories[+e.target.dataset.idx].category = e.target.value;
        renderDirTree();
        saveSettings(true); // reload images (category assignment changed)
      });
    });
    dirList.querySelectorAll(".dir-del").forEach(btn => {
      btn.addEventListener("click", () => {
        directories.splice(+btn.dataset.idx, 1);
        if (activeDir && !directories.find(d => d.path === activeDir)) activeDir = null;
        renderDirectories(); renderDirTree(); render();
        saveSettings(true);
      });
    });
  }

  function renderUserImages() {
    imageList.innerHTML = userImages.map((img, i) => `
      <li class="image-item">
        <img src="${escapeHTML(img.src)}" alt=""/>
        <span>${escapeHTML(img.title)}</span>
        <button class="img-del" data-idx="${i}" title="${escapeHTML(t("delete"))}">✕</button>
      </li>
    `).join("");
    imageList.querySelectorAll(".img-del").forEach(btn => {
      btn.addEventListener("click", () => {
        userImages.splice(+btn.dataset.idx, 1);
        renderUserImages(); render();
      });
    });
  }

  /* ─── Add Category (inline edit box — “分类的添加改成编辑框输入”) ─── */
  document.getElementById("addCategoryBtn").addEventListener("click", () => {
    // 在分类列表下方插入一个内联编辑框
    const li = document.createElement("li");
    li.className = "category-add-inline";
    li.innerHTML = `<input type="text" class="cat-name-input" placeholder="${escapeHTML(t("newCategoryName"))}" autofocus/><button class="cat-confirm">✓</button>`;
    categoryList.appendChild(li);
    const input = li.querySelector(".cat-name-input");
    const btn = li.querySelector(".cat-confirm");
    input.focus();
    function confirmAdd() {
      const name = input.value.trim();
      if (!name) { li.remove(); return; }
      const colors = ["#c084fc","#4ade80","#f472b6","#60a5fa","#fbbf24","#fb923c","#38bdf8","#34d399"];
      categories.push({ name: slugify(name), label: name, color: colors[categories.length % colors.length] });
      renderCategories(); renderNavBtns(); renderDirTree(); renderDirectories(); render();
      saveSettings();
    }
    btn.addEventListener("click", confirmAdd);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); confirmAdd(); }
      if (e.key === "Escape") li.remove();
    });
  });

  /* ─── Add Directory (本机目录浏览器 — “添加目录改成📂读取本机目录选择，选择之后不需要弹窗口马上指定分类，直接默认指向all”) ─── */
  let dirBrowserOpen = false;
  document.getElementById("addDirBtn").addEventListener("click", () => {
    if (dirBrowserOpen) return;
    dirBrowserOpen = true;
    // 在目录列表下方插入目录浏览器
    const li = document.createElement("li");
    li.className = "dir-browser-inline";
    li.innerHTML = `
      <div class="dir-browser">
        <div class="dir-browser-path">
          <button class="db-up" title="上级">📁↑</button>
          <span class="db-cwd">/</span>
        </div>
        <ul class="db-list"></ul>
        <div class="db-actions">
          <button class="db-select">📂 选择此目录</button>
          <button class="db-cancel">取消</button>
        </div>
      </div>
    `;
    dirList.appendChild(li);
    let cwd = window.__GALLERY_FS_ROOT || "/";
    async function loadDirList(root) {
      try {
        const data = await window.API.apiGet(`/directories?root=${encodeURIComponent(root)}`);
        cwd = data.root;
        li.querySelector(".db-cwd").textContent = cwd;
        const ul = li.querySelector(".db-list");
        ul.innerHTML = (data.items || []).map(name => `<li class="db-item" data-name="${escapeHTML(name)}">📁 ${escapeHTML(name)}</li>`).join("");
        ul.querySelectorAll(".db-item").forEach(item => {
          item.addEventListener("click", () => loadDirList(cwd + "/" + item.dataset.name));
        });
      } catch (e) {
        li.querySelector(".db-list").innerHTML = `<li style="color:var(--muted)">无法读取</li>`;
      }
    }
    li.querySelector(".db-up").addEventListener("click", () => {
      const parts = cwd.split("/").filter(Boolean);
      parts.pop();
      loadDirList("/" + parts.join("/"));
    });
    li.querySelector(".db-select").addEventListener("click", () => {
      // “直接默认指向all，作为里面的子文件夹。然后可以再分类”
      directories.push({ path: cwd, category: "all" });
      li.remove(); dirBrowserOpen = false;
      renderDirectories(); renderNavBtns(); renderDirTree(); render();
      saveSettings(true);
      showNotification(t("settingsSaved"), "success");
    });
    li.querySelector(".db-cancel").addEventListener("click", () => { li.remove(); dirBrowserOpen = false; });
    loadDirList(cwd);
  });

  let saveTimer = null;
  function saveSettings(reload = false) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await window.API.apiPost("/gallery", { title: galleryTitle, categories, directories });
        showNotification(t("settingsSaved"), "success");
        if (reload) await loadAPIImages();
      } catch (e) {
        console.warn("save failed:", e);
        showNotification(t("saveFailed") + e.message, "error");
      }
    }, 400);
  }

  /* ─── Upload（上传区域搬到主页顶栏📤 + 全局拖拽，“上传区域搬到主页”）─── */
  uploadBtn.addEventListener("click", () => fileInput.click());
  // 全局拖拽上传：把图片拖到页面上任意位置即可上传
  let dragDepth = 0;
  document.addEventListener("dragenter", e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    dragDepth++;
    document.body.classList.add("drag-uploading");
    e.preventDefault();
  });
  document.addEventListener("dragover", e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
  });
  document.addEventListener("dragleave", e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("drag-uploading"); }
    e.preventDefault();
  });
  document.addEventListener("drop", e => {
    dragDepth = 0;
    document.body.classList.remove("drag-uploading");
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));

  async function handleFiles(files) {
    // 上传权限（“上传功能不能上传到收藏目录；不登录只能上传到预设分类游客”）
    if (activeFilter === "favorites") {
      showNotification(t("favNoUpload") || "收藏分类不可上传", "error");
      return;
    }
    const isGuest = !authedUser;
    let targetCat, targetDir = "";
    if (isGuest) {
      // 游客：只能上传到预设“游客”分类，实际存储项目本地 uploads/（无 targetDir）
      targetCat = "guest";
    } else {
      // 登录后：可以上传到其他目录（若当前在真实目录，则写文件到该目录；否则存本地）
      targetCat = activeFilter !== "all" && activeFilter !== "guest" ? activeFilter : (categories[0]?.name || "bh3");
      if (activeDir) targetDir = activeDir;
    }
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const form = new FormData();
      form.append("image", file);
      try {
        const result = await window.API.apiUpload(form, targetDir || undefined);
        if (result.targetDir) {
          // 登录上传到真实目录 → 需要重新扫描以显示
          continue;
        }
        // 本地 uploads（游客 或 登录后无 activeDir 时）
        userImages.push({
          id:    result.id,
          src:   window.API.apiUrl(result.url),
          w:     600, h: 800,
          title: file.name.replace(/\.[^/.]+$/, ""),
          cat:   targetCat,
          dirId: "Uploaded",
          dirName: "Uploaded",
          size:  result.size,
        });
      } catch (e) {
        const reader = new FileReader();
        reader.onload = ev => {
          userImages.push({
            src: ev.target.result, w: 600, h: 800,
            title: file.name.replace(/\.[^/.]+$/, ""),
            cat: targetCat, dirId: "Uploaded", dirName: "Uploaded",
            size: (file.size / 1024 / 1024).toFixed(1) + " MB",
          });
          renderUserImages(); render();
        };
        reader.readAsDataURL(file);
        continue;
      }
    }
    // 如果有上传到真实目录，只刷新上传目录所属的根（带 noCache 强制服务端跳过 30s 缓存）
    if (targetDir) {
      const root = directories
        .map(d => d.path)
        .filter(p => targetDir === p || targetDir.startsWith(p + '/'))
        .sort((a, b) => b.length - a.length)[0];
      if (root) await loadAPIImages(root, true);
    }
    renderUserImages();
    render();
  }

  /* ─── 卡片行预览滑动（“点开滑动确实实现了，但我其实想要的是没点开时那种的滑动”）
       在 dir-grid 上按住横向拖动 → 滚动行；轻点（无位移）→ 正常点开卡片 ─── */
  let gridDrag = null;
  let gridDragMoved = false;
  document.addEventListener("mousedown", e => {
    const grid = e.target.closest(".dir-grid");
    if (!grid) return;
    if (e.target.closest("button, input, a, label")) return;
    gridDrag = { grid, startX: e.clientX, scrollLeft: grid.scrollLeft };
    gridDragMoved = false;
  });
  document.addEventListener("mousemove", e => {
    if (!gridDrag) return;
    const dx = e.clientX - gridDrag.startX;
    const dy = e.clientY - (gridDrag.startY || e.clientY);
    if (!gridDragMoved && Math.abs(dx) > 4 && Math.abs(dx) > Math.abs(dy)) gridDragMoved = true;
    if (gridDragMoved) {
      gridDrag.grid.scrollLeft = gridDrag.scrollLeft - dx;
      e.preventDefault();
    }
  });
  document.addEventListener("mouseup", () => { gridDrag = null; });
  // 捕获阶段拦截 click（拖动后不触发卡片打开）
  document.addEventListener("click", e => {
    if (gridDragMoved) { e.stopPropagation(); e.preventDefault(); gridDragMoved = false; }
  }, true);

  /* ─── Init ─── */
  init();
})();
