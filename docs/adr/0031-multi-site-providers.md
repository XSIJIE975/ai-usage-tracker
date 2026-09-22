# 多站供应商：站点属性与按站能力表

Status: accepted

## Context

同一供应商存在两套互不相通的登录域这件事，先后出现在两家身上：Qoder 首发就是双站同发（国际站 qoder.com / 中国站 qoder.com.cn，ADR-0030 §1 把站点定为实例的显式属性），WorkBuddy 则是首发只做国区、把域名单抽成 `API_BASE` 常量位作为 realm 预留（ADR-0029 §5）。第二家要兑现预留时，机制已经该收敛成一份而不是各写各的——两处的语义完全相同：站点决定端点域名与 Origin/Referer，决定凭据从哪个域粘贴，也决定这一站有没有某个功能面。

WorkBuddy 国际站（workbuddy.ai）实测确认**没有**国区那套成长运营：签到、连登（activity/growth/streak）与喵喵旅行（activity/growth/buddy/travel）都不存在；用量页与消耗明细则与中国站同款。于是「站点之间的差异」暴露出两类，需要两种不同的表达方式：端点差异（换域名就能解决）与能力差异（本站根本没有这个功能面）。

## Decision

**站点是实例属性、按站取端点、按站声明能力、探测与刷新同法、站点差异先证再写。**

1. **站点是实例的显式属性，与种类解耦**：`ProviderInstance.site`（`china` / `international`）落在 `provider_instances.site` 列，`validate_site` 与 `InstancePatch.site` 都不认种类；存量行缺省 `china`。
2. **「哪些种类多站」只有一个判据**：`lib/instance.ts` 的 `providerSites(kind)` / `hasMultipleSites(kind)`。实例弹窗要不要出「站点」下拉、卡片与速览要不要出站点徽标，一律问它，不允许再出现 `kind === "xxx"` 的散判断。新增多站供应商只加一行。
3. **域名是凭据线索的一部分**：下拉标签与凭据获取文案按 (种类, 站点) 给（`InstanceDialog` 的 `SITE_PROFILES`），不并列两个域名——并列会让显式判站失去意义，用户照样会贴错域的凭据。
4. **站点差异分两处表达**：端点差异按站取（URL、Origin/Referer、请求体常量），能力差异按站声明布尔表（WorkBuddy 的 `checkin / streak / travel / stats`）。取数链、统计入口（`providerHasStats`）、告警面都读能力表，不各写各的 if。能力表是数据不是分支。
5. **探测与刷新同法同族**：`diagnose_request` 支持 `method` 与 `bodyText`（缺省仍是 GET，既有调用不受影响）。WorkBuddy 的探测从 `GET activity/growth/streak` 改为 `POST billing/meter/get-user-resource`，带与刷新链路同一份请求体与头——探测不再依赖一个本站未必存在的端点，判据也更硬（能取到套餐才算凭据有效）。
6. **站点差异未经真机确认前不写进常量**：国际站的请求体形态（要不要带目录码、浏览器多带的 `SlicePeriodStart/End` 与 `NeedInUsage`）先留空并让取数明确报错，等真机回放四变体（带码+Slice / 带码 / 去码 / 去码+NeedInUsage，结果完全一致：同 2 个套餐、周期总额 350）确认「目录码与 SlicePeriod 都不参与结果」后，才落成只发公共骨架的常量——顺带避开「SlicePeriod 写死某一天」的日期坑。宁可晚一步，也不拿国区目录码去打一次可能虚增余量的请求。

## Considered Options

- **国际站拆成独立 `ProviderKind`**：不动实例模型，但取数模块、图标、告警分支、统计抽屉、凭据槽全部复制一份；ADR-0029 §5 当初就选了「复用同一 provider 仅换域」。
- **给 WorkBuddy 另开 `realm` 列/字段**：与 qoder 的 `site` 语义当下完全重叠，多一列、多一条校验与 patch 链，换不来任何区分度。
- **内联 `if (site === "international")` 分支**：判断会散在取数链、告警、统计入口三处，背对背改容易漏（Qoder 的 `providerHasStats` 就是为了把这类判断收在一个出口）。
- **先按两站同构实现，真机报错再补**：最省事，但代价具体——国际站没有 activity 族，每轮刷新会白打三个接口，并把快照抹成 error 提示「登录凭据无效或已过期」，用户无法分辨是凭据坏了还是本站没这个功能。
- **国际站凭据形态另开一条（只贴 Cookie 值）**：若实测国际站网关不校验 UA 三元组，粘贴体验更轻。但形态一分叉，弹窗文案、白名单校验、诊断按钮、测试矩阵就变成 2×2；而 `curl_paste` 本就兼容只贴 Cookie 头与裸 session 值的降级形态，贴 cURL 在宽松网关下同样成功。统一形态的代价只是多贴一点东西。

## Consequences

- 第 6 家多站供应商的接入成本收敛成：`providerSites` 加一行 + 站点档案（域名与凭据文案）+ 端点/能力表按站填值。
- WorkBuddy 国际站已可正常取数（2026-09-22 真机确认响应结构与国区同构：`data.Response.Data.Accounts`、`CapacitySizePrecise` 下发字符串）。能力表按实测固定为 `checkin:false / streak:false / travel:false / stats:true`，取数链据此跳过三个接口——用例断言国际站一轮刷新恰好只发一个 `provider_request`，能力 false 分支由此覆盖。
- 目录码快照在两站都被实证可去（国区 53 个套餐的重度账号 + 国际站 2 个包的免费账号，四变体一条不差），`RESOURCE_BODY` 因此收敛成两站共用的单一骨架。这是「站点差异要先证再写」的直接收益：先按站各存一份的话，那份 11 个码的清单会作为国际站接入的副产品被复制一遍。
- 站点徽标占用标题行宽度：速览面板只有 320px 宽，徽标固定 `whitespace-nowrap` 且用短标签（英文 China / Intl）。
- 换站不自动清凭据：跨登录域必然 401，靠文案引导重贴（沿用 ADR-0030 的取舍）。
- 探测改 POST 后，`diagnose_request` 的入参面变大（method/bodyText/headers 三个可选参数）。它仍是「前端给 URL 与头、Rust 只管注入凭据」的同一套边界，没有把端点知识搬进后端。
- WorkBuddy 两站的消耗明细端点同款，统计抽屉对两站都开；若将来某站确认没有，`providerHasStats` 已按能力表收口，只需翻位。
