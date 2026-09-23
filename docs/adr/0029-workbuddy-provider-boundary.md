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

1. **凭据手动粘贴（网页 Cookie，而非 JWT）**：凭据槽 `cookie`，用户从浏览器网络面板复制整串 Cookie。**这条推翻了最初的设计**：原计划按社区实现走「Bearer JWT 粘贴」，但 2026-09-21 用户抓包证实 workbuddy.cn 网页端**不用 Bearer**——身份是 `session`/`session_2` 服务端会话 Cookie；Bearer JWT 只存在于官方 IDE 扩展/CLI 的 OAuth 链路，网页用户拿不到。故凭据改为网页 Cookie（`auth: "cookie_header"` 通道，vault 按槽位读取、原样作 Cookie 头）。不存 refresh token、不做 OAuth/自动续期。失效（401/403 或登录页 HTML）表现为快照 `error` 提示重贴，重贴即恢复。Cookie 会话的有效期由服务端掌控（未知、可能远短于 JWT 的 60 天），过期重贴是常态。**2026-09-21 二次修订（凭据形态）**：字段收敛为「只填 session 的 Value」，前端不加工不改写用户输入（仅 RFC 6265 字符集白名单校验，防 CRLF 头注入与整串误粘），`Cookie: session=<值>` 的拼装统一在 Rust 端完成；通道更名 `session_cookie`，探测与刷新共用同一拼装口径。**2026-09-21 三次修订（凭据=Copy as cURL 整串）**：二次修订在换机/换浏览器后必然失效——网关校验的是 **(session, session_2, 登录时 UA) 三元组同源**，只发 session 单值被 APISIX 直接 401（同 UA 二分实测），而 UA 又必须逐字节匹配。故凭据槽改存「浏览器 DevTools → Network → 右键 Copy as cURL」的原文，`src-tauri/src/curl_paste.rs` 解析出三要素后注入 Cookie 与 User-Agent 两个头；兼容只贴 `Cookie:` 头与二次修订那种裸 session Value（缺 session_2 时行为回退到 401，属用户可自愈状态）。前端彻底不参与 UA 与 Cookie 拼装，UA 常量降级为 Rust 端 `WORKBUDDY_FALLBACK_UA` 兜底值。**2026-09-22 四次修订（凭据=三格分别填值）**：cURL 整串是唯一要求用户理解「请求导出格式」的录入面，与其它供应商（贴一个值）不一致，而它带来的三要素其实只有两个 Cookie 值加一行 UA。故凭据改为 `session` / `session2` / `userAgent` 三槽，各存用户填的原文，Cookie 头与 UA 由 `instances::workbuddy_session` 统一拼装，并过 RFC 6265 字符集白名单（防 CRLF 头注入与整段误粘）。同时**退役 UA 兜底常量**：三格里 UA 是必填项，缺失就点名报错，不再静默用内置值（内置值只对"登录浏览器恰好是那条 UA"的人生效，浏览器一升版即 401 且无从解释）。**历史凭据不做迁移**：`curl_paste.rs`（cURL 原文解析器）连同它的启动期一次性迁移、幂等判定、256KB 粘贴上限与单测整体删除，`shell-words` 依赖一并去掉——留一段只服务升级路径的代码会长期沉淀成没人敢动的化石，而在用用户极少、重填三格本就是唯一的日常出路（会话随时会过期）。升级后 WorkBuddy 实例的三格为空、快照点名「缺少 WorkBuddy session」，重填即恢复。探测改收同一组三值、走同一个拼装入口，因此「测得过即存得过」的口径不变。
2. **动作白名单**：只读（余额/套餐 `get-user-resource`、连登 `streak`）+ 幂等签到（`daily-checkin`，10001/14001 视为已签）+ **喵喵旅行的领奖与出发**（`buddy/travel/claim` 带 record_id、`buddy/travel/depart` 固定 location_id 1——1~4 收益/时长区间相同，workbuddy2api 实测；领奖响应 credit/reward_credit 两字段都容）。领奖与出发是**非消耗**写操作（积分只进不出），领奖按行程 depart_at 判重、出发由服务端 `daily_limit_reached` 节流（按 CST 自然日重置的一日一出），2026-09-21 修订纳入；补签卡、礼包领取仍**不做**——消耗性/领取类决策出错会伤害真实积分资产，违背工具定位。**统计接口（2026-09-21 二次修订，全部只读）**：消耗明细 `get-user-request-usage`（分页拉全后前端聚合，`input` 全文不取、只用截断版 `inputTrunc`）、汇总 `get-user-resource-summary`（IsPaidUser + 按 PackageCode 聚合，端点已验证、暂无 UI）、购买积分 `get-user-resource-paid-packages`（免费账号为空，仅记录端点）。余额端点取通用 `get-user-resource`（2026-09-21 对照审查修正：两个社区实现同款端点；网页端在用的同族 `-free-packages` 顾名思义只覆盖免费包，付费套餐未必在响应内）。请求体的 `ProductCode`/`Status:[0,3]`/`OnlyValidPeriod` 与两参考实现对齐（`Status:[0]` 会漏掉状态 3 的周期进行中套餐；不过滤已过期套餐会虚增余量、阈值告警失明），`PackageCodes` 目录码快照已于 2026-09-22 撤除：两站真机回放四变体（带码+SlicePeriod / 带码 / 去码 / 去码+NeedInUsage）结果完全一致（国区重度账号 53 个套餐、周期总额 4394；国际站 2 个、350），目录码与 `NeedInUsage` 都不参与结果，故请求体只发 `ProductCode` + `Status:[0,3]` + `OnlyValidPeriod` 骨架、两站共用一份——workbuddy2api 的「码可省」结论在本机得证，那份要跟随官方扩目录维护的清单不再是负债。
3. **签到挂在刷新链**：每实例每天第一次刷新（自动或手动均计）先签到后取数（到账积分当轮可见），内存记「今日已签」标记（重启丢失只多发一次幂等请求）；成功发系统通知，已签静默；不设独立开关——是否刷新由既有开关决定，签到无独立行为。
4. **只模拟 web 客户端特征**：`x-client-platform: web` + 对应 referer + Cookie 会话，仅调 billing/activity 族接口；**不做聊天补全反代**，不触碰 CLI 指纹门禁。UA 的判据不是「像不像 Edge」而是**与登录时逐字节相同**（三次修订实测二分：同一有效 Cookie 对，`Edg/153.0.0.0` 改末位为 `153.0.0.1`、去掉 `Edg/` 段、换成非浏览器 UA，一律 401）——所以 UA 只能随凭据一起进来，硬编码常量只是缺省兜底，浏览器一升版即失配。
5. **realm 预留（2026-09-22 兑现）**：apiBase 抽为单一常量位，首发仅国区（workbuddy.cn）；国际站（workbuddy.ai）是另一套登录域，Cookie 不互通。兑现时按多站供应商的通用机制走（ADR-0031）——站点是实例的显式属性（`site`），端点与 Origin/Referer 按站取，**能力按站声明**：实测国际站没有国区这套成长运营（签到、连登 `streak`、喵喵旅行 `travel` 都不存在；用量页与消耗明细与中国站同款），取数链据能力表整段跳过，不发注定失败的请求，也就不会把「本站没这个功能」报成「登录凭据无效」。国际站的商品体系经 2026-09-22 真机回放确认与国区同构（`ProductCode` 同为 `p_tcaca`，目录码与浏览器带的 `SlicePeriodStart/End`、`NeedInUsage` 都不参与结果），故国际站请求体只发公共骨架。凭据形态两站统一为三值分槽，不因本站网关宽松而分叉。

## Considered Options

- **Bearer JWT 粘贴（最初设计，已推翻）**：2026-09-21 用户实测抓包显示网页端无 Authorization 头、纯 Cookie 会话；JWT 只在官方 IDE 扩展/CLI 的 OAuth 链路里，网页用户无从获取。社区工具（CodeBuddy-Usage）能拿 JWT 是因为它读官方 IDE 扩展的加密存储——那条路的门槛见下条。
- **OAuth 授权流 + 自动续期**：体验最好（用户无感），但要新做「授权型实例」一整条链路（打开系统浏览器、state 轮询、refresh token 安全存储与调度），且与官方客户端 token 轮换冲突是结构性问题——除非用户弃用官方客户端，否则互相踢下线无解。
- **读官方 IDE 扩展本地存储**（CodeBuddy-Usage 的主路径，JWT 来源）：对用户最省事，但要适配整个编辑器矩阵（Code/Trae/Cursor/Kiro/Qoder…）+ Electron safeStorage 解密（Windows DPAPI、macOS 钥匙串），侵入性强、平台碎片化，Tauri 里维护成本不成比例。
- **每次刷新都签到 / 独立每日定时器**：30 分钟一刷即一天 48 次打活动接口，无谓的风控暴露；独立定时器与刷新链分裂，多一套生命周期要维护。
- **签到加实例级开关**：行为已完全由刷新开关决定，再加设置项冗余；代价是无法「只关签到不关刷新」——若将来有此诉求再补。
- **自动化旅行/补签/礼包**：收益是额外积分，代价是状态机 + 消耗决策 + 每日上限等长尾细节，出错直接损失用户资产。2026-09-21 修订：旅行拆开评估——领奖（收已到账的积分）与出发（不消耗任何资产）安全，纳入白名单；补签卡（消耗补签道具）与礼包（领取类、语义不明）维持不做。
- **粘贴解析器（三次修订引入，已随四次修订的三格录入删除；实测结论留记）**：通用库 `curl-parser` 0.6.0 实测出局——它的 pest 语法是**选项白名单**（`-X/-H/-d/-u/-k/-L` + URL），DevTools 复制必带的 `--compressed`、POST 的 `--data-raw`、cmd 版的 `-b` 与 `^` 续行全都命中不了 → 真实粘贴成功率 0%；且 `-H 'garbage'`（无冒号）会走 `expect` **panic**，在 Tauri command 里就是任务崩溃。当时改用 `shell-words` 分词 + ~60 行已知键抽取。两个坑对所有「粘贴用户文本」的解析都成立，与用哪个库无关：cmd 的 `^` 续行必须先把 CR/CRLF 统一成 LF 再按行合并、**合并处必须补空格**（不补则 `-H` 与前一行引号粘成同一个 token，后面的头静默全丢，症状与 401 一样查不出来）；非 ASCII 粘贴会踩 `text[..7]` 字节边界 panic，前缀比较一律走 `get(..7)`。
- **旅行领奖通知判重复用 alert_states / 仅内存**：落库快照随重启 reevaluate 重放 travel 字段，纯内存必重报；alert_states 的未知规则键会被协调器重置（与签到同一结论）。故与签到同构，新增 workbuddy_travel_claims 单行事实源，判重键用行程 depart_at 而非日期——一天可有多趟旅行。

## Consequences

- 用户需**每登录会话重填一次三项凭据**（服务端会话有效期未知，可能远短于最初假设的 60 天；换浏览器、换机器、浏览器升版也算）。401 有两种成因——会话失效与三元组不同源（漏 session_2、UA 与登录时不一致），出路同为重填，故快照文案统一为「登录凭据无效或已过期，请在设置中重新填写三项凭据」，不试图区分（区分需要额外一次探测且无法给出不同建议）。期间该实例快照持续报错直到重填——错误可见（ADR-0024），不会静默用旧数据。
- 三格各自存原文（session / session_2 各近 2000~4000 字符、UA 不足 200 字符），仍在系统凭据库内加密、不出本机；长度与字符集上限由 Rust 端把住（Cookie 值 65536、UA 512），只为挡住误粘的整段请求，不承担安全判定之外的活。
- **从 cURL 形态升上来的用户要重填一次**：旧的 `cookie` 槽原文不再被拆解（刻意不做迁移）。已是实例模型（vault 内层 v2）的库，WorkBuddy 三格皆空、快照点名缺哪一格；更早的扁平凭据库，`workbuddyCookie` 不再映射到任何槽，连实例都不自动建，要手动添加一次。这是有意选择的代价——用一段只活一次命的迁移代码（解析器 + 幂等判定 + 专项测试）换掉一次重填，换来的只是长期负债，而在用用户本来就少、会话本来就随时过期，重填是日常动作。
- 依赖非公开接口，腾讯改版需跟随维护；本工具只碰 billing/activity 族且不模拟 CLI，与聊天族门禁隔离，改版波及面有限。
- 积分聚合口径为**累计已用**（全部有效套餐计入分母，含已耗尽的），与 workbuddy2api 的 ResourceSummary 一致；CodeBuddy-Usage 只把有余量的套餐计入分母（剩余可用口径），两者在「作废/耗尽积分多」的账号上告警时机不同。本工具选前者——已用百分比如实反映历史消耗，托盘环与阈值告警同源不歧义；切换口径只需改 `parseResourceLines` 一处聚合。
- 签到无法单独关闭；不想要签到的用户只能停用该实例的自动刷新并避免手动刷新。
- WorkBuddy 无调用级用量接口，统计页无新增页面，卡片即全部展示面；积分到期提醒（数据现成）列为二期候选，需新的告警类型。
- 该供应商的第 4 个 `ProviderKind`（`workbuddy`）进入实例/快照/诊断的类型判别集合，后续新增供应商沿用同一扩展位。
