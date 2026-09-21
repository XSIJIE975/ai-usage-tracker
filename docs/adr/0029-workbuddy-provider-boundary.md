# WorkBuddy 接入边界：手动 Cookie 与动作白名单

Status: accepted

## Context

第四个供应商腾讯 WorkBuddy（与 CodeBuddy 同一账号积分体系）没有任何个人版官方 API：积分余额、套餐明细、签到都在 workbuddy.cn 的**非公开 web 接口**上（`billing/meter/get-user-resource`、`billing/meter/daily-checkin`、`activity/growth/streak` 等），凭登录态 JWT（`Authorization: Bearer`，约 60 天有效）调用。鉴权与自动化的取舍：

- **token 获取有三条路**：手动粘贴；OAuth 授权流（`/v2/plugin/auth/state` 拿授权 URL → 浏览器登录 → 轮询换 token，refresh token 续期）；读官方 CodeBuddy IDE 扩展的本地存储（VS Code `state.vscdb` + Electron safeStorage 解密）。
- **刷新会互相踢**：社区实现（wwenc6621/CodeBuddy-Usage 的 `auth.ts`）明确注释「绝不主动调用 refreshToken——那会与 CodeBuddy 自身的刷新互相轮换」；用户同时用官方客户端时，第三方主动刷新会周期性把对方登下线。
- **动作接口有风险梯度**：签到幂等（当日已签返回业务码 10001/14001，不视为失败）；喵喵旅行是状态机（派出→等待→领取）；补签卡是**消耗性写操作**；礼包/补偿是领取类写操作。聊天补全反代则触碰 CLI 三段式 UA 指纹门禁（400 code 12403）与真正的合规红线。

本工具的定位是「监控 + 提醒」，供应商架构已具备：凭据槽位 + 凭据库（OS 钥匙串加密）、`provider_request`（POST + Bearer 注入）、快照/告警/通知体系；DeepSeek 已有「网页登录态手动粘贴」的先例（UserToken 槽 + F12 帮助文案 + 诊断按钮）。

## Decision

**接入边界四条：手动凭据、动作白名单、签到跟随刷新、只碰 web 只读族。**

1. **凭据手动粘贴（网页 Cookie，而非 JWT）**：凭据槽 `cookie`，用户从浏览器网络面板复制整串 Cookie。**这条推翻了最初的设计**：原计划按社区实现走「Bearer JWT 粘贴」，但 2026-09-21 用户抓包证实 workbuddy.cn 网页端**不用 Bearer**——身份是 `session`/`session_2` 服务端会话 Cookie；Bearer JWT 只存在于官方 IDE 扩展/CLI 的 OAuth 链路，网页用户拿不到。故凭据改为网页 Cookie（`auth: "cookie_header"` 通道，vault 按槽位读取、原样作 Cookie 头）。不存 refresh token、不做 OAuth/自动续期。失效（401/403 或登录页 HTML）表现为快照 `error` 提示重贴，重贴即恢复。Cookie 会话的有效期由服务端掌控（未知、可能远短于 JWT 的 60 天），过期重贴是常态。
2. **动作白名单**：只读（余额/套餐 `get-user-resource`、连登 `streak`）+ 幂等签到（`daily-checkin`，10001/14001 视为已签）+ **喵喵旅行的领奖与出发**（`buddy/travel/claim` 带 record_id、`buddy/travel/depart` 固定 location_id 1——1~4 收益/时长区间相同，workbuddy2api 实测；领奖响应 credit/reward_credit 两字段都容）。领奖与出发是**非消耗**写操作（积分只进不出），领奖按行程 depart_at 判重、出发由服务端 `daily_limit_reached` 节流（按 CST 自然日重置的一日一出），2026-09-21 修订纳入；补签卡、礼包领取仍**不做**——消耗性/领取类决策出错会伤害真实积分资产，违背工具定位。**统计接口（2026-09-21 二次修订，全部只读）**：消耗明细 `get-user-request-usage`（分页拉全后前端聚合，`input` 全文不取、只用截断版 `inputTrunc`）、汇总 `get-user-resource-summary`（IsPaidUser + 按 PackageCode 聚合，端点已验证、暂无 UI）、购买积分 `get-user-resource-paid-packages`（免费账号为空，仅记录端点）。余额端点取通用 `get-user-resource`（2026-09-21 对照审查修正：两个社区实现同款端点；网页端在用的同族 `-free-packages` 顾名思义只覆盖免费包，付费套餐未必在响应内）。请求体的 `ProductCode`/`Status:[0,3]`/`OnlyValidPeriod` 与两参考实现对齐（`Status:[0]` 会漏掉状态 3 的周期进行中套餐；不过滤已过期套餐会虚增余量、阈值告警失明），`PackageCodes` 保留网页抓包的目录码快照（CodeBuddy-Usage 同样随请求附带；workbuddy2api 证明码可省、仅凭 ProductCode，在本主机去码未单独验证——官方扩充目录需跟随维护，去码是备选）。
3. **签到挂在刷新链**：每实例每天第一次刷新（自动或手动均计）先签到后取数（到账积分当轮可见），内存记「今日已签」标记（重启丢失只多发一次幂等请求）；成功发系统通知，已签静默；不设独立开关——是否刷新由既有开关决定，签到无独立行为。
4. **只模拟 web 客户端特征**：Edge UA + `x-client-platform: web` + 对应 referer + Cookie 会话，仅调 billing/activity 族接口；**不做聊天补全反代**，不触碰 CLI 指纹门禁。UA 必须带 `Edg/` 后缀——EdgeOne WAF 对非 Edge UA 一律按未授权 401 处理（2026-09-21 同 Cookie 二分实测，与 Cookie 有效性无关）。
5. **realm 预留**：apiBase 抽为单一常量位，首发仅国区（workbuddy.cn）；国际站（workbuddy.ai）是另一套登录域，Cookie 不互通，后置接入时复用同一 provider 仅换域。

## Considered Options

- **Bearer JWT 粘贴（最初设计，已推翻）**：2026-09-21 用户实测抓包显示网页端无 Authorization 头、纯 Cookie 会话；JWT 只在官方 IDE 扩展/CLI 的 OAuth 链路里，网页用户无从获取。社区工具（CodeBuddy-Usage）能拿 JWT 是因为它读官方 IDE 扩展的加密存储——那条路的门槛见下条。
- **OAuth 授权流 + 自动续期**：体验最好（用户无感），但要新做「授权型实例」一整条链路（打开系统浏览器、state 轮询、refresh token 安全存储与调度），且与官方客户端 token 轮换冲突是结构性问题——除非用户弃用官方客户端，否则互相踢下线无解。
- **读官方 IDE 扩展本地存储**（CodeBuddy-Usage 的主路径，JWT 来源）：对用户最省事，但要适配整个编辑器矩阵（Code/Trae/Cursor/Kiro/Qoder…）+ Electron safeStorage 解密（Windows DPAPI、macOS 钥匙串），侵入性强、平台碎片化，Tauri 里维护成本不成比例。
- **每次刷新都签到 / 独立每日定时器**：30 分钟一刷即一天 48 次打活动接口，无谓的风控暴露；独立定时器与刷新链分裂，多一套生命周期要维护。
- **签到加实例级开关**：行为已完全由刷新开关决定，再加设置项冗余；代价是无法「只关签到不关刷新」——若将来有此诉求再补。
- **自动化旅行/补签/礼包**：收益是额外积分，代价是状态机 + 消耗决策 + 每日上限等长尾细节，出错直接损失用户资产。2026-09-21 修订：旅行拆开评估——领奖（收已到账的积分）与出发（不消耗任何资产）安全，纳入白名单；补签卡（消耗补签道具）与礼包（领取类、语义不明）维持不做。
- **旅行领奖通知判重复用 alert_states / 仅内存**：落库快照随重启 reevaluate 重放 travel 字段，纯内存必重报；alert_states 的未知规则键会被协调器重置（与签到同一结论）。故与签到同构，新增 workbuddy_travel_claims 单行事实源，判重键用行程 depart_at 而非日期——一天可有多趟旅行。

## Consequences

- 用户在 Cookie 会话失效时需重新复制一次 Cookie（服务端会话有效期未知，可能远短于最初假设的 60 天）；期间该实例快照持续报错直到重贴——错误可见（ADR-0024），不会静默用旧数据。
- 依赖非公开接口，腾讯改版需跟随维护；本工具只碰 billing/activity 族且不模拟 CLI，与聊天族门禁隔离，改版波及面有限。
- 积分聚合口径为**累计已用**（全部有效套餐计入分母，含已耗尽的），与 workbuddy2api 的 ResourceSummary 一致；CodeBuddy-Usage 只把有余量的套餐计入分母（剩余可用口径），两者在「作废/耗尽积分多」的账号上告警时机不同。本工具选前者——已用百分比如实反映历史消耗，托盘环与阈值告警同源不歧义；切换口径只需改 `parseResourceLines` 一处聚合。
- 签到无法单独关闭；不想要签到的用户只能停用该实例的自动刷新并避免手动刷新。
- WorkBuddy 无调用级用量接口，统计页无新增页面，卡片即全部展示面；积分到期提醒（数据现成）列为二期候选，需新的告警类型。
- 该供应商的第 4 个 `ProviderKind`（`workbuddy`）进入实例/快照/诊断的类型判别集合，后续新增供应商沿用同一扩展位。
