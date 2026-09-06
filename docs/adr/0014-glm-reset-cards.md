# 智谱 GLM 重置卡通道（用量重置额度）

Status: accepted

为智谱 GLM 供应商新增「重置卡」通道：读取官网「用量重置额度」（每张可立即恢复 5 小时/周窗口额度一次的赠送卡），与配额、余额并行拉取，同一枚 Coding Plan API Key 鉴权。

## Context

智谱近期向 Coding Plan 用户批量赠送「重置卡」（5 小时卡/周卡，独立有效期、过期作废，使用周卡会同步重置 5 小时窗口）。查看与使用此前只能上控制台网页。GitHub 无智谱重置卡的现成实现（codex-reset-card / CodexMeter 等均为 OpenAI Codex 生态），官方 glm-plan-usage 插件也未使用该接口。

用户于 2026-09-05 提供控制台抓包：`GET https://www.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL`，响应含 `fiveHourResets` / `weekResets`（每张卡 `recordId` / `expireTime`（服务端本地时间）/ `available`）、`lastFiveHourResetTime` / `lastWeekResetTime`；仅展示未使用或近 7 天已过期的记录。

## Decision

- 读取复用 Coding Plan Key（`bearer` 注入），与余额同属 biz 族私有接口（ADR-0013 同款模式）。
- 快照新增「可用重置卡」文本行，仅在可用张数 > 0 时渲染（无卡是常态，与 DeepSeek 充值/赠送行的按需展示一致）；明细（分组列表、每张卡有效期与状态）在统计抽屉 GLM 页签展示。
- 卡片状态推断：`available=true` → 可用；不可用且已过期 → 已过期；不可用但未过期 → 已使用。
- 不只做展示——「使用重置卡」一并接入：接口规约取自官网前端源码静态分析（2026-09-05，`claude-usage~glm-coding-ent-usage-stats` bundle）：`POST /api/biz/customer-package-reset/use`，JSON body `{ targetType: "PERSONAL", resetType: "FIVE_HOUR"|"WEEK", recordId, requestId }`，`requestId` 为客户端生成的幂等 UUID；成功判定 `code===200 && success===true`；`msg` 为「指定的重置次数不可用，请刷新后重试」时官网会自动刷新列表，本应用在 UI 提示刷新。使用属不可逆动作，UI 经二次确认弹窗；成功后同步刷新重置卡列表与实例快照。
- 写通道已于 2026-09-05 用户实测（curl 真实过期卡）：HTTP 400 + `code=400` + `msg`「指定的重置次数不可用，请刷新后重试」——与官网源码的特殊错误串逐字吻合，鉴权、参数路由与业务校验全部正确。业务错误可能携带非 200 的 HTTP 状态，实现优先解析业务 `msg` 再看 HTTP 状态。尚无 `success=true` 样本（当时无可用卡），成功路径待用户拿到可用卡后首次使用验证。

## Consequences

- 快照每轮刷新多一次请求（三路并行，失败静默降级为快照消息）。
- `expireTime` 为服务端本地时间无时区标记，按本地时间解析展示（与 tool-usage 的 `x_time` 同约定）。
- 私有接口无兼容性承诺；纯订阅账户或未收到赠送的账户返回空列表，属正常态不报错。
