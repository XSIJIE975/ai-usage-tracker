export type ProviderKind = "deepseek" | "opencode-go" | "glm" | "workbuddy" | "qoder";

/** 供应商站点（ADR-0031）：同一供应商的两套登录域，Cookie/凭据不互通。
 *  哪些种类是多站，单一判据见 lib/instance.ts 的 providerSites */
export type ProviderSite = "china" | "international";

export interface ProviderInstance {
  id: string;
  providerId: ProviderKind;
  note: string;
  sortOrder: number;
  pinned: boolean;
  autoRefresh: boolean;
  /** DeepSeek=元，其余=已用百分比；null=不告警 */
  threshold: number | null;
  /** 余额告警阈值（元，低于触发）；仅 glm 使用，null=不告警 */
  balanceThreshold: number | null;
  /** 站点（仅多站种类有意义，单站种类一律忽略并按 china 处理） */
  site: ProviderSite;
  /** 扫码登录 token 自动续期（仅 workbuddy token 通道，ADR-0034）：默认开；关掉即
   *  token 用到失效为止、出路重扫 */
  tokenAutoRenew: boolean;
  createdAt: number;
}

/** 某实例已保存的凭据明文（凭据槽 → 值），仅含非空项 */
export type InstanceCredentials = Record<string, string>;
/** 某实例的凭据配置状态（凭据槽 → 是否已配置） */
export type InstanceCredentialStatus = Record<string, boolean>;

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  needsMigration: boolean;
  keychainLost: boolean;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface ProviderRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  bodyText?: string;
  /** "session_cookie"：从 vault 槽位读 session 的 Value，校验后拼作 Cookie: session=<值>（workbuddy）
   *  "workbuddy_token"：从 vault 槽位读扫码所得 accessToken/uid，注入 Bearer + billing UA + X-User-Id（ADR-0034）
   *  "qoder_cookie"：从 vault 槽位读 qoder_session_cookie 的 Value，校验后拼作 Cookie: qoder_session_cookie=<值>（qoder，ADR-0030） */
  auth?: "bearer" | "cookie" | "none" | "session_cookie" | "workbuddy_token" | "qoder_cookie";
  /** bearer/session_cookie/qoder_cookie 时的凭据槽；bearer 缺省用该种类的主鉴权键 */
  credentialSlot?: string;
}

/** workbuddy_qr_start 的返回（ADR-0034；无实例会话形态见 ADR-0035） */
export interface WorkbuddyQrStartResult {
  /** 浏览器授权链接（authUrl）：整段编码为二维码或复制打开，截断即「登录链接不完整」 */
  authUrl: string;
  /** 会话键（上游 state 本身）：后续 poll 与 claim 都用它，已在二维码里曝光非新增敏感面 */
  sessionKey: string;
}

/** workbuddy_qr_poll 的返回 */
export interface WorkbuddyQrPollResult {
  status: "pending" | "confirmed" | "expired";
  nickname?: string | null;
  /** token 有效期（epoch 毫秒）；confirmed 时非空 */
  expiresAtMs?: number | null;
}

export interface MetricLine {
  type: "progress" | "text" | "badge";
  label: string;
  /** label 模板的 {name} 占位符实参（如 "{hours} 小时请求配额" 的 hours），渲染端替换 */
  params?: Record<string, string | number>;
  value?: string;
  /** value 模板的 {name} 占位符实参（ADR-0022 同款通道，渲染端 renderLineValue 替换）。
      ISO 时刻串（YYYY-MM-DDT…）形态的参数值按界面语言格式化日期后替换（如到期日） */
  valueParams?: Record<string, string | number>;
  /** 账户余额/主数值行的结构化标记（速览余额位与 extractBalanceValue 按标记选行，
      不做文案数字启发式——模板化后文本解析不可靠，2026-09-21 曾把「1 天」连登行当余额） */
  balance?: boolean;
  used?: number;
  limit?: number;
  suffix?: string;
  percentUsed?: number;
  resetsAt?: string;
  /** 结构化窗口周期时长（毫秒，如 5h/周/月）；解析时已知，供环层序按周期短→长排位（ADR-0017）。
      与 resetsAt（下一重置时刻）是两个口径；缺失 = 周期未知，层序回退快照顺序 */
  windowPeriodMs?: number;
  color?: string;
}

export interface ProviderSnapshot {
  instanceId: string;
  providerId: ProviderKind;
  providerName: string;
  status: "ok" | "error" | "needs_config";
  updatedAt: number;
  /** 中文模板串（含 {placeholder}），渲染端 applyParams(t(message), messageParams) 翻译 */
  message?: string;
  /** message 模板的占位符实参 */
  messageParams?: Record<string, string | number>;
  lines: MetricLine[];
  /** 本轮在线的可用重置卡 recordId（仅智谱 fetch 填充；重置卡源失败时缺省=到账检测冻结、卡片不出入口）。
   *  供到账检测差集与卡片底部「重置卡」按钮的有无/张数用，落库属瞬时冗余，历史读回不参与检测 */
  availableResetIds?: { fiveHour: number[]; week: number[] };
  /** 本轮刷新实际执行且成功的签到（仅 WorkBuddy fetch 在本轮真的调了签到接口并拿到
   *  成功响应时填充）。落库属瞬时冗余、会随快照重放，通知判重权威在 Rust 端
   *  workbuddy_checkins 行（按 date 每天、按实例各一次）；错误快照也携带——签到与
   *  取数是两个源，取数失败不吞掉已发生的签到事件 */
  checkin?: { /** 签到当日（CST，YYYY-MM-DD），检测器据此判重 */
    date: string;
    /** 到账积分（接口未返回时为 0） */
    credited: number;
  };
  /** 本轮刷新真实领到的喵喵旅行奖励（仅 WorkBuddy fetch 本轮调 claim 拿到成功响应时填充）。
   *  同 checkin 属瞬时冗余，通知判重权威在 Rust 端 workbuddy_travel_claims 行（按行程
   *  depart_at 判重——一天可有多趟旅行）；错误快照也携带 */
  travel?: { /** 行程标识（depart_at，秒级 epoch 字符串化），检测器据此判重 */
    tripKey: string;
    /** 到账积分（接口未返回时为 0） */
    credited: number;
  };
  /** 本轮连登管家闭环发生的事件汇总（仅 WorkBuddy fetch 本轮真的跑了管家且发生事件时
   *  填充；ADR-0037）。落库属瞬时冗余、会随快照重放，通知判重权威在 Rust 端
   *  workbuddy_growth_notices 行（按 date 每日一条汇总通知）；错误快照也携带——
   *  管家与取数是不同源，取数失败不吞掉已发生的管家事件 */
  growthNotice?: {
    /** 闭环当日（CST，YYYY-MM-DD），检测器据此判重 */
    date: string;
    /** 本轮用补签卡补签的张数（0/1，只补昨日） */
    makeupUsed: number;
    /** 新手礼包到账积分（无则 0） */
    giftCredit: number;
    /** 活动补偿到账积分（无则 0） */
    compensationCredit: number;
    /** 本轮兑换的档位与奖励明细 */
    redeemed: {
      tier: string;
      credit: number;
      energy: number;
      cards: number;
      chances: number;
    }[];
    /** 抽奖奖品可读名（形状由活动期决定，提取失败为截断 JSON） */
    draws: string[];
  };
  /** 本轮真实领取的国际站试用加油包（仅 WorkBuddy fetch 国际站实例本轮领取成功时
   *  填充；ADR-0037）。一次性事件：领取成功只可能发生一次，重启后重试只会拿到
   *  幂等静默（14051），判重权威是 Rust 端 workbuddy_trials 行（实例级一行） */
  trial?: {
    /** 到账积分（端点未返回时为 0；加油包本体随余额套餐行出现） */
    credit: number;
  };
}

export interface StoredSnapshot {
  instance_id: string;
  captured_at: number;
  payload: ProviderSnapshot;
}

/** 重置卡已见集合（Rust 端 seen_reset_cards 行，字段 snake_case 与 StoredAlertState 同口径）；
 *  record_ids 是最近一轮在线的可用卡全集，seeded=false 表示从未播种（首刷播种不通知） */
export interface StoredSeenResetCards {
  instance_id: string;
  record_ids: number[];
  seeded: boolean;
}

/** WorkBuddy 签到通知判重行（Rust 端 workbuddy_checkins 表，字段 snake_case 同口径）；
 *  notified_date 是最近一次发出「签到成功」通知的日期（CST YYYY-MM-DD） */
export interface StoredWorkbuddyCheckin {
  instance_id: string;
  notified_date: string;
}

/** WorkBuddy 旅行领奖通知判重行（Rust 端 workbuddy_travel_claims 表）；claimed_key 是
 *  最近一次发出「旅行到账」通知的行程标识（depart_at）——按行程而非日期，一天多趟各判各的 */
export interface StoredWorkbuddyTravelClaim {
  instance_id: string;
  claimed_key: string;
}

/** WorkBuddy 管家通知判重行（Rust 端 workbuddy_growth_notices 表）；notified_date 是
 *  最近一次发出「成长中心管家」汇总通知的日期（CST YYYY-MM-DD）——管家一轮可能产生
 *  补签/礼包/兑换/抽奖多个事件，通知按日汇总为一条。
 *  detail_json 是那一轮的到账明细（ButlerRecordDetail 的 JSON，档位/奖品/礼包逐条），
 *  供成长中心抽屉显示「最近一次领取」——快照上的 growthNotice 会被下轮刷新覆盖，
 *  判重行才是留档处 */
export interface StoredWorkbuddyGrowthNotice {
  instance_id: string;
  notified_date: string;
  detail_json?: string | null;
}

/** WorkBuddy 试用加油包通知判重行（Rust 端 workbuddy_trials 表）——一次性事件，
 *  实例级一行即够（重启后快照重放同一次领取不再重复通知） */
export interface StoredWorkbuddyTrial {
  instance_id: string;
  claimed: boolean;
}

export interface AppSettings {
  refreshEnabled: boolean;
  refreshIntervalMinutes: number;
  /** 用量告警总开关 */
  alertsEnabled: boolean;
  /** 告警冷却（ADR-0025）：同一规则两次通知的最小间隔（小时），0=关闭冷却；事实源在 Rust 端 */
  alertCooldownHours: number;
  /** 快速面板全局快捷键（规范格式，如 "Alt+KeyU"；空字符串表示不启用） */
  quickPanelShortcut: string;
  /** 快速面板失焦自动隐藏 */
  quickAutoHide: boolean;
  /** 卡片重置时间的展示：relative 倒计时 / absolute 具体时刻 */
  resetTimeDisplay: "relative" | "absolute";
  /** 界面语言：auto 按系统语言检测（中文→中文，否则英文） */
  interfaceLanguage: "auto" | "zh" | "en";
  /** 开机自启：随系统登录自动运行程序 */
  autoStart: boolean;
  /** 静默启动：仅自启路径生效（ADR-0015），关闭自启时复位为关 */
  silentStart: boolean;
  /** 托盘图标呈现方案（ADR-0016）：default 默认图标 / usage-ring 环形计量 / usage-bars 条形计量 */
  trayIconScheme: "default" | "usage-ring" | "usage-bars";
  /** 计量方案（环/柱）展示的实例；空 = 自动展示最紧实例 */
  trayPinnedInstanceId: string;
  /** 速览面板展示形态：list 紧凑行列表 / cards 迷你卡片 */
  glanceLayout: "list" | "cards";
  /** 速览面板实例范围：all 全部 / custom 自选（配合 glanceInstanceIds） */
  glanceInstanceScope: "all" | "custom";
  /** 自选实例列表（scope 为 custom 时生效） */
  glanceInstanceIds: string[];
}

export interface StoredNotification {
  id: number;
  created_at: number;
  instance_id: string;
  /** 中文模板（含 {占位符}），渲染层经 renderTemplate 翻译（ADR-0022）；
   *  存量行是旧版成品文案、无 params，原样显示 */
  title: string;
  body: string;
  params?: Record<string, string | number> | null;
  read: boolean;
}

/** 一条告警规则的持久化状态（ADR-0025）：边沿触发与冷却的事实源在 Rust 端，
 *  评估窗口启动/重载后据此水合；字段 snake_case 与 StoredNotification 同口径 */
export interface StoredAlertState {
  rule_key: string;
  instance_id: string;
  triggered: boolean;
  last_notified_at: number;
}
