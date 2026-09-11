# Release 构建的 WebView 加固

Status: accepted

## Context

2026-09-11 用户报告：release 版按 F5 会重载前端（并经由告警状态丢失触发重复通知，见 ADR-0025），且不希望 release 版保留右键上下文菜单与调试入口。

核对：Windows 上 WebView2 默认开启浏览器加速键（F5/Ctrl+R/F12/Ctrl+F 等）、默认右键菜单（含「刷新」「检查」）与 devtools；Tauri v2 不会自动关闭这三样（`devtools` cargo feature 只控制 tauri API 层）。当前配置（`tauri.conf.json` 三窗口静态定义、无 `additionalBrowserArgs` 定制）即默认全开。macOS/Linux 的 webview 同样带各自的默认右键菜单。

## Decision

**release 构建禁用页面重载、右键菜单与 devtools；dev 构建全部保留。双层实现：**

1. **WebView 层（Windows）**：release（`!cfg!(debug_assertions)`）下在 setup 里对全部窗口经 `with_webview` 关闭三个 `ICoreWebView2Settings`：`AreDefaultContextMenusEnabled`、`AreDevToolsEnabled`、`AreBrowserAcceleratorKeysEnabled`。`webview2-com` 依赖与 tauri 锁定版本（0.38.x）对齐，避免 COM 接口类型跨版本不兼容。
2. **前端层（全平台）**：仅 `import.meta.env.PROD` 注入 capture 级监听——`keydown` 拦截 F5/Ctrl+R/Cmd+R/F12/Ctrl+Shift+I/Cmd+Shift+I，`contextmenu`、`dragover`、`drop` 全部 `preventDefault`（顺带堵住拖文件进窗口把 webview 导航到 file:// 的路径）。覆盖 macOS/Linux 的右键菜单与 Windows 层的漏网路径。

用户选择「彻底屏蔽」而非「把 F5 重绑定为应用级数据刷新」。

## Considered Options

- **仅前端拦截**：F12/devtools 等浏览器级快捷键先于 DOM 处理，JS 拦不干净；WebView2 设置层才是权威关闭点。
- **仅 WebView 层**：只覆盖 Windows，macOS/Linux 的右键菜单无对应开关，前端拦截是跨平台兜底。
- **重绑 F5 为数据刷新**：保留刷新肌肉记忆，但与「发布版界面不可被重载」的目标冲突，被否。

## Consequences

- release 版无法重载前端、无法打开 devtools、无右键菜单；dev 构建行为不变（HMR 与调试依赖这些入口）。
- 前端重载被堵住后，ADR-0025 的状态持久化仍有独立价值（应用重启、webview 崩溃自愈、多窗口演进），两层互不依赖。
- macOS 上 WKWebView 不自带 F5 重载，前端拦截为无害冗余。
- 若未来需要在 release 诊断现场，可考虑受控的隐藏开关（如环境变量 + 调试日志），本期不做。
