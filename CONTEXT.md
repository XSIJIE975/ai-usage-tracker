# Glossary

## UserToken

DeepSeek 开放平台网页（platform.deepseek.com）登录后保存在浏览器 localStorage 中的登录态令牌，用于调用平台侧用量接口（`Authorization: Bearer <token>`）。与 DeepSeek API Key（`sk-...`，用于官方推理 API 与余额查询）是两种不同凭据。

## DeepSeek API Key

`sk-...` 形式的密钥，用于调用 DeepSeek 官方推理 API 与余额查询接口。与 UserToken 是两种不同凭据：API Key 授权程序访问账号的推理能力，UserToken 代表用户本人对开放平台控制台的会话。

## 凭据库

Rust 后端管理的加密存储（实现名 Credential Vault），统一保存 DeepSeek API Key、UserToken 等凭据，前端不接触明文凭据。密文文件保存在应用数据目录下，用设备密钥加密。

## 设备密钥

随机生成的 256 位主加密密钥，由操作系统钥匙串托管（Windows Credential Manager / macOS Keychain / Linux Secret Service），与本机及系统用户绑定。凭据库文件用它加密，复制到另一台机器无法解密。
_Avoid_：主密钥、机器密钥、机器绑定密钥（它不是从机器派生的，而是随机生成后托管在本机）

## 凭据库迁移

废除主密码后的一次性升级动作：用户最后一次输入旧主密码，程序把旧凭据库解密后用设备密钥重新加密。首次升级启动时引导，跳过后可在设置页补做。

## 自动刷新总开关

设置页「通用」页签中的全局开关，是程序一切自动刷新行为的总闸：总览快照的定时刷新、统计页的定时刷新都由它控制。关闭后程序只进行手动刷新。

## 供应商自动刷新

各供应商设置页签内的开关，决定该供应商是否参与定时刷新（总览快照与统计页中该供应商的数据）。受自动刷新总开关门控：总开关关闭时禁用置灰，开关值保留。不影响手动刷新——手动「刷新」始终拉取所有供应商。

## 缓存命中率

统计页展示的派生指标：`PROMPT_CACHE_HIT_TOKEN ÷ (PROMPT_CACHE_HIT_TOKEN + PROMPT_CACHE_MISS_TOKEN)`，即输入 Token 中命中提示缓存的占比。用于解释成本差异——DeepSeek 缓存命中的单价远低于未命中。

## 基础 CI

在 `dev` 分支推送或向 `main` 发起 PR 时运行的轻量检查流程。它只执行前端测试、前端构建和 Rust 测试，不生成安装包。

## Version Packages PR

由 Changesets 自动创建或更新的发布 PR。合并该 PR 会更新版本号、CHANGELOG 和 Tauri 配置，并成为打包流程的触发入口。

## Draft Release

发布 workflow 创建的暂存 GitHub Release。安装包上传完成后仍为草稿，需要用户在 GitHub 网页手动发布。草稿期已包含签名的更新产物与 `latest.json`；手动发布即同时开放安装包下载与自动更新通道。

## 版本源

`package.json` 中的版本号是唯一版本源。发布脚本会在 Changesets 更新版本后同步 `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json`。

## 更新签名密钥

`tauri signer generate` 生成的 minisign 密钥对。公钥固化在 `tauri.conf.json`，用于校验更新包签名；私钥与密码仅存开发者本机（仓库外 `~/.tauri/`）与 GitHub Secrets（`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`），永不入库。私钥丢失即失去更新通道，存量用户只能手动重装。

## latest.json

tauri-action 随发布产物自动上传的静态更新清单，记录各平台更新包的下载地址与签名。`releases/latest/download/latest.json` 恒指向最新已发布 Release，是应用内自动更新通道的唯一数据源。

## 自动更新

启动后在后台静默检查 `latest.json`：发现新版本时顶栏出现「新版本」徽标，设置 → 通用的「关于与更新」卡片可手动检查、查看变更说明、下载并安装（Windows 由 NSIS 安装器静默完成，无需管理员权限）。首个带更新能力的版本无法被更早的安装自动升级到，需手动重装一次。
