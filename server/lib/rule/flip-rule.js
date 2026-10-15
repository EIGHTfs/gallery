/**
 * 翻转规则（独立模块）：决定「压缩包内的一张图片是否需要 180° 翻转」。
 *
 * 为什么单独一个文件（2026-10-15 拆分）：
 *   此前 flip 有两处各自决定 —— 规则模块 gif-rule.js 的 modGifRule 里硬编码 flip:true，
 *   而 lib/gif.js 又自己写 `const flip = hasIni`。两处口径容易漂移。
 *   现在本文件是 flip 的**唯一出处**，gif-rule.js / lib/gif.js / routes/archive.js 都调用它。
 *
 * 判定口径（按真实数据定，不是拍脑袋）：
 *   3DMigoto mod 的 ini 用 `filename = xxx.dds/png/buf` 逐条声明它要用的贴图；
 *   包内**未被 ini 声明**的图片（典型：预览图，例如某个包里只有一张「图片.jpg」）不应翻转。
 *   实测反例（拆分前会误伤）：`希儿.zip` 内唯一的 ini 是 `Android/AUDIO/desktop.ini`
 *   （音频元数据 `[LocalizedFileNames]`，不是 mod 贴图 ini），却因为「包内有 ini」把预览图翻转了。
 *   而真 mod（`Seele_Overbuff.zip`）的 ini 是 `[Resource_*]` + `filename = xxx.buf` 这种写法。
 *
 * 规则：
 *   1. 包内没有 ini        → 不翻转
 *   2. ini 里没有任何 filename 声明 → 不翻转（desktop.ini 这类元数据 ini 即属此列）
 *   3. 图片 basename 命中 ini 声明的 filename（大小写不敏感、忽略目录） → 翻转
 *   4. 其余（未被声明，例如预览图） → 不翻转
 *
 * 环境约定：本文件同时被 Node（module.exports）与浏览器（globalThis.FlipRule）加载，
 *   与 gif-rule.js 相同的 UMD 写法，便于前端/工具复用同一口径。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FlipRule = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /**
   * ini 里声明文件名的键（3DMigoto 用 filename；如需支持其它键，加进这个数组即可，不要散落在调用方）
   * 注意：只认「键 = 值」这种赋值行，不认 desktop.ini 的 `a=@b,0` 形式（那种没有 filename 键）
   */
  const REF_KEYS = ["filename"];

  /** 取 basename（同时兼容 / 与 \ 两种分隔符） */
  function basenameOf(p) {
    if (!p) return "";
    const s = String(p).replace(/\\/g, "/");
    const i = s.lastIndexOf("/");
    return (i >= 0 ? s.slice(i + 1) : s).trim();
  }

  /** 去掉值两侧的引号与空白 */
  function unquote(v) {
    return String(v || "").trim().replace(/^["']|["']$/g, "").trim();
  }

  /**
   * 解析 ini 文本里声明的文件名集合（小写 basename）
   * @param {string} iniText
   * @returns {Set<string>}
   */
  function parseIniRefs(iniText) {
    const refs = new Set();
    if (!iniText) return refs;
    const keys = REF_KEYS.join("|");
    const re = new RegExp("^\\s*(?:" + keys + ")\\s*=\\s*(.+?)\\s*$", "i");
    for (const line of String(iniText).split(/\r?\n/)) {
      const m = line.match(re);
      if (!m) continue;
      const name = basenameOf(unquote(m[1]));
      if (name) refs.add(name.toLowerCase());
    }
    return refs;
  }

  /**
   * 是否需要翻转
   * @param {{imageName?:string, iniText?:string}} opts
   * @returns {boolean}
   */
  function shouldFlip(opts) {
    const o = opts || {};
    const name = basenameOf(o.imageName).toLowerCase();
    if (!name) return false;
    if (!o.iniText) return false;             // 规则 1
    const refs = parseIniRefs(o.iniText);
    if (!refs.size) return false;             // 规则 2
    return refs.has(name);                    // 规则 3 / 4
  }

  return {
    REF_KEYS: REF_KEYS,
    basenameOf: basenameOf,
    parseIniRefs: parseIniRefs,
    shouldFlip: shouldFlip,
  };
});
