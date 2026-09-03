# AI Usage Tracker / AI 用量助手

一款跨平台桌面工具，帮你在系统托盘随时掌握 AI 订阅额度与 API 用量。内置 OpenCode Go、DeepSeek、智谱 GLM 三个 Provider。

## 功能

- 系统托盘快速面板：点击托盘图标即可查看 OpenCode Go 的 5 小时/周/月额度、DeepSeek 余额和智谱 GLM 配额进度，无需打开主窗口；双击面板顶栏可打开主窗口并收起面板，面板高度随内容自适应。
- 供应商多实例：同一供应商可添加多份配置（如两个 DeepSeek 账号），各自独立追踪、统计与告警；实例可写备注作为卡片标题。
- 用量总览：按实例分卡片展示额度进度、账户余额与重置倒计时；卡片网格支持拖拽排序与置顶；额度使用超七成时进度条自动转为警示色。
- 用量统计：卡片「查看统计」打开右侧统计抽屉，支持按时间范围、模型等维度查看 Token 消耗与请求趋势。
- 凭据本地加密：凭据以 AES-256-GCM 加密存储在本机，加密密钥托管在系统钥匙串（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），启动即用、全程无需输入密码。
- OpenCode Go：优先调用官方 `/zen/go/v1/usage` 接口，接口未上线时自动降级为抓取后台页面解析真实额度。
- DeepSeek：通过官方 API Key 查询账户余额与可用状态。
- 智谱 GLM：一枚 Coding Plan API Key 同时驱动配额卡片与用量统计——总览展示套餐档位（Lite / Pro / Max）、5 小时窗口与每周配额进度及重置倒计时；配额已用比例达到阈值时发送系统通知。
- 刷新策略：全局间隔 5–120 分钟可调（超过 60 分钟以小时显示），可按 Provider 单独关闭自动刷新，手动刷新始终拉取全部 Provider。

## 开发环境

需要 Node.js 22+、pnpm 10+ 和 Rust stable 工具链。

```sh
pnpm install
pnpm tauri dev
```

## 测试与构建

```sh
pnpm test
cd src-tauri && cargo test
pnpm build
pnpm tauri build --no-sign
```

## 使用

1. 点击主窗口右上角「添加供应商」，选择供应商并填写凭据（可加备注区分多个账号）：
   - DeepSeek API Key：`sk-...`
   - DeepSeek UserToken：platform.deepseek.com 网页登录态令牌，统计使用（获取方式见下）
   - OpenCode Go Workspace ID：后台 URL 中的 `wrk_...`
   - OpenCode Auth Cookie：登录 `opencode.ai` 后浏览器里的 `auth` Cookie 值
   - OpenCode Go API Key（可选）：官方 `/usage` 接口上线后使用
   - 智谱 Coding Plan API Key：bigmodel.cn 控制台 Coding Plan 页生成（获取方式见下）
2. 实例的告警阈值与自动刷新开关在其配置弹窗（卡片 ⋯ 菜单）中设置；全局刷新间隔在设置中调整。
3. 关闭主窗口后应用继续驻留托盘；托盘图标可打开快速面板。

DeepSeek UserToken 获取方式（统计页使用，与 API Key 是两种不同凭据）：

1. 打开 `https://platform.deepseek.com` 并登录。
2. 按 F12 打开开发者工具，进入 Application → Local Storage → `https://platform.deepseek.com`。
3. 找到键 `userToken`，其值是一个 JSON 对象，复制其中 `token` 字段的字符串值。
4. Token 过期后统计页会提示重新填写。

OpenCode Go Auth Cookie 获取方式：

1. 打开 `https://opencode.ai/workspace/{workspaceId}/go` 并登录。
2. 按 F12，打开 `Application`（Chrome/Edge）或 `Storage`（Firefox）。
3. 进入 `Cookies -> https://opencode.ai`。
4. 找到名为 `auth` 的 Cookie，复制 `Value` 列的内容。
5. 粘贴到设置中即可；程序也兼容 `auth=...`、`Cookie: auth=...` 或完整 Cookie 列表，会自动提取 `auth` 的值。

智谱 Coding Plan API Key 获取方式（配额卡片与用量统计共用这一枚凭据）：

1. 打开 `https://bigmodel.cn` 控制台并登录。
2. 进入 Coding Plan 页面，点击「生成 API Key」。
3. 复制生成的 API Key，粘贴到设置中。
4. 如果你在 Claude Code 中配置过智谱 GLM，与 `ANTHROPIC_AUTH_TOKEN` 是同一枚密钥，直接复用即可。

## 数据与安全

- 凭据保存在应用数据目录的 `vault.json` 中，以 AES-256-GCM 加密；加密密钥为随机生成的设备密钥，托管在系统钥匙串（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）。
- 用量快照保存在本地 SQLite 数据库 `ai-usage-tracker.db`。
- 应用不会上传凭据或用量数据到第三方服务。
- 系统钥匙串中的设备密钥丢失（如重装系统、更换设备）后，凭据无法解密，需要重新录入。

## 已知边界

- OpenCode Go 官方 `/zen/go/v1/usage` 接口尚未上线，目前主要依赖后台页面解析获取额度，页面结构变化时可能需要更新解析器。
- 网页登录态凭据（DeepSeek UserToken、OpenCode Go Auth Cookie）会过期，遇到 HTTP 401/403 时需要在设置中重新粘贴。
- 用量统计通过供应商平台的网页端私有接口取数，平台侧无兼容性承诺：OpenCode Go 依赖其前端构建产物中的 `x-server-id` 常量，平台重新部署可能失效；DeepSeek 平台网页接口同理。失效时界面会给出明确错误提示。
- 智谱官方未公开用量查询 API，配额与统计数据通过智谱控制台私有接口获取（与智谱官方 glm-plan-usage 插件使用同一数据通道），无兼容性承诺；接口变更时错误信息会透出服务端返回码。
- 智谱 GLM 仅跟踪 Coding Plan 订阅配额，不展示 API 按量付费余额；混合付费用户需在智谱控制台查看余额。
- macOS 安装包未经 Apple 公证，首次打开需在 Finder 中右键选择「打开」以绕过 Gatekeeper。
- 桌面端已在 Windows 实机完成验证；macOS 与 Linux 由三平台 CI 构建验证。
