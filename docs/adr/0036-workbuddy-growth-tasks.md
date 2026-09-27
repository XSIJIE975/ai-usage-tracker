# WorkBuddy 成长任务:纯上报类的手动自动完成

Status: accepted

## Context

参考项目 linguo2625469/workbuddy2api-panel 的「任务中心」(克隆通读,`taskcenter.go` / `autotask.go` / `tasks.go` / `report.go`)实现了 WorkBuddy 成长体系任务的自动完成。机制核心:任务进度由服务端按**行为事件**计分,参考项目逆向了桌面客户端(`extName=workbuddy-desktop`)、web、小程序三种指纹的事件形状,**纯 API 上报即可点亮绝大多数任务**,无需真实打开客户端。四条接口:

- 任务列表 `GET copilot.tencent.com/v2/activity/growth/tasks`(growth 族,BillingHeaders,**带 /v2 前缀**——与 travel/streak 的无前缀不同)
- 接受任务 `POST /v2/activity/growth/tasks/accept`(幂等"报名")
- 行为事件上报 `POST codebuddy.cn/v2/report`(点亮判据;mp 口径叠加 `X-Client-Platform: miniprogram` 头,任务列表/accept/claim 同头)
- 领奖 `POST www.workbuddy.cn/activity/growth/tasks/{code}/claim`(web 域头族,幂等,already_claimed 不报错)

任务性质(用户澄清):成长任务是**一次性激励任务**(领养 Buddy、用模板建任务这类提升粘性的活动),做完即 claimed,不随日期重置,除非官方上新活动。少数是活动期链式(Sequential 链每日零点解锁一环)或窗口型(夜猫子限 23:00–08:00)。

本功能正面撞 ADR-0029 的两条既有边界:①动作白名单「只读 + 幂等签到 + 非消耗写」;②「只模拟 web 客户端特征」——伪造桌面/mp 指纹事件是「冒充客户端行为」,超出「以 web 身份调接口」。ADR-0029 拒绝的消耗性写(补签卡)与领取类(礼包)的理由不适用于本功能的领奖环节(幂等、积分只进不出),但**真实对话类任务**(expert 族/GLM-5.2/夜猫子,需真实 chat 拿服务端 requestId)会消耗真实积分,与「积分只进不出」直接冲突。

无凭据探测(2026-09-26,401=路由在/404=不在,ADR-0034 同款判别法):三端点路由全部存在——tasks 列表 401(copilot.tencent.com /v2 形态);report 空 body 返回业务层参数校验 `10001: eventCode is empty`(路由在且进入业务逻辑,对照不存在路径返回 APISIX `404 Route Not Found`);claim 401。四个出站域已在凭据目的地白名单(ADR-0032),无需扩白名单。

## Decision

**九条,经 grilling 会话逐条确认(2026-09-26):**

1. **修订 ADR-0029 的动作白名单与客户端特征边界**:纳入「纯上报类」任务自动化——以伪造行为事件点亮任务、无积分消耗、领奖幂等只进不出。**真实对话类 6 项(Model_chat_GLM5.2 / expert_5 / Expert_team_use_3 / Expert_lighthouse / skill_1 / black_cat)永不自动执行**:它们要消耗真实积分换任务奖励,收益与消耗可能倒挂,ADR-0029 排除补签卡的「消耗决策出错伤害资产」理由对它们仍然成立。风险定性:伪造事件上报与扫码登录/自动续期同属「个人账号的非官方自动化」,风控后果由用户承担;面板带一行风险提示文案。
2. **手动触发,不挂刷新链**:任务是一次性的,每日自动轮大部分天数空转,且一轮全量约 1~3 分钟、几十个请求会拖垮刷新链。不新增 DB 表、无每日判重——面板打开现拉列表(服务端 claimed 状态即事实源),执行结果仅面板内存态。
3. **展示口径三层**:可自动完成(纯上报类 15 项,带「执行」)/ 可领取(真实对话类**达标未领**时出现,只有「领取」无「执行」——把「自己真用过但忘领的奖励」兜住)/ 已完成(折叠)。不可自动化项(学生认证、捐款)与判据未验证项(Sequential_Tasks_4~7)永不显示——本工具是动手面板,不是任务百科。
4. **点亮即自动领奖**:「执行/一键完成」跑完点亮自动 claim,行内反馈到账分;达标准领态行单独给「领取」按钮。幂等安全(already_claimed 非错误)。
5. **任务面 15 项 = 默认口径 11 + mp 已验证 4**:默认口径 chat_5 / first_buddy / RichMeow_Chat / Buddy_App / Buddy_App_QQ / automation_1 / Library_read(web 域事件) / template_5 / playbook_prompt / create_canvas / Hp_Appearance;mp 口径 school_season + Sequential_Tasks_1/2/3(参考项目实测点亮,合计约 +2000 分)。mp 的实现增量:mp 头族常量、双列表拉取按 task_code 合并去重(mp 列表是默认口径超集)、accept 带回读验证(mp 有「200 OK 但未落账」形态)、claim 走 chat 域 mp 路径 400 时降级 web 域。Sequential_Tasks_4~7 判据在参考项目也只是预留,等其校正后再跟,不出现注定失败的行。
6. **两个有可见副作用的任务都做(用户拍板)**:Hp_Appearance 会真实切换账号主题(先调主题设置 API 设指定皮肤再上报事件才计分,用户可手动换回);first_buddy 会真实领养一只 Buddy 宠物(+300 分,与喵喵旅行同一宠物体系,无打扰)。
7. **双通道开放,以 spike 为闸门**:实施前 Cookie 通道真机验证三关(tasks 列表 → report 上报一次 chat_5 → claim 领奖/已领幂等响应),全过则双通道;任一关不过回退仅 token 通道(token 通道全链参考项目已证),Cookie 实例不显示任务入口(与无统计面隐藏入口同例)。**spike 已知前置疑点**:report 事件体必带 userId(=uid,缺失则服务端 200 但静默丢弃),Cookie 通道三格无 uid——spike 需一并确认 uid 的 Cookie 侧来源(资源接口响应或网页个人页)。**spike 结果(2026-09-26 用户真机)**:三关全过,双通道全开;uid 来源=网页控制台 `GET www.workbuddy.cn/console/account`(Cookie 会话配套,返回 uid+nickname,参考项目无此用法)。
   **上线后真机修正(同日)**:Cookie 通道执行任务报 401(HTML 形态)——桌面系 report 打的是 copilot.tencent.com/v2/report,该域 report 只被参考项目与 token 通道以 **Bearer** 实证过,Cookie 会话不被接受(spike 第二关实证的是 **codebuddy.cn** 域的 report 吃 Cookie 且计分)。修正:事件上报域按通道分流——Cookie 通道统走 codebuddy.cn/v2/report + web 头族(计分判据在事件体指纹字段,不在域),token 通道保持 copilot/workbuddy.cn + Bearer(参考项目实证);library_read 的 workbuddy.cn/v2/report + Cookie 同未验证,一并随分流走 codebuddy。
   **二次修正(同日,用户重验)**:Cookie 通道 mp 任务 accept 仍 401(响应头 `www-authenticate: Bearer realm="copilot"`)——规律收敛为 **copilot 域对 POST 一律要求 Bearer,GET 不拒**(列表 GET + Cookie 真机出数两例:spike 与日常使用;travel/streak 日常是 workbuddy.cn 无 /v2 + Cookie,不在 copilot)。修正:Cookie 通道全部 growth 写动作(accept/领养 agreement/first/mp claim/专家市场/主题 set)迁 **workbuddy.cn**(accept 无 /v2 与 travel/depart 同形态,路径存在性已无凭据探测确认;mp claim 直接走 web 域 claim——spike 第三关已证 Cookie 领奖,参考实现的 chat 域 400 降级 web 同款路径),token 通道保持 copilot + Bearer 全不动。无凭据探测只能证路由存在、证不了 Cookie 是否放行,workbuddy.cn 侧各写动作的最终确认依赖用户重验。
   教训(两条,后者更根本):**「域 A 的接口吃 Cookie」不能推及「同族接口在域 B 也吃 Cookie」**;**「域 B 吃 Cookie」也不能推及「域 B 的所有方法都吃」——按 (域, 方法) 二元组逐一实证,四元证据矩阵(域 × GET/POST)缺一格就要么探要么问**。
8. **UI:独立任务抽屉**:卡片新增「成长任务」入口(与「查看统计」并列,带待办数徽标),打开独立 Sheet(统计抽屉同规格);结构:汇总条(待办 x 项 · 预计可得分)+「一键完成」+ 三层分组列表;执行态行内 spinner→✓+到账徽章,一键完成时顶部进度 x/y;空态按空态文案规范;执行状态放 store,**关抽屉不中止**,重开可见结果。能力位 `tasks` 进站点表(国区 true / 国际站 false,checkin 门控同例)。
9. **架构零分叉**:前端编排(`workbuddy-tasks.ts`:动作表按依赖序——领养链在前、项间节流 ~1s(参考项目 reportGap 1050ms 口径)、回读有界轮询(服务端异步计分 5~8s)、达标即领);出站全走既有 `provider_request`(桌面/mp 指纹是事件体字段或一个请求头,前端拼好传入);Rust 零改动。i18n 中文即 key + en.ts 同步,诊断码四处同步。

## Considered Options

- **全自动挂刷新链(签到模式)**:一次性任务大部分天数全已完成,自动无意义;几十个伪造请求 1~3 分钟拖垮刷新链。否,手动触发。
- **含真实对话类**:消耗真实积分(expert 族要真实 chat 拿服务端 requestId),违背「积分只进不出」(旅行出发被纳入的核心理由)。否,永不自动执行——但达标后开放「仅领取」。
- **领奖分层自动化(点亮手动、领奖挂刷新链)**:把一个心智拆成两半(「为什么有的自动有的不自动」),且仍需刷新链判重。否。
- **mp 第一版不做**:少 +700 已验证分,mp 机制(纯上报换指纹)与默认口径同性质。用户要功能面,做已验证 4 项。
- **mp 全 8 项**:Tasks_4~7 判据未验证,执行后大概率「已上报但未点亮」,用户看到注定失败的行。否,等参考项目校正。
- **Hp_Appearance 砍掉(+100 分换打扰性副作用)**:用户拍板保留——副作用可接受(主题可手动换回),收益照拿。
- **参考项目的队列/并发/账号池锁/22 点排程**:多号网关的形态,单号工具全部用不上,整段砍。
- **全部任务显示并标注「需客户端手动完成」**:监控工具不是任务百科,官方客户端自己是百科,列表噪音不值。否。
- **执行历史落库**:任务状态以服务端为准,面板现拉即权威,本地留史是第二事实源,徒增维护。否,内存态。

## Consequences

- **正面**:一次性约 +2000 分收益;任务面板成为扫码通道的又一价值点;签到/旅行/任务三块成长动作面收敛在同一工具。
- **安全注记(2026-09-26 审查结论)**:①Cookie 通道 uid/nickname 进前端内存(console/account,10 分钟缓存)是**设计内例外**——uid 单独不构成认证凭据(Cookie 通道认证靠 session,本体每次由 Rust 注入),渲染进程被控时攻击者可直接冒用 session 通道,实质攻击面未扩大;uid 过与 token 通道同款字符集白名单。②mp 事件 machineId 为全体用户同一写死常量(照抄参考实现),上游风控可借此关联一批账号,属本 ADR 整体划给用户的风控面。
- **风险**:伪造事件的风控暴露面大于签到(单轮几十个请求、三种端指纹);由手动触发+面板风险提示承担解释权;参考项目同款节流(项间 ~1s)降低频次。
- **维护面**:15 项动作表与事件形状跟随上游活动改版(官方上新活动要补动作);mp 领奖双路径;report 事件形状是「照抄客户端完整形状」的负债(上游加严字段即失效)。
- **文档**:本 ADR 修订 ADR-0029 的 Decision 2(动作白名单)与 Decision 4(只模拟 web 客户端特征)——白名单纳入「纯上报类任务动作 + 任务领奖」,客户端特征边界扩至「可伪造桌面/mp 指纹的行为事件」;CONTEXT.md 新增「成长任务」「点亮」词条并修订「腾讯 WorkBuddy」功能面。
- **待验证**:①Cookie 通道 spike 三关(实施前,含 uid 来源疑点)②token 通道任务链本机真机(参考项目已证,接入后验)③mp 4 项本机点亮④Hp_Appearance 主题切换的到账链路(参考项目两账号已证)。
