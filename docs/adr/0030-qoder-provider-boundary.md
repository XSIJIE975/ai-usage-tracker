# Qoder 接入边界：双站 Cookie 粘贴与只读积分

Status: accepted

## Context

第五个供应商 Qoder（阿里的 AI IDE，本工具只读它的账号积分余量）没有公开 API，唯一已知的取数通道是账号控制台网页私有接口 `GET /api/v2/me/usages/big_model_credits`，凭网页 Cookie 调用，返回 `totalQuota.quotaSummary`（可带 `sharedQuota`）——已用/总量积分、已用百分比、`nextResetAt` 重置时间。没有请求级历史或 token 口径端点。社区先例 CodexBar（steipete/CodexBar，docs/qoder.md）验证了该通道，其要点：

- **双登录域**：国际站 `qoder.com` 与中国站 `qoder.com.cn` 是两套登录域，Cookie 不互通；裸 Cookie 头默认按国际站处理。
- **网关不绑定登录时 UA**：CodexBar 用硬编码 Chrome UA + 写死的 `Bx-V: 2.5.35`（Baxia 风控头）即可稳定取数——与 WorkBuddy「UA 必须与登录时逐字节相同」（ADR-0029）截然不同，凭据形态可以更简单。
- 401/403 即凭据失效；无其他动作类接口。

本工具侧，供应商架构已具备实例/凭据槽/快照/告警全套机制（ADR-0011），单百分比配额窗口的量纲映射与 OpenCode Go 同构。

## Decision

**接入边界四条：双站同发（站点是实例显式属性）、单个会话 Cookie 的值粘贴、只读单端点、积分量纲走既有配额窗口机制。**

1. **双站同发，站点为实例显式属性**：实例弹窗加「站点」下拉（中国站 qoder.com.cn 默认 / 国际站 qoder.com），请求时切换 URL 与 Origin/Referer。不从粘贴内容判站（CodexBar 靠 cURL 捕获里的 Host 猜站）——显式选择判站确定，粘贴门槛也更低。这套机制在 WorkBuddy 接入双站时泛化为多站供应商通则，见 ADR-0031。
2. **纯 Cookie 值粘贴，输入原样存储原样发送**：凭据槽 `cookie`，用户从浏览器 F12 复制 `Cookie:` 请求头的**值**（`key=value`，多对用 `key1=xxx; key2=xxx`）；不带前缀、不抠字段，前后端都不做归一化（与 WorkBuddy 的凭据口径一致：输入什么存什么，剥前缀这类「兼容」会造成回填值与粘贴值不一致）。凭据相关头在 Rust 端统一拼装——`raw_cookie` 通道原样注入 Cookie、UA 缺省按本机编译目标生成 Chrome 常量（UA 声称 Macintosh 而 TLS 指纹是 Windows/Linux 是风控最容易识别的不自洽；版本串与 `Bx-V: 2.5.35` 风控头一样写死，升级时跟随 CodexBar 更新），前端不碰凭据、只做字符集与形态白名单校验（可见 ASCII、拒 CR/LF 头注入、拒「Cookie:」前缀——违规直接报错让用户改输入，沿用 WorkBuddy 二次修订的口径）。Origin/Referer/X-Requested-With 等静态协议头与 WorkBuddy 的 `x-client-platform` 同先例、随端点定义在前端。凭据头与静态头的隔离**靠名字不靠顺序**：reqwest 的 `RequestBuilder::header` 内部是 `HeaderMap::append`（同名会并存两条、先到的那条被网关读到），所以「先铺静态头再注入凭据头」并不能让凭据赢——`provider_request` 与 `diagnose_request` 都按名字剔除调用方传来的 `Cookie` / `Authorization` / `User-Agent`（大小写无关），这三个头只可能由鉴权分支写入。白名单同样在探测与保存两处生效（`testQoderCookie` 与保存共用 `isValidQoderCookie`），Rust 侧 `raw_cookie` 再兜一次字符集，被外部改过的 vault 行也是明确报错而不是 reqwest 那句无指向的 builder 错误。刻意不复用 curl_paste.rs：那套「Copy as cURL 三元组同源」机制是为 WorkBuddy 的 UA 绑定网关设计的，Qoder 无此约束，让用户贴 cURL 是无谓的粘贴负担。若真机验证撞上 UA/指纹风控（见 Consequences），升级路径现成。**2026-09-23 二次修订（凭据=单个 Cookie 的值）**：真机验证只需 `qoder_session_cookie` 这一个键（其余 Cookie 不参与鉴权），故凭据槽 `cookie` 改存该键的**值**原文，`Cookie: qoder_session_cookie=<值>` 的拼装收敛进 Rust 的 `qoder_cookie` 通道——原 `raw_cookie`（整段 Cookie 头原样注入）随本次改口径退役，没有别的供应商在用，UA 常量随之更名 `QODER_DEFAULT_UA`。白名单同时从「整段 Cookie 头值（可见 ASCII）」收紧为「单个 cookie-value」：RFC 6265 的可见 ASCII 并排除空白、`"`、`,`、`;`，与 curl_paste 的 `validate_cookie_value`、前端 `providers/qoder.ts` 的 `isValidSessionCookieValue` 逐字符一致，另两条形态判定（`Cookie:` 前缀、连键名一起贴）只用于给错文案。仍然只判定不加工：不做「从整段 Cookie 里抠出该键」的兼容，理由与本条原文相同。代价是存量实例里那段整页 Cookie 过不了新校验，刷新时得到一句指明「只粘贴 qoder_session_cookie 的值」的报错而不是静默 401（ADR-0024 错误可见），用户重贴一次即恢复。
3. **只读，单端点，卡片即全部展示面**：仅调 big_model_credits 汇总端点。无统计页——没有历史/明细数据源可接（WorkBuddy 统计抽屉的前提 `get-user-request-usage` 在 Qoder 没有对应物）；亦无签到、旅行类动作面，刷新链是纯取数。卡片主行「已用/总量 积分」+ 重置倒计时行（有 `nextResetAt` 时），诊断按钮沿用先例（探测=同端点，401/403 不区分成因，统一引导重贴 Cookie）。
4. **积分量纲映射为单个百分比配额窗口**：主指标=已用百分比，阈值告警与额度耗尽照常，托盘用量环可绘制（百分比量纲）；`totalQuota` 与 `sharedQuota` 的 used/total/remaining 合并口径随 CodexBar，待真机数据校准。百分比一律按合并后的 `used/total` 本地计算，接口下发的 `usagePercentage` 不入模型（它的量纲是 0~100 还是 0~1 没有真机数据可证，猜错会让主指标、阈值告警、托盘环与耗尽告警同时静默失真）。展示面沿用 WorkBuddy 惯例：主行为进度行，速览的「账户余额」位承载积分余量数值（`balance` 标记选行），不代表金额量纲。没有金额量纲，不涉及主指标量纲回退（DeepSeek 余额那套不参与）。

## Considered Options

- **Copy as cURL 整串（WorkBuddy 同款）**：对潜在 UA/指纹风控更稳，但粘贴体验更重、帮助文案更长；CodexBar 硬编码 UA 的实证表明这层保险大概率用不上。留作撞风控时的升级路径而非起点。
- **两种粘贴都接受（Cookie 头或 cURL 捕获，CodexBar 手动模式同款）**：灵活但多一条解析路径要维护、测试矩阵翻倍；cURL 的判站优势已被显式下拉取代。
- **只做单站**：最省，但手上可验证的抓包只有自己用的那个站；双站的实现成本只是一个枚举分支，与 WorkBuddy 的 realm 预留（ADR-0029 §5）同构，只是这里两个 realm 都活。
- **统计页/明细侦察先行**：无已知端点，侦察成本前置且可能空手；若日后发现 Qoder 有请求历史接口，统计页按 WorkBuddy 模式二期补做，不阻塞本期。

## Consequences

- **真机验证项（唯一实质风险）**：CodexBar 的可行证据来自 macOS 端；中国站 Baxia 风控对 Windows + 不同 IP 段 + 写死 UA 的组合是否照单全收未验证。403 的出路是把凭据槽升级为 curl_paste 形态（带真实 UA），凭据库结构支持换槽不改架构。
- `sharedQuota` 的合并算法按 CodexBar 源码口径实现，合并后总量/已用的展示是否与官网控制台一致需真机数据校准；`nextResetAt` 缺失时的行为是隐藏倒计时行，不阻塞取数。
- `Bx-V` 版本号与 UA 版本串是写死的常量（UA 平台段按本机编译目标分 windows/macos/linux 三套），Qoder 风控升级后需跟随 CodexBar 更新（依赖非公开接口的常规维护成本，ADR-0006 家族）。
- 依赖端点仅一个只读族，无写操作，不涉及动作白名单问题；凭据失效表现为快照 `error` 并引导重贴 Cookie（ADR-0024 错误可见）。
- 第 5 个 `ProviderKind`（`qoder`）进入实例/快照/诊断的类型判别集合，连同凭据槽 `cookie` 与「站点」实例属性一起沿用既有扩展位，后续供应商照抄。
- 「凭据头只由鉴权分支注入」是头维度（发给谁，凭据头都只能有一条、且值来自凭据库），目标域名是目的地维度；后者对五个供应商同构、且要按种类收窄，故单独立 ADR-0032。
