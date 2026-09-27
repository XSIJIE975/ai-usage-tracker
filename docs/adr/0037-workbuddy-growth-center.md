# ADR-0037: WorkBuddy 成长中心——连登管家与例程层收敛

状态：已接受　日期：2026-09-27　关联：ADR-0029、ADR-0031、ADR-0034、ADR-0036

## 背景

成长任务落地（ADR-0036）后，WorkBuddy 的成长体系功能面分散在三处：Cookie/token 两条取数链各自手写「签到 → 旅行 → 余额+连登」的完整请求段（签到解析、幂等标记、能力位门控全是两份）；任务模块（workbuddy-tasks.ts）又有一套独立的通道上下文与域分流。参考项目 v1.11.7 在此期间新增了「连登管家」（补签 → 礼包/补偿 → 兑换 7/14/28 天档位 → 抽完抽奖次数，2026-09-12 成长中心 bundle 逆向 + 多账号实测）与「新手礼包/活动补偿」（/billing/meter/claim-gift、claim-compensation）——本项目连登词条当时明确「补签卡、礼包领取等其余活动接口不接入（ADR-0029）」，该边界需要修订。另据参考项目 v1.11.7：国际站账号有一次性「试用加油包」（POST /billing/ide/trial，国区无此端点，幂等码 14051）。

## 决策

1. **统一成长中心层**（`workbuddy-growth.ts`）：三层结构——通道上下文 `GrowthContext`（instance/channel/site/capabilities/account，域分流与头族内化）、原子操作（签到/旅行/连登完整状态/兑换/抽奖/补签/礼包/补偿/trial）、幂等例程（签到、旅行状态机、连登管家、trial）。Cookie/token 两条取数链瘦成同构薄壳（构造 ctx → 并行「余额主源 ‖ 成长例程包」→ 组装快照），任务动作（workbuddy-tasks.ts）换用同一 ctx，其严格口径（Cookie 通道必须有 account）由 `createTaskContext` 包装保留。通道与站点原语（能力位/域名/头族/信封工具/解析纯函数）下沉 `workbuddy-channel.ts` 保证依赖无环。此后新增成长接口只写一次。

2. **能力位扩容**：`butler`（国区 true）与 `trial`（国际站 true）进入 WorkbuddyCapabilities；国际站仍无签到/连登/旅行/任务。

3. **管家自动跟随刷新**：挂每天第一次刷新（签到同位置），不设独立开关。每步独立容错；**整轮无任何可重试失败才打当日标记**，半失败下轮刷新自动补跑（locked/claimed/无卡/无礼包都是幂等静默跳过，不重复发奖）。抽屉「立即运行管家」手动补跑走同一例程（同样写当日标记）。

4. **补签自动用卡是明示取舍**：补签卡是本轮闭环唯一消耗稀缺资源的动作（其余全部只进不出）。自动用卡的理由：官方设计用途就是补漏签，漏一天连登断掉要从第 1 天重攒 7 天，卡放着过期更亏；只补昨日（更早日期服务端拒绝，参考实测）；用卡事件进通知与行内记录，用户可感知。

5. **抽奖次数来自档位兑换，与喵喵旅行无关**：`GET /activity/growth/lottery/summary` 的 `module.enabled=false`（官方下线）时静默跳过；奖品载荷形状由活动期决定，提取链（prize_name → prize.name → name → title）落空给截断 JSON。

6. **通知按日汇总一条**：一轮闭环可能产生多个事件，系统通知至多一条——积分/能量合并成到账合计，正文按到账事实枚举（credit/energy>0 × 补签的组合，纯抽奖有奖的兜底报中性事实），档位/奖品/礼包明细只在成长中心抽屉行内记录。**手动补跑不发通知**（用户主动触发、结果行内即时可见；且手动跑写入当日标记后自动链当日不再跑，通知也不会重复）。通知判重事实源：Rust `workbuddy_growth_notices`（实例一行按日）、`workbuddy_trials`（实例一行一次性），与 checkins/travel_claims 同模式，delete_instance 级联清理。

7. **trial 随国际站取数尝试一次**：成功/已领（14051 措辞）/4xx 都进程内永久标记；网络/5xx 不标记下轮再试。领取成功只可能发生一次，重启后重试只会拿到幂等静默，因此不会重复通知。

8. **域分流沿用 ADR-0036 矩阵**：growth 域写动作（redeem/lottery/heatmap/makeup）Cookie→workbuddy.cn、token→copilot.tencent.com；礼包/补偿在 billing 域与签到同族（Cookie→workbuddy.cn、token→codebuddy.cn/v2）；trial 国际站两通道同域（workbuddy.ai，无 /v2）。

9. **明确不做**：开学季券码查询（活动已结束，用户裁决不做）；真实对话类任务自动化（ADR-0036 口径不变）；独立每日排程器（桌面端「取数即触发」已等效）；**Buddy 盲盒**（2026-09-27 用户裁决不做——纯装饰性抽宠物、不产出积分，且是消耗能量的娱乐性动作，与白名单哲学不合）。盲盒接口坐标留档备查（用户 2026-09-27 网页抓包，参考项目亦未实现）：`GET www.workbuddy.cn/activity/growth/buddy/quota` → `{affordable, balance, cost_per_open, max_open_count}`；`POST .../buddy/open` `{count}` → `results[]{instance{is_shiny,soul_desc,source:"gacha"}, template{name,personality,description,rarity,thumbnail_url,…}, is_first}`；能量来源=成长任务与连登兑换奖励。

## 真机验证清单（实施前置/上线前）

- [ ] `heatmap`/`makeup-cards/use`/`redeem`/`lottery/summary`/`lottery/draw` 五端点在 Cookie（workbuddy.cn）与 token（copilot.tencent.com）两通道的行为——同族推定自 travel/streak，未逐一实证
- [ ] `streak` 完整响应的 `next_tier`/`next_tier_remaining`/`makeup_cards`/`redemption_status` 字段形状（现口径只读过 days）
- [ ] `claim-gift`/`claim-compensation` 的「无礼包」业务错误形态（本实现按信封 code≠0 静默）
- [ ] 抽奖奖品载荷真实形状（提取链是否命中）
- [ ] `billing/ide/trial` 在 workbuddy.ai 域、Cookie 与 token 两通道的行为与响应形状

## 后果

取数链从两份重复实现收敛为一份例程库；新增活动接口的成本从「三处手写」降到「growth 层加一个原子操作+一个例程段」。代价：一次性的迁移风险（存量 493 测试已护航）、通知正文放弃逐事件明细（模板组合爆炸，明细归抽屉）、补签卡自动消耗需要用户知悉（通知/行内均可见）。
