# OpenCode Go：API Key 取额度与概览，控制台 Cookie 取余额与日志

Status: accepted

## Context

OpenCode 已把工作区用量迁到新版控制台，旧工作区页面只剩空 SPA 壳；旧页面抓取、SSR 解析与回退链路已经整体删除。现在有两类凭据，能力不同：

- **API Key（必填）**：`GET https://opencode.ai/zen/go/v1/usage`，`Authorization: Bearer <key>`，响应 `{ usage: { rolling, weekly, monthly } }`，每项 `{ percent: 0–100, resetsAt | resetInSec }`。账号级接口，不需要 Workspace ID，也不需要 Cookie。401 = Key 无效，403 = 该账号没有 Go 订阅。
  - 控制台生成的 `oc_sk_…` 服务 Key 也能打这个接口；2026-10-17 真机验证返回了三个窗口。
- **控制台 Cookie（选填）**：`GET https://opencode.ai/console/api/billing/status`，需要 `x-org-id: <wrk_…|org_…|wk_…>` 与 `Cookie: __Host-console_session=…`（缺 `x-org-id` 回 400）。响应 `{ balanceMicroCents: "0", availableMicroCents: "0", ... }`，`balanceMicroCents` 是十进制字符串（1e8 = $1），可带负号；缺失或非法时不显示余额，不拿 `availableMicroCents` 顶替。
  - 只有控制台登录态（用户 token/Cookie）能读余额；`oc_sk_…` 服务 Key 打 `billing/status` 回 403，Go 模型 Key 也读不到。

新版控制台还提供了统计接口，控制台 UI 的 Overview / Logs 两个页签就是它们：

- `GET /console/api/usage/summary?range=24h|7d|30d`：总请求、输入/输出/缓存读取/缓存写入 token、总成本（micro-cents）。
- `GET /console/api/usage/cost-by-day?range=…&bucket=hour|day`：按日/小时的 `{date,totalCostMicroCents,totalTokens,totalRequests}` 数组；24h 用 `hour`，7d/30d 用 `day`。
- `GET /console/api/usage/models?range=…&page=&pageSize=&costOrder=desc&includeLegacyKeys=true`：按模型的请求/token/成本聚合，`pageInfo.pageCount` 翻页。
- `GET /console/api/request-logs?since=<epoch ms>&limit<=100&cursor=…`：请求明细，字段含 `startedAt`、`durationMs`、`statusCode/outcome`、`model/provider`、输入/输出/推理/缓存 token、`cost`（已是美元）、`sessionID`；响应带 `nextCursor` 与 `retentionDays`（30 天）。

鉴权边界经真机验证：`oc_sk_…` 服务 Key 能读 `usage/summary`、`usage/cost-by-day`、`usage/models`，但打 `request-logs` 回 403；请求日志需要控制台会话 Cookie + `x-org-id`。旧 `/_server` RPC 对已迁移工作区不可靠，统计抽屉原先的月成本/历史记录 UI 与解析器已无数据源。

原实现还有两类问题：旧页面抓取已无数据；API Key 分支解析的是不存在的 `windows[]`，且 Cookie 归一化会把 `__Host-console_session` 削掉。第三方实现（CodexBar、openchamber、orca、limits-tracker）给出了用量与余额契约的旁证；统计与日志端点来自控制台 bundle 的静态分析与真机请求。

## Decision

**API Key 必填，负责额度与统计概览；Workspace ID + Cookie 成对选填，负责 Zen 余额与请求日志。**

1. **额度只走 API Key**。`fetchUsage` 缺 API Key 直接 `needs_config`；有 Key 就打 `/zen/go/v1/usage`，解析 `usage.rolling/weekly/monthly` 的 `percent`（0–100，不做「≤1 视为比例」的换算）和 `resetsAt`/`resetInSec`。不再请求控制台 `go/status`，也不再保留控制台用量解析器。
2. **余额是可选叠加**。Workspace ID 与 Cookie 两格都填时，并行请求 `billing/status`（`x-org-id` + Cookie）；`balanceMicroCents` 有效就追加一行 `{ type: "text", label: "Zen 余额", value: "$0.00", balance: true }`。余额请求失败、字段缺失或只有一格填了，都不影响额度快照——卡片照常出三行。
3. **统计抽屉改成 Overview / Logs 双页签，区间 24h / 7d / 30d**：
   - **Overview 走 API Key**：并行请求 `usage/summary`、`usage/cost-by-day`、`usage/models`（模型分页最多 10 页）。顶部三张指标卡（成本/请求/Tokens）、每日成本/Token 柱状图、按模型明细表。24h 用 `bucket=hour`，7d/30d 用 `day`。
   - **Logs 走控制台 Cookie**：`request-logs` 用滚动 `since`（24h/7d/30d）与 `limit=50`，只取 `category=inference`，首屏后按 `nextCursor` 追加“加载更多”。表格列为时间/状态/模型/耗时/Token/成本；`cost` 已是美元，直接按 4 位小数显示；Token 取输入+输出（推理已包含在输出内，不再重复相加），不把巨大的缓存读取混进去；状态列在 `outcome` 非 `succeeded` 时显示 “200 Failed” 这类红色标记。
   - **Logs 缺网页凭据时只影响 Logs 页签**：显示“请在配置中填写 Workspace ID 和 Cookie 才能查看请求日志”，Overview 仍可用。旧版 auth-only Cookie 仍可保存（额度不受影响），但余额/日志只认 `__Host-console_session`，缺它时这两个功能单独提示。旧 `/_server` RPC、月成本/历史记录 UI、`opencode-rpc-*` 解析器与 `opencode-response-mapping` 一并删除。
4. **余额与日志的失败静默降级**。401/403/网络错误不把整个快照标成错误；用户可用表单里的「测试」按钮验证余额凭据（探测 `billing/status`）。余额为 0 是有效数据，照常显示 `$0.00`。
5. **Cookie 输入按整段头处理**。表单与 Rust 使用同一份白名单（`auth`、`__Host-auth`、`__Host-console_session`），整段 Cookie 头只保留这三个键，其余分析/语言 Cookie 丢弃；含换行或非法值字符一律拒绝，挡住头注入。裸值里 `Fe26.2` 开头按 `auth=` 处理，其余（控制台会话 `st_…`）按 `__Host-console_session=` 处理。
6. **表单顺序与必填**：API Key 第一格且必填；Workspace ID 与 Cookie 是「成对选填」——只填其中一格会报另一格必填，两格都空则不查余额/日志。`instance-schema` 用对象级 `requiredWith` 规则实现，单格只负责格式校验；界面在兄弟槽填上后给本格补必填星号。
7. **诊断**：API Key 探测 `/zen/go/v1/usage`（403 单独报「未开通 Go 订阅」）；余额凭据探测 `/console/api/billing/status`（404 单独报「工作区找不到」）。

## Considered Options

- **只用 API Key**：最简单，但拿不到 Zen 余额与请求日志；用户明确要求展示余额，日志也是控制台的主要页签。
- **用控制台 Cookie 同时取额度和余额**：额度也能拿到，但 Cookie 会过期，且 API Key 已经能稳定取额度；把额度绑定到会过期的登录态没有必要。
- **用 `oc_sk_` 服务 Key 读余额或日志**：实测 `billing/status` 与 `request-logs` 都回 403；这两类数据只能靠控制台登录态。
- **保留旧 `/_server` 统计**：已迁移工作区不再有旧数据；控制台的新接口已经覆盖 Overview/Logs，继续维护两套解析器没有收益。
- **读本地 `opencode.db` 补历史**：CodexBar 的做法，但控制台已经提供按日/按模型/请求明细，本地库不再是必需；且跨平台路径与 SQLite 解析是新能力。
- **在 Logs 里显示用户邮箱**：请求明细只给 `serviceAccountID`/`userID`，推断服务账号到成员邮箱需要额外的成员接口；本次先展示时间/状态/模型/耗时/Token/成本六列，避免为一个展示列引入账号映射。
- **余额失败时把快照标成错误**：会让额度数据一起消失，违背「可选数据失败不影响主数据」的既有约定。

## Consequences

- **API Key 是额度与概览统计的唯一凭据**：没有 Key 的用户不能再靠 Cookie 出额度或概览；表单会把 Key 标成必填。
- **Zen 余额与请求日志依赖控制台登录态**：Cookie 过期时余额行和 Logs 页签不可用，额度与 Overview 不受影响；用户需要重新复制 `__Host-console_session` 才能恢复。
- **请求日志只保留 30 天**：控制台 `retentionDays` 是 30；24h/7d/30d 三个档位都在保留期内。日志分页用游标，不做页码跳转。
- **概览的 24h 可能为空**：控制台按本地当天/滚动窗口给桶，没有请求时 summary 与 daily 都是 0/空；界面显示空态而不是报错。
- **表单顺序反转**：API Key 第一格、网页凭据成对选填；空表单不再先要求两个网页字段。
- **旧统计代码已删除**：`opencode-rpc-parser`、`opencode-rpc-scanner`、`opencode-response-mapping`、旧 `UsageHistoryTable`/`useHistoryPages`/`cost-series` 及其测试不再存在。
- **测试夹具全部合成**：额度、余额（0 与正数）、summary/daily/models、request-logs（含缺失模型字段与游标）各有一组单测，不引入真实账号数据。
