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

**接入边界六条：双站同发（站点是实例显式属性）、单个会话 Cookie 的值粘贴、全程只读、积分量纲走既有配额窗口机制、一个有分配的容器一行、统计页只读明细与近一年分布。**

1. **双站同发，站点为实例显式属性**：实例弹窗加「站点」下拉（中国站 qoder.com.cn 默认 / 国际站 qoder.com），请求时切换 URL 与 Origin/Referer。不从粘贴内容判站（CodexBar 靠 cURL 捕获里的 Host 猜站）——显式选择判站确定，粘贴门槛也更低。这套机制在 WorkBuddy 接入双站时泛化为多站供应商通则，见 ADR-0031。
2. **纯 Cookie 值粘贴，输入原样存储原样发送**：凭据槽 `cookie`，用户从浏览器 F12 复制 `Cookie:` 请求头的**值**（`key=value`，多对用 `key1=xxx; key2=xxx`）；不带前缀、不抠字段，前后端都不做归一化（与 WorkBuddy 的凭据口径一致：输入什么存什么，剥前缀这类「兼容」会造成回填值与粘贴值不一致）。凭据相关头在 Rust 端统一拼装——`raw_cookie` 通道原样注入 Cookie、UA 缺省按本机编译目标生成 Chrome 常量（UA 声称 Macintosh 而 TLS 指纹是 Windows/Linux 是风控最容易识别的不自洽；版本串与 `Bx-V: 2.5.35` 风控头一样写死，升级时跟随 CodexBar 更新），前端不碰凭据、只做字符集与形态白名单校验（可见 ASCII、拒 CR/LF 头注入、拒「Cookie:」前缀——违规直接报错让用户改输入，沿用 WorkBuddy 二次修订的口径）。Origin/Referer/X-Requested-With 等静态协议头与 WorkBuddy 的 `x-client-platform` 同先例、随端点定义在前端。凭据头与静态头的隔离**靠名字不靠顺序**：reqwest 的 `RequestBuilder::header` 内部是 `HeaderMap::append`（同名会并存两条、先到的那条被网关读到），所以「先铺静态头再注入凭据头」并不能让凭据赢——`provider_request` 与 `diagnose_request` 都按名字剔除调用方传来的 `Cookie` / `Authorization` / `User-Agent`（大小写无关），这三个头只可能由鉴权分支写入。白名单同样在探测与保存两处生效（`testQoderCookie` 与保存共用 `isValidQoderCookie`），Rust 侧 `raw_cookie` 再兜一次字符集，被外部改过的 vault 行也是明确报错而不是 reqwest 那句无指向的 builder 错误。刻意不复用 curl_paste.rs：那套「Copy as cURL 三元组同源」机制是为 WorkBuddy 的 UA 绑定网关设计的，Qoder 无此约束，让用户贴 cURL 是无谓的粘贴负担。若真机验证撞上 UA/指纹风控（见 Consequences），升级路径现成。**2026-09-23 二次修订（凭据=单个 Cookie 的值）**：真机验证只需 `qoder_session_cookie` 这一个键（其余 Cookie 不参与鉴权），故凭据槽 `cookie` 改存该键的**值**原文，`Cookie: qoder_session_cookie=<值>` 的拼装收敛进 Rust 的 `qoder_cookie` 通道——原 `raw_cookie`（整段 Cookie 头原样注入）随本次改口径退役，没有别的供应商在用，UA 常量随之更名 `QODER_DEFAULT_UA`。白名单同时从「整段 Cookie 头值（可见 ASCII）」收紧为「单个 cookie-value」：RFC 6265 的可见 ASCII 并排除空白、`"`、`,`、`;`，与 curl_paste 的 `validate_cookie_value`、前端 `providers/qoder.ts` 的 `isValidSessionCookieValue` 逐字符一致，另两条形态判定（`Cookie:` 前缀、连键名一起贴）只用于给错文案。仍然只判定不加工：不做「从整段 Cookie 里抠出该键」的兼容，理由与本条原文相同。代价是存量实例里那段整页 Cookie 过不了新校验，刷新时得到一句指明「只粘贴 qoder_session_cookie 的值」的报错而不是静默 401（ADR-0024 错误可见），用户重贴一次即恢复。
3. **只读，卡片是常驻展示面**：调的都是账号控制台的只读 GET，无任何写操作、无动作类接口（签到/旅行那类在 Qoder 根本没有可调用面，见 Considered Options）。原文这句「仅调 big_model_credits 汇总端点，无统计页，卡片即全部展示面」已在 2026-09-25 被自己的侦察推翻——历史与明细端点确实存在，统计页按 §6 接入；「无签到动作面」这一半仍然成立。卡片行形态见 §5（2026-09-24 由单行改成一个容器一行），诊断按钮沿用先例（探测=同端点，401/403 不区分成因，统一引导重贴 Cookie）。**2026-09-24 真机校准（零总量与过期重置时刻）**。体验版账号的真实响应已原样落盘为 `src/providers/__fixtures__/qoder-usage-trial.json`（`user_id` 与明细 id 打码）：容器实际是 `plan_quota` / `resource_package_quota` / `dedicated_resource_package_quota` / `total_quota` 四个、全为 0，**没有 `shared_quota` 这个键**（那是 CodexBar 的字段名；`total_quota.quota_detail` 就等于 `plan_quota` 的那条 PLAN 明细，即它是汇总位），键名两套大小写混用——容器 snake_case、`lastResetAt`/`nextResetAt` camelCase。据此定两条判定。零总量（`limit_value=0`、`used_value=0`）是「这个套餐没分配积分」，不是「用满等重置」——真用满会回 `used=limit>0`，百分比自然算到 100，无需伪造；官网用量页自己也写「0 / 0（已使用 0%）」，下发的 `usage_percentage` 就是 0。首版把它判成耗尽形态是错的，而且注释把这条推断记成了「CodexBar 同款」——其文档只说「有 nextResetAt 就用」，零总量语义根本没定义，是我方推断冒充了先例（该注释已删）。现改为：零总量时百分比与重置时刻一并置空，卡片出「未分配积分」一行中性事实（与 WorkBuddy 无套餐行同法，`workbuddy.ts:284`），进度行不再产生，因此红条、重置倒计时、耗尽告警（`evaluate.ts:125` 盯 `percentUsed>=100`）与托盘满环都不再出现；`used>0` 配 `total=0` 仍是矛盾数据、整体拒收。重置时刻另加一条只认未来的规则：样本里 `nextResetAt=1767708936459`（2026-01-06 22:15 CST）相对当天已过去八个月，与 `lastResetAt` 正好差 14 天——未分配积分账号的周期是冻结的；照挂就是卡片上永远挂着一个过去的「重置」时刻，切到相对口径更会显示「即将重置」，两句都是假话，故过期与缺失同处理（隐藏该行，不阻塞取数）。
4. **积分量纲映射为百分比配额窗口**：主指标=已用百分比，阈值告警与额度耗尽照常，托盘用量环可绘制（百分比量纲）；`total_quota` 是必需的结构位（读不到即解析失败）并且单独提供实例级余量，各窗口的百分比取自分容器（§5）。两份真机样本对账证明 `total_quota` 就是「订阅 + 资源包 + 专属资源包」的汇总位（付费样本 2000+1200=3200、2000+534=2534、0+666=666），所以 CodexBar 那条再叠 `shared_quota` 的路径**不实现**：那个键在两个站的真机响应里都不存在，而万一它以「已被 total 计入」的形态出现，叠一次就是重复计数（首版按 CodexBar 照抄了这条，2026-09-24 随本条一并删除，含合成 fixture）。百分比一律本地按 `used/total` 计算，接口下发的 `usagePercentage` 不入模型。中国站付费样本已证实它的量纲是 0~100，而且是**向上取整**的整数（`2534/3200 = 79.19` 下发 80，明细里 `34/100` 下发 35），所以不采用的真正理由是精度：拿它当主指标等于给用户一个站点替你进位过的数字，阈值告警也会在边界上比真实用量先响（阈值 80 时 79.19% 就告）。CodexBar 的插件恰好相反——`provided ?? 本地算`，优先信下发值，只有存在 shared 容器时才本地算（体验版无 shared、下发 0，它显示 0%，那条 `total===0 → 100` 只是 shared 分支的兜底，我方首版把它当成了通用口径，见 §3）。展示面沿用 WorkBuddy 惯例：主行为进度行，速览的「账户余额」位承载积分余量数值（`balance` 标记选行），不代表金额量纲。没有金额量纲，不涉及主指标量纲回退（DeepSeek 余额那套不参与）。
5. **一个有分配的容器一行进度（2026-09-24 修订，修的是 §Consequences 记过的那条吞信号缺陷）**：`plan_quota` / `resource_package_quota` / `dedicated_resource_package_quota` 各自一行，行名「订阅积分 / 资源包积分 / 专属资源包」（英文 Plan credits / Add-on credits / Dedicated packages，对齐官网 CLI 的 Plan Credits 与 Add-on Credits 两栏——那本来就是官方口径的分栏）。恒零容器不出行（没分配就没窗口可画，与体验版整号零分配走「未分配积分」中性行是同一条口径），行序固定 plan → package → dedicated，不按用量重排（否则行位每天换人）。三条刻意的结构选择：
   - **只有订阅行带 `resetsAt`**：全响应唯一的 `nextResetAt` 是订阅周期，资源包各按 `quota_detail[].expires_at` 到期。`primaryProgressLine` 取重置最远的一行为主指标，资源包行不带重置时刻，阈值告警就仍盯订阅配额（而不是那批慢慢消耗的赠送包）；这也是「拆分后主窗是谁」的全部机制——不加 `primary` 字段（那要跨供应商解释四个 provider 的行模型），改用一条测试钉住（`qoder.test.ts` 的 "keeps the reset moment on the subscription line only"）。
   - **到期日走 text 明细行，不占 `resetsAt`**：卡片进度分支那一格文案写死是「{time} 重置」，挂到期时刻等于写假话。改为 `余 {remain} · {expiresAt}到期` 的 value 模板 + ISO 参数（WorkBuddy 套餐明细同款，`renderLineValue` 按界面语言格式化）。**最早到期只算 `remaining_value > 0` 的包**：真机样本里 9-30 到期那笔已耗尽、余量全在 10-18 那包里，不过滤就显示成「最早 9/30 到期」，谎报了这 666 点的去处。池子余量为 0 时整行不出。
   - **`balance` 只挂第一条进度行，值取 `total_quota` 汇总余量**：速览那一格是实例级读数，`firstBalanceLine` 只认第一个标记行——两行都打标记会让「订阅剩 0」盖掉真余量 666。载体行与数值口径不同是刻意事实，靠 "marks only the first progress line as the balance carrier" 一条守住。
   耗尽规则（ADR-0021）本就扫全部进度行，所以按窗触发零改动即成立：订阅 100% 直接出「订阅积分已用尽」；托盘 badge 取最紧窗（ADR-0020）、两行自动变两层环（ADR-0017）同样零改动，本轮只补了两条断言。
6. **统计页（2026-09-25 接入，两站同契约）**：抽屉五块——近一年每日消耗分布（热力图）、指标总览四卡、每日趋势堆叠、用途分布环、模型表 + 逐条明细表。三个只读端点，全部复用卡片的 `qoder_cookie` 通道与静态头（同域，Rust 目的地白名单按主机收，`instances.rs` 里 qoder 一行已覆盖，零改动）：
   - **明细 `GET /api/v1/me/usages/big_model_credits/histories`**：参数 `page` / `page_size` / `start_time` / `end_time`（毫秒，含边界）/ `order_by=begin_at` / `order=-1`；响应 `{ data[], page_result{ last_page, total_size, next_token, … } }`。取数**一次拉全**（`page_size=1000`，按 `last_page` 续拉，防御上限 10 页），图/卡/表都从这一份 rows 本地聚合，明细表本地切片翻页——与 WorkBuddy 抽屉同一套形态（`fetchWorkbuddyUsage` → `aggregateWorkbuddyUsage`）。**始终显式传 start/end**，不依赖服务端「默认从本积分周期起」那个未证实的推断。
  收口只认三条硬依据：空页、短页（本页少于 `page_size`）、分页元数据说到末页或条数齐了；`total_size`/`last_page` **缺失按 null 处理而不是 0**（0 会被读成「只有 0 条」，把取不全伪装成完整）。撞 10 页上限、或声明的 `total_size` 大于实得条数，都**显式报错**不出半份数据 —— 首版把「`rows.length >= total`」放在停止条件最前且 `total` 缺省为 0，等于「响应没有 `page_result` 就只取第 1 页且零告警」，2026-09-25 审查后改掉。
   - **身份 `GET /api/v1/me`**：热力图要 `userId` 入参，而凭据库只有 Cookie 值，所以先打这一次取 `id`。**只取 `id` 一个字段**：响应里的 `name`（真实账号名）、`username`、`email`、`avatar`（URL 含 id）一律不进模型、不进日志、错误文案里也不回显响应体；`userId` **不做按实例缓存**——换号（同实例重贴另一个账号的 Cookie）之后命中旧值，热力图就变成别人的数据，而这个 GET 响应极轻，每次重取换一个不会读错号的面。
   - **热力图 `GET /api/v1/me/ai-conversations/credits-heatmap?userId=&days=366`**：响应 `{ year, unit, levels[4], items[{date,value}], total }`。分档阈值 `levels` 直接用官方下发的，组件不自己发明分位数（`Heatmap` 是通用组件，阈值由调用方喂）。它固定近一年、与档位选择器无关，且独立缓存——它失败不阻塞下面四块。
   - **两条已知口径差异（别当 bug 查）**：① `histories.credits` 服务端已按 2 位小数舍入（实测 06-23 = 1.44），`heatmap` 同一天给原值 1.4547109588 —— 两处数字天生不完全相等；② `heatmap` 的 `total` 是整年合计、`items` 是逐日值，fixture 里刻意保留两者不一致，用来证明我方不做「items 之和 == total」这种断言。热力图当天那一格实测为 0 而明细有当日记录，按返回原样画、不做补值。
   - **`operation` 与 `model_category` 原样显示不翻译**：前者是官网 UI 上的功能名（Agent / Quest Mode / Repo Wiki / Security Scan / Voice Input / Experts / Optimize Input / Ask），翻成中文会让统计页与官网按钮对不上；后者随官方上新无限增长（实测 11 种，含 `Qwen3.8-Max-Preview`），翻译表必然过期。这与 WorkBuddy 相反——它的 `agentPurpose` 是内部标识符（`conversation`、`enhance-prompt`），所以那边建了 `purposeLabel` 映射。
   - **「未扣积分」的构成（口径，别当 bug 查）**：概览卡第四格 = Σ(`original_credits` − `credits`)，它同时容纳两种来源 —— 官网活动折扣（`kind=Charged` 且 `discount_factor<1`，实测 0.5/0.4/0.2/0.1）与完全未计费调用（`kind="Not Charged"`，样本里 `discount_factor` 恒为 1，即官网没打折而是免费）。所以这个词刻意不断言"怎么省的"，副标题写的就是算法本身（折前合计减去实扣）；明细行用角标区分二者（未计费行显示「未计费」，优先于折扣角标）。曾命名为「折扣节省」，把免费额度说成了折扣，2026-09-25 改掉。
   - **金额只作一列展示**：`cost` 是官网自己给的 USD，原样列进明细（未计费记录显示「—」），不进图、不进汇总卡、不参与任何余额逻辑——Qoder 积分不是现金账户（术语卡已定），一切聚合用折后 `credits`。折扣在积分格以角标（「5 折」）出现，不并列折前数字，避免两个数互相打架。

## Considered Options

- **Copy as cURL 整串（WorkBuddy 同款）**：对潜在 UA/指纹风控更稳，但粘贴体验更重、帮助文案更长；CodexBar 硬编码 UA 的实证表明这层保险大概率用不上。留作撞风控时的升级路径而非起点。
- **两种粘贴都接受（Cookie 头或 cURL 捕获，CodexBar 手动模式同款）**：灵活但多一条解析路径要维护、测试矩阵翻倍；cURL 的判站优势已被显式下拉取代。
- **只做单站**：最省，但手上可验证的抓包只有自己用的那个站；双站的实现成本只是一个枚举分支，与 WorkBuddy 的 realm 预留（ADR-0029 §5）同构，只是这里两个 realm 都活。
- **每日趋势改接 `cost-center/credits/daily-trend`**：不接。它实测有自己的区间上限（92 天直接回 `INVALID_TIME_RANGE: credit usage time range is invalid`），参数还是 camelCase（与 histories 的 snake_case 不同一套规矩），而明细一次就能拉全 535 条、本地按自然日聚合的成本可以忽略——多一个端点只是多一套要跟随官方改版的契约。
- **热力图从明细本地聚合**：不选。要画近一年就得为它单独再拉一年明细（几千条、按 1000/页也要几页），而官方端点一次返回 371 格 + 算好的分档阈值。自造分位数等于再发明一个需要辩护的口径。代价是多两个端点（`me` + `credits-heatmap`）。
- **明细表用服务端分页**：不选。图与卡必须全量才能聚合，两套取数路径会出现「图和表不是同一批数据」；`page` 已够用，`page_result.next_token`（游标口子）不碰——它的参数名没探，而 `page` 越界只是回空页、没有漏数据的静默风险。
- **统计页压到二期**（原文，**2026-09-25 已推翻并按 §6 接入**）：当时不做的理由不是「没有数据源」——官网用量页自己就带「Credits 消耗热力图（近一年每日）」、按 1 天/7 天/30 天/月初至今/上个月的消耗趋势，以及「Credits 记录」列表（2026-09-24 中国站截图），说明历史与明细端点存在，只是没去侦察具体路径与口径。同日由使用者 F12 实测把契约拿全，故本期直接做掉。当时记的一条旁证保留作历史：社区插件 *Qoder 多账号 Credits 余量监控*（作者 Ocean，能力市场 id `b406b093-…`）在 `CONNECTORS.md` 里列过 `/api/v1/me`、`/api/v1/me/userplan` 与 `big_model_credits/histories` 三个端点，其中 histories 它自己只写在文档里、代码没实现——**它是二手传闻**，最终参数与响应以本轮实测为准（§6），我方也仍未采纳它的取数路线（给每个号开一个带 `--remote-debugging-port` 的 Edge Profile，与「用户手填凭据 + 目的地白名单」ADR-0029/0032 相反）。
- **每日签到提醒（评估后不做）**：Qoder 确实有「每日签到送 100 积分」活动，且判据可以零新请求——签到额外汇成资源包，`有效期 = 领取日 + 30 天`，于是「存在 `expires_at == 今天 + 30 天` 的包」就是今日已领（真机样本对得上：10-18 到期那笔剩 66，即 9-18 签的）。三个理由不做：① 领取入口只在 Qoder 桌面端浮窗，我们无法代领，条款还明令同一控制人每日仅 1 次、不得换号规避；② 判据要写死活动额度与有效期两个常量，官方一改口径就退化成「一直未签」的假提醒，而这是限时活动；③ 与 WorkBuddy 的签到通知极性相反（那边是代签成功才报），并进来要在告警面留一套「不能动作、只反推」的特例。已按此在代码与本文档记下口径，日后活动若常态化再重估。
- **资源包按 `source` 或按到期日拆多行**：`quota_detail` 的 `source` 实测全是 `RESOURCE_PACKAGE_SOURCE_BONUS`（含那笔 500 的），按它分组没有信息量；逐包出行会把 320px 的速览卡刷爆（真机单号 8 笔）。收口成「整池一行 + 最早到期」，与官方扣减规则（最早到期优先）同构。
- **给 `MetricLine` 加显式 `primary` 标记**：能把「主窗是谁」写进契约，但 OpenCode Go / GLM / WorkBuddy / DeepSeek 四家的行模型都要跟着解释一遍这个字段；隐式约定（只有订阅带 `resetsAt`）+ 一条测试的代价小得多，被破坏时是测试红而不是静默盯错窗。

## Consequences

- **真机验证进度（两站都过了）**：国际站早已由本工具在 Windows 上跑通；中国站使用者已实测确认本工具发出的请求可用（2026-09-24），CodexBar 的 macOS 结论跨平台成立，写死 UA + `Bx-V` 的组合在中国站的 Baxia 风控下也认。这条曾是本 ADR 唯一的实质风险项，现降级为常规维护项（见下条 `Bx-V` 升级跟随）；403 的出路仍是把凭据槽升级为「连请求头整串粘贴、由后端拆出真实 UA」的形态（WorkBuddy 走过这条路，见 ADR-0029 三次修订），凭据库结构支持换槽不改架构。
- `total_quota` 是汇总位这一点由付费样本对账证实（§4）；分容器与 `quota_detail` 现在都读（§5），汇总位只剩两个用途：结构必需性判定 + 实例级余量。
- **「订阅见底」不再被合并窗吞掉（§5 已落地）**：付费样本的订阅 2000/2000 单独一行，100% 直接撞耗尽规则，阈值告警也盯这一行。附带解决的一条：拆分前阈值设 80 而合并算 79.1875% 不告（官网下发 80），现在订阅自己就是 100%，那个取整边界差不再参与判定，合并口径只留在展示位。代价三条：① 卡片从 1 行进度变 2 行（真出现 dedicated 配额则 3 行，再加池子明细行），速览面板相应变高；② 界面上不再有「这个号总共用了百分之几」这个单一数字——它本来就是把两种不同周期的额度加在一起的产物，托盘 badge 与环改按最紧窗（订阅）显示；③ 若官方哪天加了第五个容器，分容器之和会小于 `total_quota`，表现是「各行百分比与余额位的数字对不上」而不会被静默抹平（本工具不做「凑平」，宁可看见不一致），届时按新容器补一行即可。
- 速览面板加了对「中性事实行」的展示位（`glance/data.ts` 的 `neutralText`，无进度行时上位）：Qoder「未分配积分」与 WorkBuddy「暂无有效套餐」不再被报成「暂无数据」。英文文案「No credits allocated」在 320px 宽的那一格偏长，需目检（速览是独立 Tauri 窗口，门禁工具截不了图）。
- 零总量=「未分配积分」这条已不再是假设：付费样本证明订阅用满时回的是 `limit>0, used=limit`（plan 就是 2000/2000），不会把总量归零，两种状态可分。
- `nextResetAt` 缺失或已过期时的行为都是隐藏倒计时行，不阻塞取数（§3）；这意味着一个周期冻结的账号在卡片上表现为「没有重置信息」，是刻意选择——挂一个过去的时刻比不挂更容易被读成假话。
- `Bx-V` 版本号与 UA 版本串是写死的常量（UA 平台段按本机编译目标分 windows/macos/linux 三套），Qoder 风控升级后需跟随 CodexBar 更新（依赖非公开接口的常规维护成本，ADR-0006 家族）。
- 依赖的都是只读 GET，无写操作，不涉及动作白名单问题；凭据失效表现为快照 `error` 并引导重贴 Cookie（ADR-0024 错误可见）。**2026-09-25 起端点从一个变三个**（汇总 + 明细 + 身份/热力图），维护面随之变大：官方改版时统计页可能整片失效，但它与卡片走不同端点，取数失败只表现为抽屉里的错误态，不会把常驻卡片一起拖下去。
- 统计页的时间范围档位与上限来自共享的 `statsRangePolicy`（ADR-0031 的「差异是数据不是分支」同一做法）：Qoder 给 366 天 / 默认近 30 天，其余四家沿用 30 天 / 近 7 天，行为与改造前逐字一致。30 天对 WorkBuddy 与 OpenCode Go 是**沿用的保守值而非实测上限**，将来要放开得先拿证据。
- 明细一次拉全（`page_size=1000`，防御上限 10 页 = 一万条）：重度账号一个周期几千条时首屏要等几页拉完，这是「图/卡/表同一批数据」的代价，实测 535 条一页就够。
- 第 5 个 `ProviderKind`（`qoder`）进入实例/快照/诊断的类型判别集合，连同凭据槽 `cookie` 与「站点」实例属性一起沿用既有扩展位，后续供应商照抄。
- 「凭据头只由鉴权分支注入」是头维度（发给谁，凭据头都只能有一条、且值来自凭据库），目标域名是目的地维度；后者对五个供应商同构、且要按种类收窄，故单独立 ADR-0032。
