# 通过平台网页端私有接口获取统计数据

Status: accepted

统计页需要「按天 × 模型 × 密钥」细分的用量与成本数据。两家平台的官方 API 都不提供这些数据：DeepSeek 官方 API 只开放推理与余额查询；OpenCode 没有公开统计接口（`/zen/go/v1/usage` 只覆盖订阅额度窗口）。因此统计页直接调用平台网页自己在用的私有接口：

- DeepSeek 开放平台网页接口（`usage/by_api_key/amount` 与 `/cost`），使用网页 localStorage 中的 UserToken 做 Bearer 认证。
- opencode.ai 的 SolidStart server function RPC（`POST /_server`，靠 `x-server-id` 请求头路由函数），复用已有的 auth Cookie。

## Considered Options

- 官方 API：数据维度不存在，无法满足统计页需求。
- 解析后台页面 SSR HTML：可行但脆弱，且 OpenCode usage 页的可见 DOM 实际是空态文案，数据藏在 SolidJS 水合脚本的对象字面量里；月度聚合还需要自行翻页拼接。
- 直接调用网页私有 JSON/RPC 接口：契约比 DOM 结构稳定，一次请求即可拿到整月聚合与密钥名列表。（选定）

## Consequences

- 私有接口没有兼容性承诺，平台改版即失效；尤其 `x-server-id` 是构建产物哈希，opencode.ai 重新部署后可能变化。应对：两个 id 作为常量集中管理，失效时向用户展示明确的错误提示。
- 所用凭据是网页登录态（UserToken、auth Cookie）而非长期密钥，会过期；过期后用户需要在设置中重新粘贴。
- 若未来任一平台提供官方统计 API，应迁移过去并废弃对应私有通道。
