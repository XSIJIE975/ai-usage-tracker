# 小米 MiMo 扫码登录：存 passToken，serviceToken 每轮现铸

Status: accepted

## Context

MiMo 首版只有一条凭据路：用户从浏览器里把 `api-platform_serviceToken` 与 `userId` 两个 Cookie 的值抠出来贴进来（ADR-0038）。WorkBuddy 与 Qoder 之后，扫码登录已经是这个工具的第二条常规接入口，但 MiMo 的情况和它们都不一样——**它的取数凭据是一个会话级 Cookie，不是一种可以「换发」的 token**。

小米账号体系原生支持扫码登录（微信网页版同款模型），2026-10-09 零凭据即证：

- `GET https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&_json=true` 裸探回 `code:70016`「登录验证失败」属正常态，`qs`/`_sign`/`callback`/`serviceParam` 照发。
- `GET …/longPolling/loginUrl?…&sid=api-platform&_qrsize=240` 回 **`code:0`** 与 `{loginUrl, qr, qrTips, lp, timeout:300, …}`——**MiMo 控制台那个 `sid` 能签出扫码票据**。`qr` 是小米自己出的 PNG（200 `image/png`，约 5.8KB），`lp` 是**挂起式**长轮询（上游一直挂着直到确认或票据自身到期），`timeout` 300 秒。
- 票据主机每次轮转：`ak.account.xiaomi.com` / `c3.account.xiaomi.com` / `ak.lp.account.xiaomi.com`。
- **授权不必有小米手机**：`loginUrl` 直接 302 到 `account.xiaomi.com/pass/serviceLogin?…&sid=passport&followup=<loginUrl>`，任意浏览器登小米账号（验证码或密码）即完成授权。
- `lp` 的成功载荷与 `serviceLoginAuth2` 同构：`{passToken(367), userId, cUserId, ssecurity, psecurity, location, code:0, desc:"成功", pwd, child, securityStatus, …}`。

拿到 `passToken` 之后怎么换出服务侧 Cookie，是这次唯一难住人的环节，前两轮都栽在这里：跟着票据载荷里那个 `location`（`platform.xiaomimimo.com/sts?d=…&ticket=0&auth=…`）打过去，回的是 **401 空响应体**，`api-platform_serviceToken` 一个都落不下来。根因是**我们自己拼了 callback**：`serviceLogin` 的 callback 若不带服务方签的 `sign`，passport 给出的就是「未登录态形状」的 location，服务方不认。第三轮按 `yetone/magpie` 的做法改成全程跟随服务方给出的 URL，一次跑通：

1. **无凭据**请求一次 `GET https://platform.xiaomimimo.com/api/v1/balance`，取它 401 回体**自述**的 `loginUrl`（内含服务方现签的 `sign` 与 `followup`）；
2. 带着 `passToken`/`userId`/`deviceId` 走这条 `serviceLogin?callback=…sign…`——已登录态它回的是 **200 JSON**，下一跳在响应体的 `location` 字段里（**不是 302 头**，只跟 `Location` 头会在第一跳就停）；
3. 跟到 `platform.xiaomimimo.com/sts`，它在 **307** 上 `Set-Cookie: api-platform_serviceToken=…`，同批还有 `userId@xiaomimimo.com`、`api-platform_slh`、`api-platform_ph`。

铸出来的 Cookie 有两个性质决定了这套设计：`api-platform_serviceToken` 的 Set-Cookie **既无 `Max-Age` 也无 `Expires`**，是会话级；而 `passToken` 是 `Max-Age 2592000`（30 天）。同一轮还顺手把 ADR-0038 挂着的那条未决判掉了：**只发 `serviceToken` → 401，只发 `userId` → 401，两格同发 → 三个端点全 200**，真机回体与既有未订阅 fixture 逐字一致。

## Decision

**vault 只存 passToken 族，serviceToken 不落盘；每轮刷新由 Rust 现铸。**

1. **扫码通道三槽**：`passToken` / `userId` / `deviceId`。`deviceId` 是我们发起扫码时自造的 `pc_<32hex>`，它被绑进票据与 sts 链（`location` 里的 `d=` 参数就是它），**铸票时必须与登录时同一个**，所以必须入库。`serviceToken` 不入库——它是会话 Cookie，存下来只会制造「以为还能用」的过期状态。
2. **通道判据仍是凭据形态**：`passToken` 非空即扫码通道，否则 `serviceToken` + `userId` 齐备走 Cookie 通道（`resolveMimoChannel`）。与 ADR-0035/0041 同构，实例表不加字段。
3. **新 `mimo_pass` 鉴权分支**：`provider_request` 在这一支里先跑上面那三步铸票，再拼出与 Cookie 通道**完全相同**的两条 Cookie。因此三个只读端点的取数、解析、出行、阈值、告警全部零改动——这是选这条设计的主要理由：MiMo 的扫码不产生第二种数据形状。
   铸票用一个**关掉自动重定向的专用客户端**：共享客户端会跟随跳转，而服务方 sts 的 307 指向的 followup 写的是 `http://platform.xiaomimimo.com/...`，跟下去就撞上客户端的 `https_only(true)`，症状是 `builder error: URL scheme is not allowed`（真机第一次点保存就是这个）。而我们要的 `serviceToken` 恰好落在那个 307 自己的 Set-Cookie 上，跟到 followup 纯属多余。reqwest 0.12 里重定向策略只能设在 `ClientBuilder` 上（`RequestBuilder` 没有这个开关，也没有 `redirect` feature 可关），所以是第二个客户端而不是第二个请求配置。
4. **上游给的每一个地址都要过目的地面校验，且失败时不回显它**：`loginUrl`、`location`、以及扫码会话里那条 `lp` 长轮询地址都来自上游响应，不是前端常量——存进会话或发出去之前都过 `instances::validate_request_url("mimo", …)`，校验的是**真正发出去的那条串**（`_json=true` 拼完再校验，不校验拼接前的原料）。这些地址里带着服务方现签的 `sign`/`auth`/`ticket`，所以目的地面校验失败时**只报 scheme/host**，不内插整条 URL（否则会写进界面与错误快照）。
5. **铸出来的 serviceToken 是 quoted-string，原样回发**：小米落这个 Cookie 时值带首尾双引号（同批的 `slh`/`ph` 也一样，`deviceId` 不带），而 cookie-value 字符集白名单按 RFC 6265 排除 `"`。所以取值抽成纯函数 `pick_mimo_service_token`：**剥引号只用于校验内部字符集，返回与拼头都用上游原样**——带引号回发是实测 200 的那一种，剥引号发送没验证过就不擅自改。同批的畸形候选（别的 Cookie 名、空值、含控制符）一并由这条函数拒掉。
6. **白名单为小米域开子域放行**：`ALLOWED_HOSTS` 的 mimo 条目加 `account.xiaomi.com` 与 `*.account.xiaomi.com`。表项前缀 `*.` 表示「放行该域本身与它**点边界**下的子域」，规则在 Rust 的 `host_allowed` 与前端守卫测试 `hostAllowed` 里各写一份、互相咬住（`allowed-hosts.test.ts` 现在两处都用这个谓词）。点边界是必须的：少了它 `notaccount.xiaomi.com` 就会被误放；而 `account.xiaomi.com.evil.com` 不以该域结尾，两种写法都进不来。这条是这张表第一次出现非精确匹配的条目，所以配了一条独立的 Rust 测试。
7. **轮询是挂起式，不是定时式**：`mimo_qr_poll` 一次调用挂着上游的 `lp` 最多 75 秒，返回 pending 后前端**立刻**续下一次（`pollIntervalMs: 0`）。共用面板的轮询因此从 `setInterval` 改成「返回后再排一次」——固定间隔会让上一轮没返回就并发打第二次。会话 TTL 取上游的 `timeout`（300 秒）加 30 秒余量，不写死。
8. **界面与文案按通道区分出路**：needs_config 同时给出两种出路（「扫码登录，或填写 {slots}」）；失效话术按通道给——扫码通道说「重新扫码（一次授权约可续 30 天）」，Cookie 通道保持原文说重贴两格，不因为多了扫码就把老用户指到另一条路。
9. **没有续期动作，也就没有续期开关**：`passToken` 的 30 天到期就是它到期，届时铸票会失败、卡片点名重扫。不引入 `workbuddy_states` 那样的判据表，也不给实例加开关。

## Considered Options

- **把铸出来的 `serviceToken` 缓存起来复用**：能省掉每轮两次请求，但要引入一个内存表或第二个持久化时机，而它的失效语义（会话级、无下发有效期）我们完全不知道。MiMo 通常只有一个实例，每轮多两次 GET 的代价低于这个状态带来的解释成本。日后若真嫌吵，再按「缓存 + 明确失效条件」补。
- **把 `passToken` 直接当 Cookie 发**：真机试过，服务方不认（401 并自述登录入口）。它只在 passport 域有意义。
- **手拼 `callback=platform.xiaomimimo.com/sts` 走 passport**：前两轮的做法，回 401 空体。sign 必须由服务方现签，不能自造。
- **热链小米给的 `qr` PNG**：上游确实直接给一张 `image/png`，比本地编码省事。但发布版 CSP 下前端不发外部请求（一切外联都在 Rust 侧，ADR-0034 的既有约束），要为一张图开 img-src 例外不值；而 `loginUrl` 本身就是可扫的链接，本地编码与另两家同一条路径。故三家共用「本地 `qrcode-generator` 编码」这一份实现。
- **顺手接活动/签到面**：`/sash/api/v1/me/campaigns` 与 MiMo 无关，本条不适用；MiMo 侧没有发现任何动作接口，继续保持只读。
- **把 passToken 也登记成「Cookie 登录」的第三格让用户手贴**：用户从 F12 里根本找不到它（它在 `.account.xiaomi.com`，不在控制台域），贴了也没用。它只属于扫码通道。

## Consequences

- MiMo 实例有两种凭据来源，但**两种通道的数据形状与界面完全一致**——这与 Qoder 那边「按通道收窄界面」不同，不需要 `statsAvailable` 之类的通道能力声明。
- ADR-0038 的未决「只带 serviceToken 能否过网关」就此收口：**不能，两格必需**，`userId` 那格砍不掉。该 ADR 里「若真机证实单格可过就砍第二格」这条不再适用。
- 一次扫码约可撑 30 天，之后必须重扫（没有 refresh 机制可退）。这意味着 MiMo 的「免维护期」短于 Qoder（30 天 + 360 天 refresh 链）与 WorkBuddy（每日一刷），到期表现为卡片点名重扫，不是静默失效。
- 每轮刷新多两次到 `account.xiaomi.com` 与 `platform.xiaomimimo.com` 的匿名/带凭据请求。若上游对 sts 链做频控，症状会是铸票失败 → 卡片报「重新扫码」，与 passToken 真过期不可区分——这是这条设计的已知代价。
- **未证：同账号并发铸票会不会互顶**。取数用的 `serviceToken` 是每次现铸的临时票据，一轮刷新里三个端点各铸一次。从代码侧看不出这张票据是「自带签名的条」（服务端不记账，铸多少次互不影响）还是「服务端记在案的会话」（后铸的可能顶掉先铸的）。若是后者，症状是 MiMo 卡片偶发 401、下一轮自愈。2026-10-10 应用内多轮刷新未观察到该症状，暂不改设计（加铸票缓存只把三次并成一次，掩盖现象而非判明成因）；日后若出现偶发 401，先按这条排查。
- `ALLOWED_HOSTS` 的 mimo 条目从 1 个变 3 个，并首次引入 `*.` 子域语义；`credential_label` 多两格（`passToken`、`deviceId`）；`provider_request` 多一条 `mimo_pass` 分支；新增 `mimo_qr_start/poll/claim` 三个命令。
- 依赖的是小米账号登录链与私有控制台接口，官方改版需跟随维护。已知的稳定信号：`sid=api-platform` 可签票据、`serviceLogin` 已登录态回 200 JSON 而非 302、`/sts` 在 307 上落 Cookie——三条任一变化都会让铸票失败并在卡片上可见。
