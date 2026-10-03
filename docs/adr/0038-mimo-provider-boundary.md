# 小米 MiMo 接入边界：单站双 Cookie 与只读卡片

Status: accepted

## Context

第六个供应商小米 MiMo（Xiaomi MiMo 开放平台）。个人账号没有任何用量/额度 API，唯一已知的取数通道是控制台网页的私有接口，社区先例 CodexBar（steipete/CodexBar：`docs/mimo.md` + `Sources/CodexBarCore/Providers/MiMo/*`，2026-10-03 逐行核对）已经把它跑通：

- **三个只读 GET**，base `https://platform.xiaomimimo.com/api/v1`：`balance`（现金账户）、`tokenPlan/detail`（订阅与周期末）、`tokenPlan/usage`（本月额度）。全部同域同鉴权。
- **鉴权是控制台登录态**：`api-platform_serviceToken` 与 `userId` 两个 Cookie 必需，`api-platform_ph` / `api-platform_slh` 标注可选（缺了不报错）；静态头是 `Origin`/`Referer`/`Accept-Language`/`x-timeZone` 加一条硬编码 Chrome UA。
- **域名疑点已查清**：`platform.xiaomimimo.com` 与 `mimo.mi.com` 都代理同一套 `/api/v1`（裸探同为 401、同一网关 `MiFE/3.4.34`），而两个 401 的 `loginUrl` 都指向 `account.xiaomi.com/pass/serviceLogin?...&sid=api-platform`、STS 回调同为 `platform.xiaomimimo.com/sts`。也就是说这是**同一账号空间的两个前置域名**，不是两套互不相通的登录域。
- **真机形态（2026-10-03，一个未订阅 Token Plan 的账号，三份响应已原样落盘为 fixture）**：`balance` 回 `currency: "CNY"` 与 cash/gift/frozen/透支四五个拆分字段；`tokenPlan/detail` 的 `planCode`/`planName`/`currentPeriodEnd`/`expired` **全是 null**；`tokenPlan/usage` 的 `monthUsage.items` 是 **null 而不是空数组**，另有一个未证实形状的顶层 `usage` 字段。
- **CodexBar 有三处不能照抄**（它的实现是 macOS + 自己的解码器，这三条都是它那边的形状假设，不是 MiMo 的事实）：① `expired` 被解码成必填布尔——真机未订阅账号回 null，整个 detail 响应在它那边解码失败（它用 `try?` 吞成「无套餐信息」，症状与「官方没给」不可分）；② `currentPeriodEnd` 那个**无时区的挂钟串**按 UTC 解析；③ 只读 `monthUsage.items` 的第一项，多余项不显示。

本工具侧，双量纲（现金余额 + 订阅配额）的机制在智谱 GLM 上是现成的，Cookie 值分槽录入在 Qoder/WorkBuddy 上是现成的，一个池子一行的行模型在 Qoder（ADR-0030 §5）上是现成的——本次是三块既有机制的重组，不是新机制。

## Decision

**接入边界七条：单站、双格凭据、只读卡片、双轨阈值不写死币种、CST 解析周期末、按状态出行、无动作接口。**

1. **单站**：目的地白名单只登记 `platform.xiaomimimo.com`（CodexBar 实证可用、且登录态就种在这个域），`mimo.mi.com` **不登记**——同一账号空间的另一个前置域名不是「站点」，按 ADR-0031 的定义，站点是互不相通的登录域。因此 MiMo 不进 `PROVIDER_SITES`、实例弹窗不出站点下拉、端点表与站点档案都不引入。
2. **凭据两格、各存值原文**：槽 `serviceToken` 与 `userId`，新 `mimo_cookie` 通道在 Rust 端 `instances::mimo_cookies` 拼 `Cookie: api-platform_serviceToken=<值>; userId=<值>`，键名与拼装都不进前端。前端只过 RFC 6265 cookie-value 字符集白名单（拒 `Cookie:` 前缀、拒连键名一起贴、拒空白/引号/分号/换行/中文），**只判定不加工**；三处判定（qoder / workbuddy / mimo）共用 Rust 端一份 `is_cookie_value_chars`，前端各自的谓词逐字符同集。**UA 不占格**：网关不绑定登录时 UA（CodexBar 硬编码 Chrome UA 实证），后端按编译目标给 `MIMO_DEFAULT_UA` 常量，与 Qoder 同形。`x-timeZone` 发**本机真实偏移**（`UTC±hh:mm`），不照抄 CodexBar 写死的 `UTC+01:00`——自报一个假时区比不发更可疑，而它给不出依据。两格都是出数前提，缺哪一格就在 needs_config 里点名哪一格。
3. **只读，卡片即全部展示面**：三个端点全是 GET，无写操作、无动作接口；统计抽屉不做（明细端点零侦察，与 Qoder 首版同判断，日后拿到契约再补）。
4. **双轨阈值，币种不写死**：主指标 = Token Plan 已用百分比（既有 %阈值 / 额度耗尽 / 托盘环零改动沿用），百分比一律本地按 `used/limit` 算，下发的 `percent` 不参与判定（ADR-0030 §4 同一条精度理由）。账户余额是第二轨，走 **MiMo 自己的一条告警 arm**：金额按接口 `currency` 做 Intl 格式化（`¥1.00` / `US$12.34`），正文与阈值标签都**不写「元」**。GLM/DeepSeek 那两条 arm 的「{balance} 元」与「阈值（元）→ CNY」是人民币硬编码，套到 MiMo 上就是给非人民币账户写假话（真机是 CNY，社区样本是 USD，两家都活）。
5. **`currentPeriodEnd` 按 Asia/Shanghai 解析成绝对时刻**：那是服务端下发的数据属性，不是观察者的属性——用 `Date.parse` 的本地时区语义会让同一账号的重置时刻随用户笔记本时区漂移，按 UTC 解析（CodexBar）则恒早 8 小时。串里自带 `Z` 或 `±hh:mm` 时按它说的算，不再叠偏移。只认未来的时刻（过期与缺失同处理，隐藏倒计时那一格），解析失败不阻塞取数。**周期时长不下发也不猜**：不填 `windowPeriodMs`，托盘环层序回退快照顺序（CodexBar 的 fail-closed 决议同结论——它也不从剩余天数反推窗口）。
6. **按状态出行，一个状态只让一个控件说**：`planName ?? planCode` 出档位徽章（原词不翻译，同 ADR-0030 对 `operation` 的口径）；每个额度窗口一条进度行，**只有第一条带 `resetsAt`**（全响应只有一个周期末，`primaryProgressLine` 靠它选主指标行）；余额行带 `balance: true` 且排在最后。未订阅与已过期都走**中性事实行**（不出进度行 → 红条、倒计时、耗尽告警、满环都无从产生）：
   - 未订阅判据看 `planCode`/`planName` 是否为空，**不看 `monthUsage.percent`**——未订阅账号那个字段是 0，照它画就是一条 0% 的假进度。
   - 已过期优先于用量：过期套餐的 `used/limit` 是历史数字，画成进度等于给它挂一个「重置前不可用」的假承诺。
   - 额度源本轮失败时**不写**「暂无额度数据」——那是「取到了、只是没额度」，与「没取到」是两回事（中性事实行与错误快照的分工）。
   - 现金/赠送/冻结/透支四个拆分字段都不上卡片：余额行说的是接口 `balance` 字段本体，不折算「可用额」（冻结语义未证实），且 320px 速览里两行是安全上限。
7. **三路并行、部分失败可见**：`Promise.allSettled` 三个端点，任一源成功即出 ok 快照，失败源按 GLM 那套拼进 `message`（第 2 段起占位符加序号后缀，避免同名参数互相覆盖）；任一源回 401/403/登录页 HTML 则整卡判错误快照并指引重贴两格——三源同因，不拿另两源的成功数据拼半张卡。

## Considered Options

- **双站（`mimo.mi.com` / `platform.xiaomimimo.com` 各作一站）**：证据（同一 `sid=api-platform` 的 STS 会话、回调同域）说明这是同一账号空间，造两个站等于给同一账号伪造站点，还要拖进端点表、站点档案、按站能力表一整套分支。若将来出现只有 `mi.com` 侧才有的接口，再按 ADR-0031 的机制补。
- **一格贴整段 `Cookie:` 头**：Qoder 已把 `raw_cookie` 那条路退役（ADR-0030 二次修订），且它会静默收下别的站的 Cookie——目的地白名单只挡域名不挡内容。
- **Copy as cURL 整串**：WorkBuddy 为「UA 与登录时逐字节同源」才走上去，MiMo 网关无此约束（CodexBar 硬编码 UA 实证），要求用户理解请求导出格式是无谓的门槛。
- **只填一格 serviceToken**：上游把两个键都列为必需，「只带一个能不能过」目前没有证据。WorkBuddy 正是在没证据时先做单值、被网关二分实测打回、返工了三轮，所以这里从两格起步；若真机证实单格可过，砍掉 `userId` 格是有证据的收窄（改动面：删一槽、删一校验、拼串少一段）。
- **照抄 CodexBar 的 UTC 解析 / 只取 items.first / expired 必填布尔**：三条都拒。这是 ADR-0030 那条教训的第二次应用——上游项目做了什么 ≠ 上游项目证明了什么。
- **统计抽屉本期一起做**：明细端点一个都没侦察到，做不了；与 Qoder 首版同判断（后来是他 F12 拿到契约才补的）。
- **订阅管理面（自动续费、`autoRenewDiscount`、MiMo Claw 的 `clawEnabled`/`clawPeriodEnd`/`clawPurchased`）**：一律不读不显示。本工具是监控与提醒，续费开关与产品线状态是决策类信息，出错代价在用户的钱包上。
- **`total_quota` 式汇总位**：MiMo 没有实例级汇总端点，余额与额度是两个量纲各自成行，不做任何跨量纲合并。

## Consequences

- **订阅路径只有合成样本**：`__fixtures__/mimo-plan-detail-subscribed.json` 与 `mimo-plan-usage-subscribed.json` 按 CodexBar 解码器声明的字段形状构造，**未经真机证实**。因此以下四条都还是待证事项，真机响应到手可能要改：① `items` 是否多于 1 项（多于 1 就按 Qoder §5 一窗一行，本模块已经逐项出行，只是行序与主行选择要复核）；② `items[].name` 的原词（行名直接用它，官网叫什么就叫什么）；③ `used`/`limit` 的**单位**（积分？Token 数？请求数？目前只显示裸数字不带单位后缀）；④ `expired=false` 时 `currentPeriodEnd` 按 CST 换算后必须晚于当下——这条同时是 CST 基准的自检，若换算结果落在过去而 `expired` 又是 false，说明基准判错，改 `parseMimoPeriodEnd` 里那个偏移常量。
- 未订阅是**当前唯一有真机证据的形态**，它已经钉住三件事：`items` 会为 null、`expired` 会为 null、`percent` 会为 0。合成样本不能替真机说话，测试里凡涉及订阅态的断言都注明了这一点。
- 余额阈值与账户同币种，但输入框里没有币种提示（币种是接口下发的，配置时还没有数据）；hint 里写明了「按账户币种计量」。跨币种换算不做。
- 两格凭据任一失效即整卡报错（错误可见，ADR-0024），出路是重贴；`api-platform_ph` / `api-platform_slh` 那两个可选 Cookie 不登记成槽位——上游标注可选且实测缺了不影响取数，多两格就多两套「留空会怎样」的要解释。
- 依赖的都是非公开只读 GET，官方改版需跟随维护；`MIMO_DEFAULT_UA` 的 Chrome 版本串与 CodexBar 对齐，风控升级时跟随更新。
- 第 6 个 `ProviderKind`（`mimo`）进入实例/快照/诊断的类型判别集合；`ALLOWED_HOSTS` 从 11 个 host 变 12 个，`credential_label` 多两格，`provider_request` 与 `diagnose_request` 各多一条 `mimo_cookie` 分支（探测与刷新共用 `instances::mimo_cookies`，测得过即存得过）。
- 顺带收掉的一处旧缺陷：Cookie 值格式错误的文案原先按供应商各写一条，而探测路径上的 `invalid-credential-format` 只有一个码、只能显示一句话——WorkBuddy 用户贴错时会被提示「只粘贴 qoder_session_cookie 的值」。现在三家共用一条 `cookie_value` 码与一句语言中性的话，具体该复制哪个键回到字段的 placeholder 与取凭据指引里说。
