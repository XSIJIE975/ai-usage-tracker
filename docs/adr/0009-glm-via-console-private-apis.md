# 智谱 GLM 用量：控制台私有接口（Coding Plan 配额 + 按量付费余额）

Status: accepted

新增智谱（GLM）供应商，在总览同时展示两种付费形态：Coding Plan 订阅配额（5 小时窗口 + 滚动 7 天窗口）与 API 按量付费余额。智谱官方文档没有任何公开的余额/用量查询 API，因此沿用 ADR-0006 的思路，直接调用控制台网页在用的私有接口（2026-09-01 实测验证）：

- Coding Plan 配额：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`，凭据为 Coding Plan Key（控制台 Coding Plan 页生成，长期有效），缺失时降用控制台登录 JWT（实测两者均可查询）。
- 按量付费余额：`GET https://www.bigmodel.cn/api/biz/account/query-customer-account-report`，凭据为控制台登录 JWT（浏览器 Cookie `bigmodel_token_production`，会过期）。

两种凭据对 `Authorization: Bearer <jwt>` 与裸值均可，实现统一走现有 `bearer` auth 变体，未新增头格式。

## Considered Options

- 官方 API：不存在，官方只提供网页查看入口（Coding Plan 用量页与控制台财务页）。
- 早期预判的 `/api/finance/balance` 等端点：实测带凭据后全部 404——无凭据探测返回的 `{code:1001}` 只说明路径在网关鉴权名单内，不能证明后端路由存在；整组端点已废弃。
- `/api/biz/account/query-customer-account-report`（余额）+ `/api/monitor/usage/quota/limit`（配额）：两个域各自的真实接口，响应结构实测固化（见 `GLM_PROVIDER_PLAN.md` 3.3/3.4），社区多个开源实现同源。（选定）

## Consequences

- 私有接口无兼容性承诺，智谱改版即失效；错误消息透出服务端 `code`/`msg` 便于定位。
- 控制台登录 JWT 会过期：余额查询失败时用户需重新粘贴；设置页获取指引已注明 Cookie 键名。
- 未订阅 Coding Plan 账户的 `quota/limit` 行为未实测（测试账号已订阅 Lite），降级逻辑按 `success=false` 或 `limits` 为空容错。
- `quota/limit` 的 `limits[]` 按 `unit` 区分窗口（实测 3=小时、6=周），未知 type/unit 一律忽略——智谱未来新增窗口类型时卡片自动降级为少显示一行而非报错。
- 快照主指标取「重置时间最晚的 progress 行」（周窗口），与告警 `glm:quota` 的语义一致。
- 若未来智谱提供官方用量/余额 API，应迁移过去并废弃对应私有通道。
