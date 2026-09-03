# Glossary

## 供应商

程序内置的供应商种类（目前三个：OpenCode Go、DeepSeek、智谱 GLM），定义了取数方式、凭据槽位与统计形态。同一种类可以添加多个实例分别追踪。
_Avoid_：账户、配置（这两个词指「供应商实例」，见下）

## 供应商实例

某个供应商的一份可独立追踪的配置，自带凭据、备注、阈值、自动刷新开关、统计与告警；同一供应商可以有多个实例（如两个 DeepSeek 账号）。卡片、快照、通知与刷新状态都以实例为单位。
_Avoid_：账户、配置、条目

## 备注

用户为实例写的显示名，卡片主标题与告警标题优先使用它；留空时回退供应商名。

## 置顶

把实例固定在网格最前的操作，主窗口与快速面板共用同一顺序（置顶优先，其余按拖拽顺序）。

## 快照历史

刷新时对实例用量的一次采样所积累的时间序列（保留 30 天）。只在程序运行且刷新时产生，因此是稀疏采样而非账单；当前无界面消费方，仅持续积累。

## UserToken

DeepSeek 开放平台网页（platform.deepseek.com）登录后保存在浏览器 localStorage 中的登录态令牌，用于调用平台侧用量接口（`Authorization: Bearer <token>`）。与 DeepSeek API Key（`sk-...`，用于官方推理 API 与余额查询）是两种不同凭据。

## DeepSeek API Key

`sk-...` 形式的密钥，用于调用 DeepSeek 官方推理 API 与余额查询接口。与 UserToken 是两种不同凭据：API Key 授权程序访问账号的推理能力，UserToken 代表用户本人对开放平台控制台的会话。

## OpenCode Go

第二个受支持的供应商（provider 标识 `opencode-go`），基于 opencode.ai 的用量服务。凭据为 Workspace ID 与 Auth Cookie（两者必填），可选配 API Key 供官方 usage 接口上线后使用。设置页中与 DeepSeek 并列的供应商页签即指它。

## 智谱 GLM

第三个受支持的供应商（provider 标识 `glm`），追踪智谱 bigmodel.cn 的 Coding Plan 订阅配额。数据来自控制台私有接口（见 ADR-0009/0010），凭据仅需一枚 Coding Plan API Key。

## Coding Plan API Key

智谱控制台 Coding Plan 页「生成 API Key」所得的密钥（长期有效），即 Claude Code 等 Anthropic 兼容客户端里配置的 `ANTHROPIC_AUTH_TOKEN`。用于配额与用量统计查询（Bearer 注入，官方 glm-plan-usage 插件同款用法，见 ADR-0010）。

## Coding Plan

智谱的订阅制编码套餐，分 Lite / Pro / Max 档（快照上以小写 `level` 显示，如 `lite`）。额度机制为「5 小时窗口 + 周配额」双窗口的请求点数（接口类型 `CREDIT_LIMIT`）。

## 5 小时窗口

Coding Plan 的滚动 5 小时请求配额窗口（接口字段 `unit=3, number=5`）：任意时刻的配额按最近 5 小时内的消耗计算，窗口内点数用尽需等最早的消耗滑出窗口。与 OpenCode Go 的 5 小时额度同义。

## 周配额

Coding Plan 的滚动 7 天请求配额窗口（接口字段 `unit=6, number=1`）：重置时间由服务端下发（`nextResetTime`），不是自然周一。快照主指标与告警阈值取该窗口的已用百分比——它是重置周期最长的窗口，代表最紧的约束。

## 模型用量

Coding Plan 的按模型 Token 消耗统计（`model-usage` 端点，列式结构按时间桶对齐）。接口只提供按模型的 Token 序列；请求次数仅有全模型合计，无费用数据。统计页「智谱 GLM」页签的 Token 趋势图与模型明细即来自它。

## 工具用量

Coding Plan 的工具调用统计（`tool-usage` 端点）：固定三项（联网搜索、网页阅读 MCP、Zread MCP）加动态 MCP 工具列表。快照卡片不含它，仅在统计页展示。

## 快速面板

常驻后台的独立桌面小窗（代码中为 QuickWindow，窗口标识 `quick`）：全局快捷键唤起、失焦自动隐藏，集中展示各实例用量概要、告警与通知中心。顶栏双击打开主窗口并收起面板（单击并拖动顶栏移动面板）；高度随内容自适应（下限 240px，上限为屏幕工作区的 80%）。卡片顺序与置顶跟随主窗口，但不可拖拽、不含统计入口。与主窗口共用同一前端界面代码，是除主窗口外唯一的独立窗口——主题、语言等纯界面偏好需要跨窗口保持一致。

## 凭据库

Rust 后端管理的加密存储（实现名 Credential Vault），按供应商实例嵌套保存各类凭据（每个实例一份凭据槽位集合），前端不接触明文凭据。密文文件保存在应用数据目录下，用设备密钥加密。

## 设备密钥

随机生成的 256 位主加密密钥，由操作系统钥匙串托管（Windows Credential Manager / macOS Keychain / Linux Secret Service），与本机及系统用户绑定。凭据库文件用它加密，复制到另一台机器无法解密。
_Avoid_：主密钥、机器密钥、机器绑定密钥（它不是从机器派生的，而是随机生成后托管在本机）

## 凭据库迁移

废除主密码后的一次性升级动作：用户最后一次输入旧主密码，程序把旧凭据库解密后用设备密钥重新加密。首次升级启动时引导，跳过后可在设置页补做。

## 自动刷新总开关

设置页「通用」页签中的全局开关，是程序一切自动刷新行为的总闸：总览快照的定时刷新、统计页的定时刷新都由它控制。关闭后程序只进行手动刷新。

## 供应商自动刷新

每个供应商实例配置弹窗中的开关，决定该实例是否参与定时刷新（总览快照与统计抽屉中该实例的数据）。受自动刷新总开关门控：总开关关闭时禁用置灰，开关值保留。不影响手动刷新——手动「刷新」始终拉取所有实例。

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
