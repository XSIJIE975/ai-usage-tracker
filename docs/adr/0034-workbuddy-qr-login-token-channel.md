# WorkBuddy 扫码登录:token 通道与 Cookie 通道并存

Status: accepted

## Context

ADR-0029 四修后,WorkBuddy 凭据定型为三格 Cookie（session / session_2 / userAgent）。代价写在它自己的 Consequences 里:录入要 F12 抄三个同源值,服务端会话有效期未知,重填是常态;UA 与登录时逐字节一致的要求让"换个浏览器就失效"成为日常。

2026-09-24 对参考实现 linguo2625469/workbuddy2api-panel 做了完整调研（克隆通读 + 独立复核,25 条关键事实 24 条在源码中逐条确认,报告存于当次 workflow 产物）,与本项目相关的核心事实:

- **其登录是 OAuth 设备授权,不是扫码**:三端点链 `POST /v2/plugin/auth/state?platform=CLI`（UA `CLI/2.63.2 CodeBuddy/2.63.2`、Origin/Referer www.codebuddy.cn,返回 `{state, authUrl}`,state 15 分钟 TTL）→ 浏览器打开 authUrl 完成登录 → `GET /v2/plugin/auth/token?state=` 轮询换双 token（pending 时 HTTP 200 但业务 code≠0）→ `GET /v2/plugin/login/account?state=` 带 Bearer 取 uid / enterpriseId / nickname。全仓库唯一的二维码代码是开学季券码展示,与登录无关。
- **站点切换**:global 账号把 base 换成 www.workbuddy.ai,登录端点两站均有证据。
- **billing 族有在线背书**:签到 daily-checkin、余额 get-user-resource 以 Bearer + `WorkBuddy/<ver>` 单段 UA 调 www.codebuddy.cn,是参考项目在线运行的路径;growth 族（旅行/连登）属同族推定;`get-user-request-usage`（统计）在 Bearer 通道无任何证据。
- **刷新机制**:`POST /v2/plugin/auth/token/refresh` 以 `X-Refresh-Token` 头族调用,accessToken 与 refreshToken 恒一起轮换（rotation）,token 名义有效期约 60 天（expiresIn=5184000）。

ADR-0029 当初拒绝 OAuth 流的两条理由:与官方客户端 token 轮换互踢是结构性问题;要新做整条链路。其中互踢的前提——本项目拿到的 OAuth 授权会话与用户官方客户端的登录态**共享同一 session 族**——没有被任何一方真机证实（社区注释描述的是寄生官方客户端 token 的场景,参考项目则是独立授权、天天主动轮换的网关场景,两者都不能直接推出单用户工具会被互踢）。用户判断授权会话不共享、决定做自动续期,本 ADR 把互踢列为待验证假设并在 UI 保留警示,设计上不赌它成立与否。

## Decision

**八条,经 grilling 会话逐条确认（2026-09-26）:**

1. **完整第二取数通道,与 Cookie 并存**:扫码 → accessToken/refreshToken 等五槽（`accessToken` / `refreshToken` / `expiresAt` / `uid` / `nickname`,uid 是功能性的——billing 请求头要带 `X-User-Id`）落凭据库 → Rust 侧以 Bearer 调 copilot.tencent.com / codebuddy.cn 接口族取数。Cookie 三格原样保留为退路。半成品方案（扫码只拿 token 不接取数）被否:web 接口不吃 Bearer,token 不配上取数链没有消费方。
2. **功能面分波开放,按证据等级**:第一波余额/套餐/签到（billing 族,有参考背书）;第二波喵喵旅行/连登（growth 族,同族推定）;第三波统计抽屉（usage 端点 Bearer 通道无直接证据）。**二批修订（2026-09-26 晚,扫码通道真机跑通后）**:第二三波随功能本体一并接入——用户要求功能面完整,验证改为「上线后真机验」而非「验过才上」:旅行/连登按参考 travel.go/streak.go 路径常量对表（与 Cookie 通道逐字相同,已在 copilot.tencent.com + BillingHeaders 组合上在线运行）,growth 头族照抄参考 BillingHeaders（**不带 Origin/Referer**,凭据衍生头含企业号的 X-Enterprise-Id/X-Tenant-Id 由 Rust 注入）;usage 按 billing 同族路径形态接入（codebuddy.cn /v2 前缀,国际站无前缀双试）。判据与回退:统计页错误文案可见（ADR-0024）;旅行/连登是辅助源,失败静默不出行——真机若不出行即视为该族未通,回来调整头族或下线。
3. **两站都支持扫码**:登录端点按实例 site 切 base（中国站 copilot.tencent.com / 国际站 www.workbuddy.ai）,取数沿用分波原则,不为站点单独立规则;国际站功能面本来就小（无签到/旅行,按站能力表已门控）。
4. **通道选择用隐式优先级,不新增状态字段**:accessToken 槽非空即走 token 通道,空则校验三格走 Cookie 通道;表单明示「当前生效:扫码登录 / Cookie 手填」,清空 token 槽即显式回落。
5. **自动续期（修订 ADR-0029 的"不做自动续期"）**:每日一刷挂在既有「每天第一次刷新」链（签到同位置,不新造定时器）+ 遇 401/12153 即时刷一次并重试;刷新失败保留旧 token 下轮再试（参考项目同款）。实例级开关**默认开**,文案保留一句「同时使用官方客户端可能互踢」警示。不照抄参考项目的 22 点定时器与账号池禁号计数——单号工具用不上,且独立定时器与刷新链分裂正是 ADR-0029 拒绝过的架构。
6. **失效行为**:401/12153 先即时刷新救一次;救不活 → 错误快照 + 指引「重新扫码,或清空 accessToken 改用 Cookie 三格」。不静默回落 Cookie（ADR-0024 错误必须可见,静默切换通道用户无从知道扫码态已坏）。
7. **扫码产物展示**:表单显示「扫码账号: 昵称 · 有效期至 X」摘要（Rust 返回,凭据本体不出库）;不自动改实例备注——命名权留给用户,卡片显示规则不动。
8. **spike 四关闸门**:动工前真机走通 ①拿 authUrl ②手机完成登录 ③轮询换到 token ④token 调通任一 billing 端点;全过才编码,任一关不过回来调整方案（如手机端不可用 → 「复制链接 + 任意浏览器打开」升为主形态）。

**实现约束（由架构既定事实决定,非新决策）:**

- 发布版 CSP 禁止前端外联（ADR-0026）,state 签发、轮询、取数、续期全部在 Rust 侧;前端只负责渲染二维码（本地渲染库编码 authUrl）与定时 invoke 查询扫码状态（3 秒节奏,参考项目同款;弹层关闭即停,无后台任务生命周期）。
- 凭据目的地白名单（ADR-0032）:workbuddy 新增登记 `copilot.tencent.com`（授权三端点 + growth 族）与 `www.codebuddy.cn`（billing 族）;前后端两份清单由 allowed-hosts.test.ts 把守的机制不变。
- 请求头族按参考项目已证组合落 Rust 常量:授权端点 `CLI/2.63.2 CodeBuddy/2.63.2` + site 对应 Origin/Referer;billing 族 `WorkBuddy/5.5.4` 单段 UA + `X-CodeBuddy-Request: 1` + `X-User-Id` 等。UA 版本号各提成一处处改的常量——官方升版漂移是 ADR-0029 已付过学费的同构问题。
- i18n 与诊断码按既有约定（中文即 key、en.ts 同步、诊断码四处同步）。
- 存量 Cookie 用户零感知:不迁移、不引导。

## Considered Options

- **替换 Cookie 通道（扫码为唯一方式）**:存量用户全员重扫;互踢/风控一旦翻车没有退路;统计页 Bearer 通道无证据,功能面可能反而缩水。否。
- **半成品扫码（只拿 token 展示/手动贴,不接取数）**:web 接口不吃 Bearer,token 在本工具内没有任何消费方,等于做了个不能用的功能。否。
- **token 通道永久阉割（只做已证端点）**:扫码用户的卡片功能面比 Cookie 用户小,两通道不对等,用户困惑「为什么扫了码反而少了功能」。否,以分波开放替代。
- **只开中国站**:两站登录端点都有 verified 证据,实现差异仅 base 常量;单站限制只省下一小块待验证面,换来两站行为不一致。否。
- **显式通道字段（实例存 authChannel）**:多一份持久状态,「选了 Cookie 但 token 还在」「选了 oauth 但 token 已失效」等组合都要定义行为与迁移。隐式优先级 + 表单明示当前生效即可。
- **互斥单通道（扫码即清三格、填三格即清 token）**:退路丢失——互踢器不下 token 时想临时用 Cookie 得重填三格。与「Cookie 保留为退路」的根本决策相抵。
- **token 失效自动回落 Cookie**:通道静默切换违背 ADR-0024;Cookie 也过期时两层错误叠加难解释。否。
- **被动懒刷新（只在 401 时刷）**:平时不碰 refresh token,60 天不用即双双过期,长期挂机实例在 60 天边界静默死;且永远是轮换战的被动方。以每日一刷替代——共享 session 时保轮换主动权,不共享时也无害,是两种互踢假设下的稳态。
- **照抄参考项目三层续期（请求时触发 + 22 点定时 keepalive + 12153 连续三次禁号计数）**:禁号计数是账号池逻辑,单号工具无意义;独立定时器与刷新链分裂正是 ADR-0029 在签到上拒绝过的架构。取其思想（保持轮换新鲜）挂进既有刷新链。
- **不做续期（ADR-0029 原决策）**:被用户决策推翻——授权会话可能不共享,互踢属待验证假设;即便共享,每日一刷也是稳态。本 ADR 即对该决策的显式修订。

## Consequences

- **正面**:录入从「F12 抄三值」变为「扫码」;token 60 天 + 自动续期,凭据维护频率大降;Cookie 通道仍在,失败有退路。
- **待真机验证（全部未经上游文档证实）**:①授权会话与官方客户端登录态是否共享（互踢双向行为）——UI 警示与实例开关是兜底;②authUrl 在手机端的形态;③国际站 billing/usage 路径形态（参考项目对 global 是无 /v2 与带 /v2 双试）;⑤token 有效期 60 天为参考项目观察值。**已验证**:growth 族（旅行状态机+连登）与 usage 统计端点 2026-09-26 用户真机确认「跟之前的功能一样」——Bearer 通道功能面与 Cookie 通道对齐完成;usage 无前缀路径接受 Bearer（探测记录见下）。

  **spike 实测记录（2026-09-26,四关全过,闸门放行）**:①授权三端点与 billing 端点（get-user-resource,请求体沿用 Cookie 通道骨架 `ProductCode/Status[0,3]/OnlyValidPeriod`,头族 `Authorization Bearer + X-CodeBuddy-Request:1 + Accept-Language + X-User-Id + X-Domain: www.codebuddy.cn + UA WorkBuddy/5.5.4 + codebuddy.cn Origin/Referer`）真机全部调通;②authUrl 浏览器打开可完成登录——关键实测:**链接必须整段完整**,尾部参数被截断时上游页报「登录链接不完整」（从终端 JSON 手抄必断,程序写整段剪贴板是硬要求）;手机扫码未单独验证（同一 URL,风险低,留观察）;③互踢首次观察阴性:浏览器完成授权登录后,同时在登录的官方客户端未掉线——登录动作不互踢,**刷新（续期）互踢仍未验证**,自动续期上线后持续观察。

  **二批对表记录（2026-09-26 晚,读参考项目 travel.go/streak.go/headers.go 原文）**:①growth 路径常量 `travelStatusPath=/activity/growth/buddy/travel/status`、`depart/claim` 同基、`streakPath=/activity/growth/streak`,与本项目 Cookie 通道路径逐字一致（此前调研标「未逐行比对」,已消）;②growth 请求走 `growthJSON = chatBase + path`（国区 chatBase=copilot.tencent.com,**无 /v2 前缀**）+ BillingHeaders——该头族不设 Origin/Referer,UA 用 billing 单段;③streak.go 文件头「走 www.workbuddy.cn」注释为陈旧注释,代码实际走 chatBase（调研报告已标注矛盾,以代码为准）;④参考项目不调 get-user-request-usage,统计端点仍是同族推定;⑤企业头 X-Enterprise-Id/X-Tenant-Id 按 BillingHeaders「非空才带」补进 Rust 注入分支。

  **usage 端点探测记录（2026-09-26 晚,真机 404 后无凭据 curl 探测）**:判别法=已存在路由返回 401 Authorization Required、不存在返回 APISIX「404 Route Not Found」（以 spike 已证通的 /v2 get-user-resource 401 标定）。结论:**get-user-request-usage 不在 /v2 前缀下**——`/v2/billing/meter/get-user-request-usage` 在 codebuddy.cn / copilot.tencent.com / workbuddy.cn 全 404;**无前缀** `/billing/meter/get-user-request-usage` 在 codebuddy.cn / copilot.tencent.com / workbuddy.ai 全 401（路由存在,待凭据验证 Bearer 放行）。token 通道统计改走无前缀路径:中国站首选 codebuddy.cn、copilot.tencent.com 同路径备选（404 双试）,国际站维持无前缀首选 + /v2 回落。资源/签到端点不动（/v2 已 spike 实证）。
- **维护面扩大**:第二套出站头族、两个新增白名单域（copilot.tencent.com 是腾讯通用域,登记时在 ADR-0032 清单里注明其属于 workbuddy 授权/取数域）、续期状态机;非公开接口改版的跟随成本翻倍。
- 存量用户零感知;扫码入口只出现在 WorkBuddy 实例表单。
- 本 ADR 修订 ADR-0029 两处:Decision 1 的「不做 OAuth/自动续期」与取数域范围;其凭据形态（三格）保留为 Cookie 通道不变。
