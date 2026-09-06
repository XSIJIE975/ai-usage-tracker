# 智谱 GLM 余额通道以 Coding Plan Key 复活

Status: accepted

部分取代 ADR-0010：恢复按量付费余额查询（`query-customer-account-report`），但凭据不用控制台登录 JWT，而是复用已有的 Coding Plan API Key——0010 移除余额通道的理由（「JWT 会过期，需频繁重提取」）不再成立。

## Context

ADR-0010 落地时，余额接口只有控制台登录 JWT 可用（当时未验证 API Key），JWT 易过期是设置体验的主要摩擦点，因此整条通道被移除。2026-09-04 重新核实：

- 用 Coding Plan Key 直调 `GET https://www.bigmodel.cn/api/biz/account/query-customer-account-report` 实测返回 `code: 200` 与完整明细（充值/赠送/累计消费/冻结/信用），与控制台财务页数字吻合。社区多个独立实现（GCMP、CodexBar、CodexMeter、plasmoid-ai-balance 等）同款用法：余额与配额共用一枚 API Key、同一请求构建器。
- 备选官方面端点 `open.bigmodel.cn/api/paas/v4/users/me/balance` 实测 404（尽管 riKKahub 等 App 出厂集成），不可依赖。

## Decision

- 余额查询复用 Coding Plan Key（`bearer` 注入，providerId `glm`），不新增凭据槽、不恢复 `glmWebToken`；配额与余额两个请求并行发出，余额失败静默降级为快照消息，不拖垮配额展示（ADR-0009 时代的行为）。
- 卡片以文本行展示「账户余额」（当前余额 `balance`，与控制台口径一致）；统计抽屉 GLM 页签增加充值/赠送/累计消费明细卡（信用余额仅开通时显示）。
- 新增实例级余额告警阈值 `balanceThreshold`（元，低于触发，仅 glm 使用），与现有配额百分比阈值（`threshold`）并存；告警协调器从「每实例一条规则」改为按 `实例:规则` 键维护多条规则的边沿状态。

## Consequences

- 私有接口无兼容性承诺的处境不变；余额与配额同生共死于同一枚 Key，Key 失效两者同时 `needs_config`。
- 纯订阅、从未充值账户的余额接口行为未实测（实测账号有现金余额）；解析不出金额时余额行直接不渲染。
- 快照文本行（账户余额）会进快照历史，成为可回放的时间序列。
- 旧库升级由打开数据库时的 `ALTER TABLE ADD COLUMN balance_threshold` 补列，存量实例阈值默认为空（不告警）。
