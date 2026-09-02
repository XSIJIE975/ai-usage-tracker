# 智谱 GLM 凭据收敛为 Coding Plan Key 单通道

Status: accepted

部分取代 ADR-0009：保留 `/api/monitor/usage/quota/limit` 配额通道，移除按量付费余额通道（`query-customer-account-report` + 控制台登录 JWT）。

## Context

ADR-0009 落地后核实到：智谱官方 Claude Code 插件 glm-plan-usage（zai-org/zai-coding-plugins 开源）正是用 Coding Plan API Key（即 Claude Code 的 `ANTHROPIC_AUTH_TOKEN`）直接调用 `open.bigmodel.cn/api/monitor/usage/` 下的 `quota/limit`、`model-usage`、`tool-usage` 端点（裸 `Authorization` 头，Bearer 前缀实测亦可）。配额与用量统计的 API Key 通道因此获得官方同款用法背书；而余额通道只有控制台登录 JWT 可用，该 JWT 会过期，用户需频繁手动重提取，是设置体验的主要摩擦点。

## Decision

- 智谱供应商只用一枚凭据：Coding Plan Key（`bearer` 注入，providerId `glm`）。
- 移除 `glmWebToken` 凭据字段、`glm-web` providerId、余额解析与设置页 JWT 输入组；旧 vault 中残留的 `glmWebToken` 值不迁移不清理（合并式保存不触碰未提交的 key，且已无消费者）。
- 用量统计（`model-usage` / `tool-usage`，接统计页）同样走 API Key，不再预留网页态通道。
- `quota/limit` 解析增认国际站/旧版词汇 `TOKENS_LIMIT`（5 小时 Token 窗口）与 `TIME_LIMIT`（MCP 月度窗口）；`limits` 非空但全未识别时报「未识别的窗口类型」而非误报「未订阅」。

## Consequences

- 卡片不再展示按量付费余额：纯订阅用户零损失，混合付费用户需自行在控制台查看余额。
- 仅配置过 JWT（未配 Key）的旧用户升级后回到 `needs_config`，需补填 Coding Plan Key。
- JWT 相关设置指引、诊断函数、i18n 词条随之删除；「账户余额」词条保留（DeepSeek 共用）。
- 私有接口无兼容性承诺的处境不变；若未来官方开放用量/余额 API 应迁移（同 ADR-0009 结论语）。
