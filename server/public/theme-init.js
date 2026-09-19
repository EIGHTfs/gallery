// 主题初始化（两端共用）：进页面立即应用上次选择的主题，防闪烁。
// 蓝白 = 白天模式（默认）；香蕉风深色 = 夜间模式，支持切换。
// 必须在 <head> 内同步加载（无 defer/async），DOM 解析前生效，避免闪烁。
try {
  const th = localStorage.getItem("gbmd-theme");
  if (th === "night") document.documentElement.setAttribute("data-theme", "night");
} catch (_) {}