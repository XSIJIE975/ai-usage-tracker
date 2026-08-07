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

GitHub Actions 会为 Windows、macOS、Linux 分别构建安装包。

## 使用

1. 首次启动创建 Credential Vault 主密码。
2. 在“设置”中填写：
   - DeepSeek API Key：`sk-...`
   - OpenCode Go Workspace ID：后台 URL 中的 `wrk_...`
   - OpenCode Auth Cookie：登录 `opencode.ai` 后浏览器里的 `auth` Cookie 值
   - OpenCode Go API Key（可选）：官方 `/usage` 接口上线后使用
3. 设置自动刷新间隔，或点击“刷新”手动更新。
4. 关闭主窗口后应用继续驻留托盘；托盘图标可打开快速面板。

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
- 本机已完成 Windows 验证；macOS/Linux 实机验证由三平台 CI 承担。
