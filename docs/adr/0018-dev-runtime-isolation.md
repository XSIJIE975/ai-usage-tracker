# 开发构建与安装版的运行时隔离

Status: accepted

修正 ADR-0015 的一个误判：「开发模式下注册的是 debug 可执行文件路径，仅影响本机开发环境」不成立——debug 构建与安装版共享全部运行时身份，dev 会话的实际影响半径是安装版的自启与单实例行为。

## Context

dev（`pnpm tauri dev` / debug 构建）与安装版（NSIS 落地的 release 构建）在三个身份维度上完全同名：

1. **自启 Run 值名**：`autostart.rs` 以 `product_name`（"AI Usage Tracker"）作注册表值名；
2. **应用数据目录**：`app_data_dir()` 由 identifier（`com.aiusagetracker.desktop`）派生，设置库、凭据库、WebView 数据共用；
3. **单实例锁**：tauri-plugin-single-instance 的 mutex / 窗口类名同样由 identifier 派生。

叠加 ADR-0015 的「启动时对已开启的自启重放一次 enable（以当前 exe 路径覆盖同名值）」，产生两条真实事故链（2026-09-09 排查确认）：

- dev 会话启动 → 重放 enable → HKCU Run 值被覆盖为 `target\debug\ai-usage-tracker.exe` → 次日开机执行 debug exe；debug 构建保留 console 子系统（`main.rs` 的 `windows_subsystem` 仅在 release 生效），弹出命令行窗口，且 `--silent` 只作用于应用窗口、拦不住进程创建期的控制台分配。安装版同机自启失效——Run 值已不指向它，设置页因读共享设置库仍显示「已开启」。
- 安装版运行中启动 dev（或反之）→ 后来者检测到锁已存在，把参数发给先到者后自行退出。留下的实例没有任何外观标识，无法分辨是哪个构建。

## Decision

**安装版的运行时身份唯一且神圣；dev 构建成为可并存的独立实例。**

1. **自启注册只允许安装版执行**：`autostart::apply()` 在 debug 构建（`cfg!(debug_assertions)`）顶端短路，enable / disable 一律不触碰注册表——disable 也拦，防止 dev 误删安装版的 Run 值。守卫选编译期标记而非 `app.is_dev()`：危险面是 debug 构建这一产物形态（console 子系统、路径不稳定），与是否连着 dev server 无关。
2. **dev 使用独立 identifier**：新增 `src-tauri/tauri.dev.conf.json`（仅覆盖 `identifier` 为 `com.aiusagetracker.desktop.dev`），经 `pnpm tauri:dev`（即 `tauri dev --config`）注入。单实例锁、数据目录、凭据库、WebView 数据随之天然分离，两实例可并存、互不劫持。`tauri build` 永不携带该覆盖，安装版身份不受影响。
3. **应用展示名统一携带 "(dev)" 后缀**：后缀内聚在 Rust `dev_suffix()`/`app_title()`/`tray_tooltip()` 与前端 `useT` 对应用名键的处理中，覆盖窗口标题、托盘提示（含动态摘要）、应用内标题（主窗口、快速面板、速览面板、关于页、迁移页）。走代码而非 dev 配置覆盖 `app.windows`——配置数组合并是整段替换，复制主配置会引入标题之外的尺寸漂移风险；标题重设也必须走这些函数（`refresh_tray_menu` 会整体重写窗口标题，在调用侧外部拼接的后缀会被冲掉，实现期实际踩过）。

前端「开机自启 / 静默启动」设置卡在 dev 下保留但置灰，附提示「开发模式下不注册开机自启」，与 Rust 短路构成双保险（防止 dev 里触发无效的保存反馈）。

## Considered Options

- **仅拆单实例锁**（dev 不注册 single-instance 插件、继续共用数据）：两构建继续共用 WebView2 用户数据目录，双实例并存的浏览器进程共享行为不可控；数据共用虽便于拿真实配置调试，但身份依旧无法分辨。否决。
- **single-instance 插件 semver feature**（锁名拼接版本号）：依赖 dev 与 release 的版本号恰好错开，受发版节奏约束，纪律脆弱。否决。
- **dev 配置覆盖窗口标题**（declarative）：见 Decision 3 的漂移问题。否决，标题改走代码。

## Consequences

- dev 数据目录（Roaming / Local 的 `*.dev` 目录）从零开始：供应商实例与凭据需一次性重配；设备密钥按独立 identifier 自动生成，无需额外密码。
- `pnpm tauri dev`（不带 `--config`）仍可用但**不应再使用**——它启动的 dev 实例持有真实 identifier，与安装版单实例锁同名，互斥劫持问题依旧；自启短路守卫仍生效，但两实例并存的收益全部丢失。团队约定统一走 `pnpm tauri:dev`。
- 两实例并存时：通知与自动刷新各自独立。全局快捷键默认值随构建分流——安装版 Alt+U、开发实例 Ctrl+Shift+U（`db.rs` 与前端默认值两处同步按构建条件取值），默认不再抢占同一注册位；用户改键后仍可能冲突，Windows 无法查询占用者身份，提示策略为：设置页更换时注册失败红字提示并回退旧组合，启动期注册失败无内联界面可提示，改发系统通知告知用户更换。
- 自启 Run 值名仍取 `product_name`，NSIS 卸载钩子（ADR-0015）不变；debug 构建永不注册后，不再与安装版竞争该值。
