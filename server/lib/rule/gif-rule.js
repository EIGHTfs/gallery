/* server/lib/rule/gif-rule.js —— GIF 合成规则（唯一实现，前后端共用同一份源文件）
 *
 * 为什么单独成文件：
 *   本规则原先在前端（js/shell/tree.js 的 detectFramesFromNames / parseFrameMs）与后端
 *   （lib/gif.js 的 detectFramesFromDir）各写了一份，口径一改就漂。抽到本文件后，
 *   前端由分片清单（js/manifest.json 里的 ../server/lib/rule/gif-rule.js）内联进 app.js，
 *   后端由 assemble.json 映射成 server/lib/rule/gif-rule.js 后直接 require —— 同一份源，两处消费。
 *
 * 本文件定义两条合成规则（2026-10-14 口径）：
 *   ┌ 规则一 · mod 合成 GIF：3DMigoto mod（包内/目录含 .ini，贴图倒置存储）且是序列帧且 ini 有 $speed
 *   │                        → 合成，输出前 180° 翻转（flip=true），帧间隔按 1000/(fps×$speed)
 *   └ 规则二 · 图包合成 GIF：图包（压缩包名带间隔 @40ms / 2s，Pixiv 图包）且是序列帧
 *                            → 按该间隔合成，不翻转（flip=false）
 *   两条都不命中 → 不合成、原样显示。
 *
 * 目录（文件夹）口径：上述两条规则都只针对**压缩包**；目录内图片一律平铺原图，不合成
 *   —— 卡面/图集这类数字编号图（tex_support_card_10001.png…）与动画帧在命名上无法区分，只能按来源判定。
 *
 * 环境约定：本文件同时被 Node（module.exports）与浏览器（globalThis.GifRule）加载，
 *   故用 UMD 包装；只含纯函数，不依赖任何宿主 API，便于测试。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GifRule = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // 少于 3 张不算序列帧（与原实现一致）
  const MIN_FRAMES = 3;

  /** 文件名拆成「前缀 + 数字 + 扩展名」；不匹配返回 null */
  function splitFrameName(name) {
    const m = String(name).match(/^(.*?)(\d+)(\.\w+)$/);
    if (!m) return null;
    return { prefix: m[1], num: parseInt(m[2], 10), ext: m[3] };
  }

  /**
   * 序列帧检测：同前缀 + 编号连续递增，取最长连续段（两条规则的公共前置条件）。
   * @param {string[]} names 图片文件名数组
   * @returns {{name:string,file:string,num:number,ext:string}[]} 连续帧数组（不足 3 张返回 []）
   */
  function detectFrames(names) {
    if (!names || names.length < MIN_FRAMES) return [];
    const groups = new Map();
    for (const n of names) {
      const s = splitFrameName(n);
      if (!s) continue;
      if (!groups.has(s.prefix)) groups.set(s.prefix, []);
      groups.get(s.prefix).push({ name: String(n), file: String(n), num: s.num, ext: s.ext });
    }
    let best = [];
    for (const arr of groups.values()) {
      if (arr.length < MIN_FRAMES) continue;
      const sorted = arr.slice().sort((a, b) => a.num - b.num);
      let run = [sorted[0]];
      let bestRun = run;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].num === sorted[i - 1].num + 1) run.push(sorted[i]);
        else { if (run.length > bestRun.length) bestRun = run; run = [sorted[i]]; }
      }
      if (run.length > bestRun.length) bestRun = run;
      if (bestRun.length > best.length) best = bestRun;
    }
    return best.length >= MIN_FRAMES ? best : [];
  }

  /** 兼容原前端签名：是否序列帧（布尔） */
  function detectFramesFromNames(names) {
    return detectFrames(names).length >= MIN_FRAMES;
  }

  /**
   * 规则一 · mod 合成 GIF。
   * 成立条件：序列帧 + 含 .ini（3DMigoto mod） + ini 有 $speed>0。
   * 输出约定：翻转（包内贴图倒置存储）；帧间隔由调用方按 1000/(fps×$speed) 换算（fps 默认 60）。
   * @param {{names?:string[], hasIni?:boolean, speed?:number}} opts
   */
  function modGifRule(opts) {
    const o = opts || {};
    const frames = detectFrames(o.names || []);
    const isSeq = frames.length >= MIN_FRAMES;
    const speed = Number(o.speed);
    const hit = isSeq && !!o.hasIni && speed > 0;
    return { rule: "mod", synth: hit, flip: true, frames: frames, isSeq: isSeq, speed: speed > 0 ? speed : 0 };
  }

  /**
   * 规则二 · 图包合成 GIF。
   * 成立条件：序列帧 + 包名带帧间隔（@40ms / 500ms / 2s）。
   * 输出约定：按该间隔合成；不翻转。
   * @param {{names?:string[], packageName?:string}} opts
   */
  function imagePackGifRule(opts) {
    const o = opts || {};
    const frames = detectFrames(o.names || []);
    const isSeq = frames.length >= MIN_FRAMES;
    const frameMs = parseFrameMs(o.packageName || "");
    const hit = isSeq && frameMs > 0;
    return { rule: "imagePack", synth: hit, flip: false, frames: frames, isSeq: isSeq, frameMs: frameMs };
  }

  /**
   * 目录（文件夹）是否允许合成 GIF。
   * 口径：不允许 —— 上述两条规则只针对压缩包；目录一律平铺原图。
   * 保留成函数（而不是删掉调用点）是为了让口径有单一出处，日后要改只改这里。
   */
  function shouldSynthDir() {
    return false;
  }

  /**
   * 压缩包合成判定：两条规则任一命中即合成（mod 优先，命中时带 flip 与 speed）。
   * @param {{names?:string[], packageName?:string, hasIni?:boolean, speed?:number}} opts
   */
  function shouldSynthZip(opts) {
    const o = opts || {};
    const mod = modGifRule(o);
    const pack = imagePackGifRule(o);
    if (mod.synth) return { synth: true, rule: "mod", flip: true, frames: mod.frames, frameMs: 0, speed: mod.speed };
    if (pack.synth) return { synth: true, rule: "imagePack", flip: false, frames: pack.frames, frameMs: pack.frameMs, speed: 0 };
    return { synth: false, rule: null, flip: false, frames: mod.frames.length ? mod.frames : pack.frames, frameMs: pack.frameMs, speed: 0 };
  }

  /** 包名里的帧间隔："2s"/"500ms"/"@40ms" → 毫秒；无则 0（默认总时长 2 秒均分） */
  function parseFrameMs(name) {
    if (!name) return 0;
    let m = String(name).match(/(\d+(?:\.\d+)?)\s*(?:s|sec|秒)/i);
    if (m) { const v = Math.round(parseFloat(m[1]) * 1000); return v > 0 ? v : 0; }
    m = String(name).match(/(\d+)\s*ms/i);
    if (m) { const v = parseInt(m[1], 10); return v > 0 ? v : 0; }
    return 0;
  }

  return {
    MIN_FRAMES: MIN_FRAMES,
    detectFrames: detectFrames,
    detectFramesFromNames: detectFramesFromNames,
    modGifRule: modGifRule,
    imagePackGifRule: imagePackGifRule,
    shouldSynthDir: shouldSynthDir,
    shouldSynthZip: shouldSynthZip,
    parseFrameMs: parseFrameMs,
  };
});
