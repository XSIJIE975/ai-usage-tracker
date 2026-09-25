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

## 二次修订：补上 Content-Security-Policy（2026-09-25）

**起因**：Qoder 统计页接入时（ADR-0030 §6）第一次把未经过滤的接口字符串（`operation`、`model_category`）灌进 ECharts 系列名，而 tooltip 的 `formatter` 返回 HTML 串、ECharts 用 `innerHTML` 落 DOM —— 全仓此前没有任何 HTML 转义工具。DeepSeek 的模型名走的是同一条既有路径。审查据此定级为「上游响应被投毒 → WebView XSS」面，而 `tauri.conf.json` 的 `app.security.csp` 一直是 `null`（等于不设防，内联 `onerror=` 可直接执行）。

**改了两层**：

1. **第一道（权威）**：`src/lib/utils.ts` 新增 `escapeHtml`，`StackedBars` / `Donut` / `LineChart` 三个 formatter 里所有来自接口的插值（系列名、分类名）统一过一层；`p.marker` 是 ECharts 自己生成的圆点 HTML，保持原样。
2. **第二道（纵深）**：`app.security.csp` 从 `null` 改为显式策略 —— `default-src 'self'`、`script-src 'self'`（无 `unsafe-inline`、无 `unsafe-eval`）、`connect-src 'self' ipc: http://ipc.localhost`、`object-src 'none'`、`base-uri 'self'`、`form-action 'none'`、`frame-ancestors 'none'`；`style-src` 必须带 `'unsafe-inline'`（React 内联样式与 ECharts 写 `element.style` 都依赖它，样式注入的危害远低于脚本）。

**取数不受影响的根据**：全部网络请求由 Rust 侧 `provider_request` 发出，前端零 `fetch`/`XMLHttpRequest`/`WebSocket`（已 grep 证实），所以 `connect-src` 不放行任何供应商域名 —— webview 自己想外连也连不出去。`img-src` 只额外放行 `https://github.com` 与 `https://objects.githubusercontent.com`：更新日志（ADR-0028）会渲染 release notes 里的 markdown 图片，而发布说明的图只可能来自 GitHub；其余域名的图片会被拦，界面表现为破图（错误可见）。

**dev 构建刻意更松**：`devCsp` 的 `script-src` 带 `'unsafe-inline'`、`connect-src` 带 `ws://localhost:1420` 与 `http://localhost:1420` —— Vite React-Refresh 的 preamble 是内联模块脚本，HMR 要连本地 ws，不给就起不来。代价要说清：**dev 环境拿不到脚本层的 CSP 防护**，而 dev 也连着真实凭据在用；真正拦住这次场景的是第 1 层的转义，不是 CSP。用 `TAURI_DEV_HOST` 上真机调试时 HMR 端口是 1421，需要临时把那个地址加进 `devCsp` 的 `connect-src`。

**CSP 没解决的那半**：渲染进程仍能经 `invoke` 调到 `vault_credentials` 拿明文凭据（编辑凭据表单需要它）。所以 XSS 一旦成立，CSP 只能挡住"往外发"，挡不住"通过 IPC 要凭据"。彻底的收口要把凭据读取从渲染进程移走（改后端代填掩码值 + 只在保存时接收新值），那是独立的一轮改动，本期不做，只在此登记。
