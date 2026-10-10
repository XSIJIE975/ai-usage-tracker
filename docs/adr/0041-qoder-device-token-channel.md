# Qoder 扫码登录：设备码换 token 通道，卡片等量、明细源缺失

Status: accepted

## Context

Qoder 此前只有一条凭据路：用户在网页登录后 F12 复制 `qoder_session_cookie` 的值贴进来（ADR-0030 §2 二次修订）。门槛高、会过期、且每次过期都要重做一遍同样的动作。WorkBuddy 已经趟出「扫码登录 → 后端换 token → token 通道取数」的形态（ADR-0034/0035），本次是把它接到 Qoder 上。

上游确实有可轮询的设备码流程，但它**不在任何公开文档里**。官方文档只写两条：`/login` 打开浏览器做 OAuth 并回调到本地端口，以及 `QODER_PERSONAL_ACCESS_TOKEN`（PAT）。网页登录页与它的 bundle 里 QR 字样全属于支付宝付款，登录侧没有扫码这回事。真正的可轮询通道来自 QoderWork/Qoder CLI 的 PKCE 设备码流，2026-10-09 由使用者真机扫码逐步实证：

- **发起不需要请求服务端**：本地生成 PKCE 对（`verifier` 32 字节 base64url、`challenge` 为其 SHA-256 的 base64url）、`nonce`（uuid v4）、`machine_id`（uuid v4，每次扫码新生成以做设备隔离），拼出 `https://qoder.com.cn/device/selectAccounts?challenge=&challenge_method=S256&nonce=&machine_id=&client_id=&redirect_uri=qoder-work-cn://`。`client_id=1c5e33e1-…` 实测可用（QoderWork CN prod 的那一个）。
- **轮询** `GET https://openapi.qoder.com.cn/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256`。**未授权时是 404 `{"errorCode":"NotFound"}`**——因为 nonce 是本地造的，服务端在用户打开授权页之前根本不认识它。所以那串 404 就是「等待扫码」本身。401/403 才是 client_id/参数被拒。
- **确认载荷**：`{id, token(dt-), user_id, code_challenge, nonce, expires_at, refresh_token(drt-), refresh_token_id, expires_in, refresh_token_expires_in, refresh_token_expires_at, created_at, updated_at}`。
- **续期** `POST /api/v1/deviceToken/refresh {refresh_token}` 回 `{device_token, refresh_token, token_type, expires_at, refresh_token_expires_at, created_at}`，两个 token **双双轮换**；`expires_at` 往后推 30 天，refresh 约 360 天。

通道边界是这次最要紧的一条，实测结论如下：

| 目的地 | Bearer 设备 token |
| --- | --- |
| `openapi.qoder.com.cn/api/v1/userinfo`、`/api/v2/quota/usage`、`/sash/api/v2/me/usage` | 200 |
| `openapi.qoder.com.cn/api/v1/me/userplan`、`/api/v1/me`、`…/usages/big_model_credits`（v1、v2） | 404 路由不存在 |
| `qoder.com.cn/api/v1/me/usages/big_model_credits`、`…/histories`、`/api/v1/me/userplan`、`/api/v1/me` | 401，**与完全不带凭据的响应逐字相同** |
| `openapi…/sash/api/v1/me/usages/big_model_credits/histories` | 400（路由在，但四种参数形状 + 两种 POST 都进不去） |

也就是说 **web 网关不读 Bearer，只认 `qoder_session_cookie`**；消耗明细（统计抽屉的数据源）在 token 侧没有可用通路。反过来，卡片上的额度数字这一族给得很足：`/sash/api/v2/me/usage` 回 `{displayMode, qoderUsage}`，`qoderUsage` 里 `userQuota`（订阅格）与 `addOnQuota`（加购/资源包格）各带 `total/used/remaining/percentage/unit`，另有 `isQuotaExceeded`、`upgradeUrl`、`detailUrl`，专属包在 `dedicatedResourcePackages[]` 里逐包下发（**只有这一族带 `expiresAt`**）。与真机截图对账：卡片「资源包积分 已用 28.9%」= `607/2100`，「余 1,493」= `addOnQuota.remaining`，两处**完全一致**。

第三方实现里有三处不能照抄，都是这次实测纠出来的：`expires_in` 回的是 `2591999998`（按秒算是 82 年，而 `expires_at` 明明是 30 天后），只能信绝对时刻；`user_id` **就在 poll 响应里**，逆向实现因为「`dt-` 不透明解不出 JWT」而多打一趟 `/userinfo`，我们不必；`/userinfo` 的响应带 `security_mobile` 与 `register_ip`，是 PII。另外 `Cosy-ClientType` 这个头族对 `me/usage` 是无效变量——取 10 / 取 5 / 不发，三份 body 逐字相同（它只对 `/sash/api/v1/me/campaigns` 是必要条件，本次不接活动面）。

## Decision

**扫码是 Qoder 的第二条通道，不是替代品；两通道能力不等，界面按通道收窄。**

1. **两站都开，各走各的 openapi**。中国站这一对（`client_id=1c5e33e1-…`、`redirect_uri=qoder-work-cn://`、`openapi.qoder.com.cn`）2026-10-09 真机扫码实证；国际站用 `client_id=732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`、`redirect_uri=qoder-app://`、`openapi.qoder.sh`，出自 yetone/magpie（其注释标 "verified against live captures"），端点存在性另经零凭据探测确认（`qoder.com/device/selectAccounts` 回 302 跳 `users/sign-in?oauth_callback=…directLogin=true`，与 CN 同形；`openapi.qoder.sh/api/v1/deviceToken/poll` 对未知 nonce 回同样的 404 `NotFound`）。**2026-10-10 国际站也已应用内扫码跑通**，两站的这一族凭据都算实证过。附带一条：同一个站可以有多个合法 client_id（`e883ade2-…` 是 Qoder 两家 CLI 共用的那一个，`1c5e33e1-…` 是 QoderWork CN 桌面端的），所以「某个 id 被拒」不等于这条流程不通。
2. **通道判据是凭据形态，不是新字段**：`accessToken` 槽非空即 token 通道，否则 `cookie` 槽非空即 Cookie 通道（`resolveQoderChannel`）。实例表不加 `loginMethod` 列，与 ADR-0035 完全同构。
3. **token 族五槽**：`accessToken` / `refreshToken` / `expiresAt` / `uid` / `nickname`。`expiresAt` **按上游 ISO 串原样存**（不做秒/毫秒换算，理由见上文的坏值）；`uid` 取 poll 的 `user_id`；`nickname` 从 `/userinfo` 的 `name` 取，**只取这一个字段**，`security_mobile`、`register_ip`、`third_party_identities` 一律不读不存。`machine_id` 不入库——它只出现在授权链接里，我们的调用不需要它。
4. **数据源用 `/sash/api/v2/me/usage`**，不用 `/api/v2/quota/usage`：两者内容同形（前者多套一层 `{displayMode, qoderUsage}`），但 `sash/me/usage` 是桌面客户端自己在用的那一个，形状更稳。请求只发 `Accept` + `Authorization: Bearer`，不发 Cosy 头族、不发 Origin/Referer/Bx-V（真机证明不需要）。
5. **解析口径三条**：① 汇总位本地相加（这一族响应没有 `total_quota`，而 ADR-0030 已对账证实它就是三个分容器的和，所以相加不是新造口径）；② 百分比一律本地按 `used/total` 算，不取上游两位舍入的 `percentage`（真机 `0.29` 对应 `28.9047%`）；③ **`expiresAt` 要挡 9999 哨兵**——真机订阅失效账号回的是 `253402214400000`（9999-12-31），它晚于当下，「只认未来」那条规则挡不住它，照挂就会在卡片上写「9999 年刷新」。哨兵判定只加在 token 通道（Cookie 通道的 `nextResetAt` 从未观察到这个值，不动它）。
6. **界面按通道收窄，缺的不画空位**：token 通道的卡片照常出「订阅积分 / 资源包积分 / 专属资源包」进度行与「余 N」明细行，但**不拼「· 到期日」后缀**（普通资源包在这一族响应里没有独立到期字段，专属包有就照画），并且**不渲染「查看统计」按钮**。收口方式是快照上的 `statsAvailable: false`（与智谱 `availableResetIds` 同族：本轮实际能力由取数方声明，界面不猜），失败快照同样带上，避免上一轮的按钮留在原地。
7. **续期不需要状态表**：本轮刷新前读 `expiresAt`，距失效不足 7 天就先续一次；续成功后 `expiresAt` 往后推 30 天，天然自带节流。401/403 再续一次并重试一次，仍失败就点名「重新扫码；或改用 Cookie 登录」，不静默换通道（ADR-0024）。WorkBuddy 需要 `workbuddy_states` 那张每日一刷的判据表，是因为它的 token 会被官方客户端互踢、必须按天重试；Qoder 没有这个失效模式，所以不引入第二套持久化时机（也不给实例加「自动续期」开关——它对这个通道没有可关的东西）。
8. **轮询的 pending 判定按通道各写一份**：WorkBuddy 是 HTTP 200 + 业务 `code≠0`，Qoder 是 HTTP 404。两者不能共用一个函数，且 404 绝不能映射成错误提示。
9. **会话键是我们自造的 uuid**，上游的 `nonce`/`verifier` 只存在进程内存的会话里（三家共用 `AppState::qr_logins` 一张表）。ADR-0035 当年用上游 state 当键，理由是「已在二维码里曝光，非新增敏感面」——自造 uuid 更省事，也不把上游标识透给前端。

## Considered Options

- **等官方 PAT 路**：PAT 是文档化的、可撤销，看着比私有设备码体面。但实测 PAT 打 web 四条端点与打 openapi 都是 401（openapi 回 `TOKEN_EXPIRE/token is not active`，说明它进的是另一套 token 体系），能力**不优于**设备 token，而门槛更高（要用户自己去集成页建令牌）。第三方项目声称「Cookie 401 就换 Bearer 重试同一个 web 端点」，我们没有复现出来，且它没给证据。
- **只做 Cookie、不做扫码**：代价是把「F12 找 Cookie」这个门槛永久留给用户，而 WorkBuddy 已经证明扫码路径的体验差距是决定性的。
- **扫码替代 Cookie 通道**：会丢掉逐包到期日与统计抽屉，等于让存量用户降级。互斥保留两条才对。
- **为 token 通道补一个明细端点**：`sash/…/histories` 回 400 说明路由在，但四种参数形状与两种 POST 都进不去，继续猜端点是在给不存在的运营画界面。
- **把 `displayMode === "enterprise"` 当成「企业版无数字」处理**：第三方实现的注释这么说，我们**没有企业号真机样本**，所以不猜形状——`qoderUsage` 缺失或非 `qoder` 形态一律按解析失败报错，并把 `displayMode` 写进错误详情，等真机出现再定口径。
- **给 Qoder 也加「token 自动续期」开关**：见 Decision 7，这个通道的续期不是按天动作，开关没有可关的语义。

## Consequences

- Qoder 实例从此有两种凭据来源，**同一供应商的卡片行数会因登录方式不同而不同**。这是用户可见的能力差异，选择接受它换来的是免 F12、30 天自动续、与 WorkBuddy 一致的体验。若日后拿到明细端点的可用通路，`statsAvailable` 就该由取数结果决定而不是由通道决定。
- **付费号未证**：真机取证时使用者账号已订阅失效（`userType: personal_standard`、`userQuota` 全零、`expiresAt` 是哨兵），所以「付费号上 `qoderUsage.expiresAt` 是否给真实刷新时刻」「`dedicatedResourcePackages` 会不会出现」两条都还没有样本。前者决定订阅行能不能带倒计时，后者决定专属包的到期日后缀会不会画出来。恒零容器不出行这条规则已经保证：没分配的格不会伪装成窗口。
- `ALLOWED_HOSTS` 的 qoder 条目从 2 个变 4 个（两站的 web 与 openapi）；`credential_label` 多五格；`provider_request` 多一条 `qoder_device` 分支；新增 `qoder_qr_start/poll/claim` 与 `qoder_token_refresh` 四个命令。
- 设备码流程依旧是非公开的，官方可以像 WorkBuddy 那样随时收紧。已知的收紧信号是 401/403，届时卡片会点名「重新扫码或改用 Cookie 登录」，而 Cookie 通道仍在原地兜底——这是保留两条通道的另一个理由。
- 前端把 WorkBuddy 的扫码面板抽成 `QrLoginPanel`（三家共用），旧宿主 `WorkbuddyQrLogin.tsx` 整块撤除；轮询节奏、命令名、槽位清单、两句文案、有没有续期开关这五件事收在 `QR_PROFILES` 一张表里。
