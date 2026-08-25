# AI Usage Tracker / AI 用量助手

跨平台桌面工具，用于在系统托盘快速查看 AI 订阅和 API 用量。第一版内置 OpenCode Go 和 DeepSeek 两个 Provider。

## 功能

- 系统托盘快速面板：点击托盘图标查看 OpenCode Go 5 小时/周/月额度和 DeepSeek 余额。
- 主窗口：Credential Vault 创建/解锁、Provider 凭据配置、刷新策略和用量卡片。
- 自研 Credential Vault：主密码 + Argon2id + AES-256-GCM，不依赖系统钥匙串。
- OpenCode Go：优先尝试官方 `/zen/go/v1/usage`，未上线时降级抓取后台页面解析账号真值。
- DeepSeek：通过官方 API Key 查询余额、可用状态和刷新时间。
- 刷新策略：可自定义分钟数，最大 120 分钟，超过 60 分钟显示为小时，可禁用自动刷新。

## 开发环境

需要 Node.js 22+、pnpm 10+ 和 Rust stable。

```sh
pnpm install
pnpm tauri dev
```

## 测试与构建

```sh
pnpm test
cd src-tauri && cargo test
pnpm build
pnpm tauri build
```

Windows 本地如果 NSIS 下载超时，可以先生成 MSI：

```sh
pnpm tauri build --bundles msi
```

## 版本与发布流程

项目使用 Changesets 管理版本。日常开发不触发打包：

1. 功能或修复改动在 `dev` 分支开发，并为用户可见变更执行 `pnpm changeset` 添加变更说明。
2. 通过 PR 将代码合入 `main`，基础 CI 只运行前端测试、前端构建和 Rust 测试。
3. Changesets 检测到变更说明后自动创建或更新 Version Packages PR。
4. 合并 Version Packages PR 后，GitHub Actions 才会在 Windows、macOS、Linux 上执行 Tauri 打包。
5. 发布 workflow 会生成 `vX.Y.Z` draft release，安装包上传后由你在 GitHub 网页手动发布。

发布 workflow 使用 `package.json` 作为版本源，并自动同步 `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json`。

## 使用

1. 首次启动创建 Credential Vault 主密码。
2. 在“设置”中填写：
   - DeepSeek API Key：`sk-...`
   - DeepSeek UserToken：platform.deepseek.com 网页登录态令牌，统计页使用（获取方式见下）
   - OpenCode Go Workspace ID：后台 URL 中的 `wrk_...`
   - OpenCode Auth Cookie：登录 `opencode.ai` 后浏览器里的 `auth` Cookie 值
   - OpenCode Go API Key（可选）：官方 `/usage` 接口上线后使用
3. 设置自动刷新间隔，或点击“刷新”手动更新。
4. 关闭主窗口后应用继续驻留托盘；托盘图标可打开快速面板。

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

## 数据与安全

- 凭据保存在应用数据目录的 `vault.json` 中，使用主密码派生密钥加密。
- 用量快照保存在本地 SQLite 数据库 `ai-usage-tracker.db`。
- 应用不会上传凭据或用量数据到第三方服务。
- 忘记主密码将无法恢复已保存凭据。

## 已知边界

- OpenCode Go 官方 `/zen/go/v1/usage` 当前线上 404，主要依赖 dashboard scraping，页面结构变化时可能需要更新解析器。
- Auth Cookie 可能过期，出现 HTTP 401/403 时需要在设置中重新填写。
- 统计页通过平台网页端私有接口取数（详见 ADR 0006）：opencode.ai 侧依赖构建产物中的 `x-server-id` 常量，平台重新部署可能使其失效；DeepSeek 平台网页接口同样无兼容性承诺。失效时会在界面给出明确错误提示。
- DeepSeek UserToken 为网页登录态凭据，会过期，需要在设置中重新粘贴。
- 本机已完成 Windows 验证；macOS/Linux 实机验证由三平台 CI 承担。
