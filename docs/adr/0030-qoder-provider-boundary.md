# Qoder 接入边界：双站 Cookie 粘贴与只读积分

Status: accepted

## Context

第五个供应商 Qoder（阿里的 AI IDE，本工具只读它的账号积分余量）**个人账号**没有公开 API，唯一已知的取数通道是账号控制台网页私有接口 `GET /api/v2/me/usages/big_model_credits`，凭网页 Cookie 调用，返回配额汇总与 `nextResetAt` 重置时间。社区先例 CodexBar（steipete/CodexBar，`docs/qoder.md` + 实现 `Sources/CodexBarCore/Resources/Plugins/qoder.js`）验证了该通道，其要点：

> **2026-09-24 真机更正（两份原样响应 + 官网用量页截图）**：本段当时两处不实，均已按证据改写——① 响应的容器是 `plan_quota` / `resource_package_quota` / `dedicated_resource_package_quota` / `total_quota` 四个，**没有 `sharedQuota`**（那是 CodexBar 侧的字段名，其插件读 `totalQuota ?? total_quota` 再叠一个真机不存在的 shared），`total_quota` 才是官方汇总位；② 「没有请求级历史端点」是凭 CodexBar 只用了一个端点就下的结论，而官网用量页自己就有「Credits 消耗热力图（近一年每日）」「按 1 天/7 天/30 天/月初至今/上个月 的消耗趋势」与「Credits 记录」列表——历史与明细数据在网页侧确实存在，只是端点名没去侦察。「本期无统计页」的结论不变，理由从「没有数据源」改成「数据源未侦察」。教训同 ADR-0033 走过的弯路：上游项目做了什么 ≠ 上游项目证明了什么。

- **双登录域**：国际站 `qoder.com` 与中国站 `qoder.com.cn` 是两套登录域，Cookie 不互通；裸 Cookie 头默认按国际站处理。
- **网关不绑定登录时 UA**：CodexBar 用硬编码 Chrome UA + 写死的 `Bx-V: 2.5.35`（Baxia 风控头）即可稳定取数——与 WorkBuddy「UA 必须与登录时逐字节相同」（ADR-0029）截然不同，凭据形态可以更简单。
- **公开 API 存在但只对 Teams/企业**：`/v1/organizations/{orgId}/members/{memberId}/usage-events`、`usage-summary`、`resource-packages`、`seat-month-batches`，鉴权是 Organization API Key（端点清单来自 2026-09-24 上一轮对官方文档的查证，本轮未复核出处）。个人版账号拿不到这层，所以本工具的通道仍是控制台网页私有接口——「没有公开 API」这句原话失准，准确说法是「个人账号没有」。
- 401/403 即凭据失效；无其他动作类接口。

本工具侧，供应商架构已具备实例/凭据槽/快照/告警全套机制（ADR-0011），单百分比配额窗口的量纲映射与 OpenCode Go 同构。

## Decision

**接入边界四条：双站同发（站点是实例显式属性）、单个会话 Cookie 的值粘贴、只读单端点、积分量纲走既有配额窗口机制。**

1. **双站同发，站点为实例显式属性**：实例弹窗加「站点」下拉（中国站 qoder.com.cn 默认 / 国际站 qoder.com），请求时切换 URL 与 Origin/Referer。不从粘贴内容判站（CodexBar 靠 cURL 捕获里的 Host 猜站）——显式选择判站确定，粘贴门槛也更低。这套机制在 WorkBuddy 接入双站时泛化为多站供应商通则，见 ADR-0031。
2. **纯 Cookie 值粘贴，输入原样存储原样发送**：凭据槽 `cookie`，用户从浏览器 F12 复制 `Cookie:` 请求头的**值**（`key=value`，多对用 `key1=xxx; key2=xxx`）；不带前缀、不抠字段，前后端都不做归一化（与 WorkBuddy 的凭据口径一致：输入什么存什么，剥前缀这类「兼容」会造成回填值与粘贴值不一致）。凭据相关头在 Rust 端统一拼装——`raw_cookie` 通道原样注入 Cookie、UA 缺省按本机编译目标生成 Chrome 常量（UA 声称 Macintosh 而 TLS 指纹是 Windows/Linux 是风控最容易识别的不自洽；版本串与 `Bx-V: 2.5.35` 风控头一样写死，升级时跟随 CodexBar 更新），前端不碰凭据、只做字符集与形态白名单校验（可见 ASCII、拒 CR/LF 头注入、拒「Cookie:」前缀——违规直接报错让用户改输入，沿用 WorkBuddy 二次修订的口径）。Origin/Referer/X-Requested-With 等静态协议头与 WorkBuddy 的 `x-client-platform` 同先例、随端点定义在前端。凭据头与静态头的隔离**靠名字不靠顺序**：reqwest 的 `RequestBuilder::header` 内部是 `HeaderMap::append`（同名会并存两条、先到的那条被网关读到），所以「先铺静态头再注入凭据头」并不能让凭据赢——`provider_request` 与 `diagnose_request` 都按名字剔除调用方传来的 `Cookie` / `Authorization` / `User-Agent`（大小写无关），这三个头只可能由鉴权分支写入。白名单同样在探测与保存两处生效（`testQoderCookie` 与保存共用 `isValidQoderCookie`），Rust 侧 `raw_cookie` 再兜一次字符集，被外部改过的 vault 行也是明确报错而不是 reqwest 那句无指向的 builder 错误。刻意不复用 curl_paste.rs：那套「Copy as cURL 三元组同源」机制是为 WorkBuddy 的 UA 绑定网关设计的，Qoder 无此约束，让用户贴 cURL 是无谓的粘贴负担。若真机验证撞上 UA/指纹风控（见 Consequences），升级路径现成。**2026-09-23 二次修订（凭据=单个 Cookie 的值）**：真机验证只需 `qoder_session_cookie` 这一个键（其余 Cookie 不参与鉴权），故凭据槽 `cookie` 改存该键的**值**原文，`Cookie: qoder_session_cookie=<值>` 的拼装收敛进 Rust 的 `qoder_cookie` 通道——原 `raw_cookie`（整段 Cookie 头原样注入）随本次改口径退役，没有别的供应商在用，UA 常量随之更名 `QODER_DEFAULT_UA`。白名单同时从「整段 Cookie 头值（可见 ASCII）」收紧为「单个 cookie-value」：RFC 6265 的可见 ASCII 并排除空白、`"`、`,`、`;`，与 curl_paste 的 `validate_cookie_value`、前端 `providers/qoder.ts` 的 `isValidSessionCookieValue` 逐字符一致，另两条形态判定（`Cookie:` 前缀、连键名一起贴）只用于给错文案。仍然只判定不加工：不做「从整段 Cookie 里抠出该键」的兼容，理由与本条原文相同。代价是存量实例里那段整页 Cookie 过不了新校验，刷新时得到一句指明「只粘贴 qoder_session_cookie 的值」的报错而不是静默 401（ADR-0024 错误可见），用户重贴一次即恢复。
3. **只读，单端点，卡片即全部展示面**：仅调 big_model_credits 汇总端点。无统计页——没有历史/明细数据源可接（WorkBuddy 统计抽屉的前提 `get-user-request-usage` 在 Qoder 没有对应物）；亦无签到、旅行类动作面，刷新链是纯取数。卡片主行「已用/总量 积分」+ 重置倒计时行（有 `nextResetAt` 时），诊断按钮沿用先例（探测=同端点，401/403 不区分成因，统一引导重贴 Cookie）。**2026-09-24 真机校准（零总量与过期重置时刻）**。体验版账号的真实响应已原样落盘为 `src/providers/__fixtures__/qoder-usage-trial.json`（`user_id` 与明细 id 打码）：容器实际是 `plan_quota` / `resource_package_quota` / `dedicated_resource_package_quota` / `total_quota` 四个、全为 0，**没有 `shared_quota` 这个键**（那是 CodexBar 的字段名；`total_quota.quota_detail` 就等于 `plan_quota` 的那条 PLAN 明细，即它是汇总位），键名两套大小写混用——容器 snake_case、`lastResetAt`/`nextResetAt` camelCase。据此定两条判定。零总量（`limit_value=0`、`used_value=0`）是「这个套餐没分配积分」，不是「用满等重置」——真用满会回 `used=limit>0`，百分比自然算到 100，无需伪造；官网用量页自己也写「0 / 0（已使用 0%）」，下发的 `usage_percentage` 就是 0。首版把它判成耗尽形态是错的，而且注释把这条推断记成了「CodexBar 同款」——其文档只说「有 nextResetAt 就用」，零总量语义根本没定义，是我方推断冒充了先例（该注释已删）。现改为：零总量时百分比与重置时刻一并置空，卡片出「未分配积分」一行中性事实（与 WorkBuddy 无套餐行同法，`workbuddy.ts:284`），进度行不再产生，因此红条、重置倒计时、耗尽告警（`evaluate.ts:125` 盯 `percentUsed>=100`）与托盘满环都不再出现；`used>0` 配 `total=0` 仍是矛盾数据、整体拒收。重置时刻另加一条只认未来的规则：样本里 `nextResetAt=1767708936459`（2026-01-06 22:15 CST）相对当天已过去八个月，与 `lastResetAt` 正好差 14 天——未分配积分账号的周期是冻结的；照挂就是卡片上永远挂着一个过去的「重置」时刻，切到相对口径更会显示「即将重置」，两句都是假话，故过期与缺失同处理（隐藏该行，不阻塞取数）。
4. **积分量纲映射为单个百分比配额窗口**：主指标=已用百分比，阈值告警与额度耗尽照常，托盘用量环可绘制（百分比量纲）；取数只读 `total_quota.quota_summary`，三个分容器与 `quota_detail` 不读。两份真机样本对账证明 `total_quota` 就是「订阅 + 资源包 + 专属资源包」的汇总位（付费样本 2000+1200=3200、2000+534=2534、0+666=666），所以 CodexBar 那条再叠 `shared_quota` 的路径**不实现**：那个键在两个站的真机响应里都不存在，而万一它以「已被 total 计入」的形态出现，叠一次就是重复计数（首版按 CodexBar 照抄了这条，2026-09-24 随本条一并删除，含合成 fixture）。百分比一律本地按 `used/total` 计算，接口下发的 `usagePercentage` 不入模型。中国站付费样本已证实它的量纲是 0~100，而且是**向上取整**的整数（`2534/3200 = 79.19` 下发 80，明细里 `34/100` 下发 35），所以不采用的真正理由是精度：拿它当主指标等于给用户一个站点替你进位过的数字，阈值告警也会在边界上比真实用量先响（阈值 80 时 79.19% 就告）。CodexBar 的插件恰好相反——`provided ?? 本地算`，优先信下发值，只有存在 shared 容器时才本地算（体验版无 shared、下发 0，它显示 0%，那条 `total===0 → 100` 只是 shared 分支的兜底，我方首版把它当成了通用口径，见 §3）。展示面沿用 WorkBuddy 惯例：主行为进度行，速览的「账户余额」位承载积分余量数值（`balance` 标记选行），不代表金额量纲。没有金额量纲，不涉及主指标量纲回退（DeepSeek 余额那套不参与）。

## Considered Options

- **Copy as cURL 整串（WorkBuddy 同款）**：对潜在 UA/指纹风控更稳，但粘贴体验更重、帮助文案更长；CodexBar 硬编码 UA 的实证表明这层保险大概率用不上。留作撞风控时的升级路径而非起点。
- **两种粘贴都接受（Cookie 头或 cURL 捕获，CodexBar 手动模式同款）**：灵活但多一条解析路径要维护、测试矩阵翻倍；cURL 的判站优势已被显式下拉取代。
- **只做单站**：最省，但手上可验证的抓包只有自己用的那个站；双站的实现成本只是一个枚举分支，与 WorkBuddy 的 realm 预留（ADR-0029 §5）同构，只是这里两个 realm 都活。
- **统计页/明细侦察先行**：本期不做，但**理由不是「没有数据源」**——官网用量页自己就带「Credits 消耗热力图（近一年每日）」、按 1 天/7 天/30 天/月初至今/上个月的消耗趋势，以及「Credits 记录」列表（2026-09-24 中国站截图），说明历史与明细端点存在，只是没去侦察具体路径与口径。日后要做按 WorkBuddy 统计抽屉的模式接二期；本期结论（只读汇总端点、无统计页）不变。

## Consequences

- **真机验证进度（两站都过了）**：国际站早已由本工具在 Windows 上跑通；中国站使用者已实测确认本工具发出的请求可用（2026-09-24），CodexBar 的 macOS 结论跨平台成立，写死 UA + `Bx-V` 的组合在中国站的 Baxia 风控下也认。这条曾是本 ADR 唯一的实质风险项，现降级为常规维护项（见下条 `Bx-V` 升级跟随）；403 的出路仍是把凭据槽升级为 curl_paste 形态（带真实 UA），凭据库结构支持换槽不改架构。
- `total_quota` 是汇总位这一点由付费样本对账证实（§4），三个分容器与 `quota_detail` 都不参与计算。代价是 `quota_detail` 里每个资源包各自的 `expires_at` 我方完全没读——这正是下面那条局限的根源。
- **合并成单个百分比窗口会吞掉「订阅已用尽」这个信号（已知局限，未修）**：付费样本的订阅是 2000/2000（100%，官网单独一张卡），资源包是 534/1200（45%），合并后 79.19%——于是耗尽规则（`evaluate.ts:125` 盯 `percentUsed>=100`）不响，阈值告警也离撞线还远，而用户此刻的真实处境恰恰是「订阅额度见底、只能靠赠送包撑」。同理，重置时刻全响应只有一个 `nextResetAt`，它是**订阅**周期的刷新时刻（样本值 = 2026-09-26 08:28:27 CST，与官网「将于 2026年9月26日 08:28:27 刷新配额」逐字对齐），可卡片上那 666 点余量全在资源包里、按各自 `expires_at` 到期（样本里最近的一笔是 10/18），读起来就成了「666 会在 9/26 重置」。出路是拆成「订阅配额」与「资源包」两行进度、各带自己的时间（资源包取组内最早 `expires_at`），多窗口机制在 GLM / OpenCode Go 上是现成的（`primaryProgressLine` 选主窗、托盘多层环、按窗耗尽告警），属既有机制复用而非新架构；是否要做由使用者拍，本期只记局限。
- 零总量=「未分配积分」这条已不再是假设：付费样本证明订阅用满时回的是 `limit>0, used=limit`（plan 就是 2000/2000），不会把总量归零，两种状态可分。
- `nextResetAt` 缺失或已过期时的行为都是隐藏倒计时行，不阻塞取数（§3）；这意味着一个周期冻结的账号在卡片上表现为「没有重置信息」，是刻意选择——挂一个过去的时刻比不挂更容易被读成假话。
- `Bx-V` 版本号与 UA 版本串是写死的常量（UA 平台段按本机编译目标分 windows/macos/linux 三套），Qoder 风控升级后需跟随 CodexBar 更新（依赖非公开接口的常规维护成本，ADR-0006 家族）。
- 依赖端点仅一个只读族，无写操作，不涉及动作白名单问题；凭据失效表现为快照 `error` 并引导重贴 Cookie（ADR-0024 错误可见）。
- 第 5 个 `ProviderKind`（`qoder`）进入实例/快照/诊断的类型判别集合，连同凭据槽 `cookie` 与「站点」实例属性一起沿用既有扩展位，后续供应商照抄。
- 「凭据头只由鉴权分支注入」是头维度（发给谁，凭据头都只能有一条、且值来自凭据库），目标域名是目的地维度；后者对五个供应商同构、且要按种类收窄，故单独立 ADR-0032。
