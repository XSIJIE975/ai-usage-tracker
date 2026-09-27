import type {
  HttpResult,
  InstanceCredentialStatus,
  MetricLine,
  ProviderSite,
} from "../types/ipc";

// WorkBuddy 通道与站点原语（ADR-0037 从 workbuddy.ts 下沉）：站点能力位、双通道的
// 域名/URL/头族装配、通道判定与信封工具。取数链（workbuddy.ts）、成长中心例程
// （workbuddy-growth.ts）、任务动作（workbuddy-tasks.ts）三方共用这一份——依赖必须
// 无环，这里只允许 import types/ipc。
//
// 端点与响应结构依据两个社区实现的交叉验证 + 用户浏览器实测请求（2026-09-21，
// 非公开 web 接口、随官方改版需跟随维护，接入边界见 ADR-0029）：
// - Sliverkiss/workbuddy2api internal/upstream/client.go 与 wwenc6621/CodeBuddy-Usage
//   src/extension.ts 揭示了接口族与响应形态；
// - 用户从 workbuddy.cn 抓包证实：**网页端不用 Bearer JWT，身份是 Cookie 会话**。
// - 网关放行的是 (session, session_2, 登录时 UA) 三元组，缺一即 401：只发 session
//   被 APISIX 拒，UA 改一位（`Edg/153.0.0.0`→`153.0.0.1`）同一有效 Cookie 也被拒。
//   所以凭据按值分三槽存（session / session2 / userAgent，都是用户填的原文），
//   **Cookie 与 UA 两个头都由 Rust 端拼装注入**（instances::workbuddy_session），
//   前端既不出 UA 也不拼 Cookie 头。

/** 三域基址（Cookie 通道的国区 web 面；token 通道的国区 billing/growth 域见 TOKEN_SITES）：
 *  WEB=workbuddy.cn（成长中心 web 面）、BILLING=codebuddy.cn（计费与事件上报）、
 *  GROWTH=copilot.tencent.com（token 通道成长域 + 任务列表） */
export const WEB_ORIGIN = "https://www.workbuddy.cn";
export const BILLING_ORIGIN = "https://www.codebuddy.cn";
export const GROWTH_ORIGIN = "https://copilot.tencent.com";

/** 单个 Cookie 值的字符集（RFC 6265 cookie-value：可见 ASCII，排除空白、`"`、`,`、`;`）。
 *  与 Rust 端 `instances::validate_cookie_value` 逐字符一致——保存与探测共用这一份判定，
 *  三处（这里、Rust 端、qoder 的同款）任一处收紧都会误伤真机凭据 */
const COOKIE_VALUE_CHARS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x7e]+$/;
/** UA 的字节域：纯可见 ASCII（挡换行头注入与非 ASCII 误粘），上限照 Rust 端的 512 */
const USER_AGENT_CHARS = /^[\x20-\x7e]+$/;
/** 实测 session 近 4000 字符、session_2 近 2000 字符，上限照 Rust 端的 65536 */
const MAX_COOKIE_VALUE_LENGTH = 65_536;
const MAX_USER_AGENT_LENGTH = 512;

/** session / session_2 两格的输入判定：只接受 Cookie 的**值**本体，键名与 Cookie 头由
 *  Rust 端拼（instances::workbuddy_session）。整段 Cookie 头必带 `;` 与空格，正好落在这道
 *  拒绝里；只判定不加工，存进去的就是用户贴的那段值 */
export function isValidCookiePartValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_COOKIE_VALUE_LENGTH) return false;
  // 连键名一起贴、或整段 Cookie 头贴进来，都在这里拒掉（分号与空格本就不在字符集内，
  // 键名前缀是它们唯一的漏网形态）。只拒这一种误输入，不改写用户贴的内容
  const lower = value.toLowerCase();
  if (lower.startsWith("cookie:") || lower.startsWith("session=") || lower.startsWith("session_2="))
    return false;
  return COOKIE_VALUE_CHARS.test(value);
}

/** User-Agent 格的输入判定：不带「User-Agent:」前缀、单行可见 ASCII。
 *  这一格没有兜底值——UA 必须与登录时逐字节相同（ADR-0029），所以宁可拒也不猜 */
export function isValidUserAgentValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_USER_AGENT_LENGTH) return false;
  if (value.toLowerCase().startsWith("user-agent:")) return false;
  return USER_AGENT_CHARS.test(value);
}

/** 按站能力位（ADR-0031）：国际站没有国区这套成长运营，取数链据此跳过对应请求——
 *  不发注定失败的调用，也就不会把「本站没这个功能」误报成「凭据失效」 */
export interface WorkbuddyCapabilities {
  /** 每日签到（billing/meter/daily-checkin） */
  checkin: boolean;
  /** 连登天数（activity/growth/streak） */
  streak: boolean;
  /** 喵喵旅行领奖与出发（activity/growth/buddy/travel） */
  travel: boolean;
  /** 消耗明细统计页（billing/meter/get-user-request-usage） */
  stats: boolean;
  /** 成长任务面板与自动完成（growth tasks 族，ADR-0036）——国区成长体系专属 */
  tasks: boolean;
  /** 连登管家：兑换/抽奖/补签/礼包（activity/growth 的 redeem/lottery/heatmap 族 +
   *  billing/meter 的 claim-gift/claim-compensation，ADR-0037）——国区专属 */
  butler: boolean;
  /** 国际站试用加油包（billing/ide/trial，仅国际站下发此端点，ADR-0037） */
  trial: boolean;
}

interface WorkbuddySiteConfig {
  origin: string;
  capabilities: WorkbuddyCapabilities;
}

/** 实例的取数站点：site 缺失/未知值回退中国站（与 qoder 同口径） */
export function workbuddySiteOf(instance: Pick<ProviderInstanceSite, "site">): ProviderSite {
  return instance.site === "international" ? "international" : "china";
}

/** 只用到 site 字段的实例投影（避免 import ProviderInstance 造成与 types 的耦合放大） */
export type ProviderInstanceSite = { site: ProviderSite };

/** get-user-resource 请求体（两站共用）：ProductCode/Status/OnlyValidPeriod 与两个社区实现
 *  对齐——workbuddy2api client.go 与 CodeBuddy-Usage extension.ts 都发 Status:[0,3]（状态 3
 *  的周期进行中套餐会被 [0] 滤掉而少算余量），并用 OnlyValidPeriod 让服务端滤掉已过期套餐
 *  （防作废积分虚增余量、阈值告警失明）。
 *  刻意不带网页抓包里的 PackageCodes 快照与 NeedInUsage：2026-09-22 两站真机回放四变体
 *  （带码+SlicePeriod / 带码 / 去码 / 去码+NeedInUsage）结果完全一致——国区 53 个套餐、
 *  周期总额 4394，国际站 2 个、350，四个变体一条不差。目录码不参与结果，留着它只是
 *  一份要跟随官方扩目录维护的清单（ADR-0029 §2 的备选方案就此落地） */
export const RESOURCE_BODY = JSON.stringify({
  PageNumber: 1,
  PageSize: 200,
  ProductCode: "p_tcaca",
  Status: [0, 3],
  OnlyValidPeriod: true,
});

const SITES: Record<ProviderSite, WorkbuddySiteConfig> = {
  china: {
    origin: "https://www.workbuddy.cn",
    // 国区四件套 2026-09-21 实测在用（ADR-0029）；成长任务同属国区成长体系（ADR-0036）；
    // 连登管家与 trial 分属国区/国际站的运营福利（ADR-0037）
    capabilities: {
      checkin: true,
      streak: true,
      travel: true,
      stats: true,
      tasks: true,
      butler: true,
      trial: false,
    },
  },
  international: {
    origin: "https://www.workbuddy.ai",
    // 2026-09-22 真机确认：国际站没有签到与成长中心（连登、喵喵旅行、成长任务都不存在）；
    // 用量页与中国站同款，消耗明细按同族端点接入。trial 是国际站专属端点（ADR-0037）
    capabilities: {
      checkin: false,
      streak: false,
      travel: false,
      stats: true,
      tasks: false,
      butler: false,
      trial: true,
    },
  },
};

/** 一站的取数面：URL、请求头与能力位。路径与请求体两站同构（2026-09-22 真机确认），
 *  实测出差异再拆进站点配置 */
export interface WorkbuddyApi {
  origin: string;
  resourceBody: string;
  capabilities: WorkbuddyCapabilities;
  /** growth 族基址（Cookie 通道即本站 origin；旅行/连登/兑换/抽奖都拼在其后） */
  growthBase: string;
  /** billing/meter 族基址（签到/礼包/补偿） */
  meterBase: string;
  /** billing/ide 族基址（trial） */
  ideBase: string;
  urls: {
    resource: string;
    checkin: string;
    streak: string;
    travel: string;
    usage: string;
  };
  headers: {
    billing: Record<string, string>;
    activity: Record<string, string>;
    travel: Record<string, string>;
  };
}

export function workbuddyApi(site: ProviderSite): WorkbuddyApi {
  const config = SITES[site];
  const origin = config.origin;
  /** billing 族（余额/签到）请求头：referer 对应官网「套餐用量」页（Cookie 与 UA 头由
   *  Rust 端按凭据解析结果注入）；Content-Type 显式带上（Rust 端 body() 不自动补，
   *  两个社区实现均显式声明） */
  const billingHeaders: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: origin,
    Referer: `${origin}/profile/plans-usage`,
    "x-client-platform": "web",
  };
  /** activity 族（连登/旅行）请求头：referer 对应官网「成长中心」页 */
  const activityHeaders: Record<string, string> = {
    Accept: "application/json",
    Origin: origin,
    Referer: `${origin}/profile/growth-center`,
    "x-client-platform": "web",
  };
  return {
    origin,
    resourceBody: RESOURCE_BODY,
    capabilities: config.capabilities,
    growthBase: origin,
    meterBase: `${origin}/billing/meter`,
    ideBase: `${origin}/billing/ide`,
    urls: {
      resource: `${origin}/billing/meter/get-user-resource`,
      checkin: `${origin}/billing/meter/daily-checkin`,
      streak: `${origin}/activity/growth/streak`,
      travel: `${origin}/activity/growth/buddy/travel`,
      usage: `${origin}/billing/meter/get-user-request-usage`,
    },
    headers: {
      billing: billingHeaders,
      activity: activityHeaders,
      /** 旅行接口（CodeBuddy-Usage buddyHeaders 同款）带 Content-Type：depart/claim 是 JSON POST */
      travel: { ...activityHeaders, "Content-Type": "application/json" },
    },
  };
}

export interface WorkbuddyEnvelope<T> {
  /** 业务码：0/200 成功；10001/14001 当日已签；措辞类错误看 msg */
  code?: number | string;
  msg?: string;
  success?: boolean;
  data?: T;
}

/** 封套成功判定：业务码 0/200；无业务码时按 success 缺省成功处理（activity 族可能不带 code） */
export function isEnvelopeOk(json: WorkbuddyEnvelope<unknown>): boolean {
  const code = json.code == null ? "" : String(json.code);
  if (code) return code === "0" || code === "200";
  return json.success !== false;
}

// ─── token 通道（扫码登录，ADR-0034）───
// 端点与静态头族：billing 族的 Bearer / billing UA / X-User-Id 三个凭据衍生头由
// Rust 端 provider_request 的 workbuddy_token 分支注入（uid 在 vault 里，前端只见
// 槽位布尔拿不到明文），这里只带静态协议头。头族组合 2026-09-26 spike 真机验证：
// 中国站 www.codebuddy.cn 走 /v2 前缀放行；国际站 Bearer 通道路径形态未证，按参考
// 实现「先无 /v2、404 回落 /v2」双试（client.go 双试同序）

interface WorkbuddyTokenSiteConfig {
  billingOrigin: string;
  billingPrefix: string;
  /** growth 族（旅行/连登）所在域：参考项目 growthJSON = chatBase + path，不带 /v2 前缀
   *  （travel.go/streak.go 实测组合；路径与 Cookie 通道逐字相同，已对表 2026-09-26） */
  growthOrigin: string;
  origin: string;
  xDomain: string;
  acceptLanguage: string;
}

const TOKEN_SITES: Record<ProviderSite, WorkbuddyTokenSiteConfig> = {
  china: {
    billingOrigin: "https://www.codebuddy.cn",
    billingPrefix: "/v2",
    growthOrigin: "https://copilot.tencent.com",
    origin: "https://www.codebuddy.cn",
    xDomain: "www.codebuddy.cn",
    acceptLanguage: "zh-CN",
  },
  international: {
    billingOrigin: "https://www.workbuddy.ai",
    billingPrefix: "",
    // 国际站无成长中心（连登/旅行不存在，能力位门控），growth 域不会被请求，仅占位
    growthOrigin: "https://www.workbuddy.ai",
    origin: "https://www.workbuddy.ai",
    xDomain: "www.workbuddy.ai",
    acceptLanguage: "en-US",
  },
};

export interface WorkbuddyTokenApi {
  /** growth 族基址（copilot.tencent.com / workbuddy.ai；旅行/连登/兑换/抽奖拼在其后，
   *  无 /v2 前缀——travel.go/streak.go 实测组合） */
  growthBase: string;
  /** billing/meter 族基址（签到/礼包/补偿；含 /v2 前缀——国区实测） */
  meterBase: string;
  /** billing/ide 族基址（trial） */
  ideBase: string;
  urls: {
    resource: string;
    /** 国际站 404 回落用的 /v2 备选路径；中国站已证 /v2 无需备选 */
    resourceAlt: string | null;
    checkin: string;
    /** 旅行状态机基址（/status /depart /claim 拼在其后）与连登查询 */
    travel: string;
    streak: string;
    /** 统计明细：路由实测（2026-09-26 无凭据探测）不在 /v2 前缀下——/v2 前缀 404
     *  Route Not Found，无前缀 /billing/meter/ 在 codebuddy.cn / copilot.tencent.com /
     *  workbuddy.ai 三域全 401（路由存在待认证）。首选 billing 域无前缀 */
    usage: string;
    /** 中国站备选 = growth 域同路径（探测同样 401）；国际站 = /v2 回落 */
    usageAlt: string | null;
  };
  headers: {
    /** billing 族静态协议头（凭据衍生头由 Rust 注入，见文件头注释） */
    billing: Record<string, string>;
    /** growth 族静态头：参考 BillingHeaders 组合不带 Origin/Referer（travel.go growthJSON
     *  同款）；凭据衍生头（Bearer/UA/X-User-Id/企业头）同样由 Rust 注入 */
    growth: Record<string, string>;
  };
}

export function workbuddyTokenApi(site: ProviderSite): WorkbuddyTokenApi {
  const config = TOKEN_SITES[site];
  const billingPath = (prefix: string) => `${config.billingOrigin}${prefix}/billing/meter`;
  return {
    growthBase: config.growthOrigin,
    meterBase: billingPath(config.billingPrefix),
    ideBase: `${config.billingOrigin}${config.billingPrefix}/billing/ide`,
    urls: {
      resource: `${billingPath(config.billingPrefix)}/get-user-resource`,
      resourceAlt:
        site === "international"
          ? `${billingPath("/v2")}/get-user-resource`
          : null,
      checkin: `${billingPath(config.billingPrefix)}/daily-checkin`,
      travel: `${config.growthOrigin}/activity/growth/buddy/travel`,
      streak: `${config.growthOrigin}/activity/growth/streak`,
      usage: `${config.billingOrigin}/billing/meter/get-user-request-usage`,
      usageAlt:
        site === "international"
          ? `${config.billingOrigin}/v2/billing/meter/get-user-request-usage`
          : `${config.growthOrigin}/billing/meter/get-user-request-usage`,
    },
    headers: {
      billing: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: config.origin,
        Referer: `${config.origin}/`,
        "X-CodeBuddy-Request": "1",
        "Accept-Language": config.acceptLanguage,
        "X-Domain": config.xDomain,
      },
      growth: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CodeBuddy-Request": "1",
        "Accept-Language": config.acceptLanguage,
        "X-Domain": config.xDomain,
      },
    },
  };
}

/** token 通道的失效文案：重扫或切换登录方式为 Cookie 登录——不静默换通道（ADR-0024） */
export const WORKBUDDY_TOKEN_EXPIRED_MESSAGE =
  "WorkBuddy 扫码登录已失效（可能与官方客户端登录互踢），请重新扫码；或在配置中改用 Cookie 登录";

/** 两边都没凭据的指引（卡片与统计页同款）：扫码是主推（免 F12），Cookie 登录是另一极（ADR-0035） */
export const WORKBUDDY_NEEDS_CONFIG_MESSAGE =
  "请在设置中扫码登录 WorkBuddy，或填写 Cookie 凭据";

/** 通道判定（ADR-0035 互斥模型下的确定性读出）：accessToken 槽非空即 token 通道；
 *  三格齐走 Cookie 通道；两者都缺返回 null（needs_config，文案同时给出两种出路） */
export function resolveWorkbuddyChannel(
  status: InstanceCredentialStatus,
): "token" | "cookie" | null {
  if (status.accessToken) return "token";
  if (status.session && status.session2 && status.userAgent) return "cookie";
  return null;
}

/** 签到日界按服务端时区 CST（UTC+8 固定无夏令时）计算 YYYY-MM-DD */
export function cstDateString(atMs: number = Date.now()): string {
  return new Date(atMs + 8 * 3_600_000).toISOString().slice(0, 10);
}

// ─── 响应数据形状与解析（ADR-0037 自 workbuddy.ts 下沉：取数链与成长例程共用，
//  纯函数无 invoke 依赖）───

/** 数值字段统一转数值（Precise 系整数是 number、小数可能是字符串） */
export function toCount(raw: number | string | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** GET /activity/growth/streak 的 data（2026-09-21 实测 + 参考项目 StreakFull 对表
 *  2026-09-26：同响应带连登完整状态、补签卡与兑换档位——旧口径只读 days） */
export interface WorkbuddyStreakFullData {
  streak?: {
    days?: number;
    month_total_days?: number;
    /** 下一档位（"7d"/"14d"/"28d" 形态，参考项目 StreakFull.NextTier） */
    next_tier?: string;
    /** 距下一档还差几天（正数=尚未解锁下一档） */
    next_tier_remaining?: number;
  };
  makeup_cards?: {
    balance?: number;
    max?: number;
  };
  redemption_status?: {
    tier_7d_status?: string;
    tier_14d_status?: string;
    tier_28d_status?: string;
    remaining_days?: number;
    tiers?: {
      tier?: string;
      days?: number;
      credit?: number;
      energy?: number;
      cards?: number;
      chances?: number;
    }[];
  };
}

/** travel/status 的 data（2026-09-21 用户实测；字段名服务端 snake_case 原样）。
 *  state：idle（空闲）/ traveling（在途）/ arrived（到站待领） */
export interface WorkbuddyTravelStatus {
  state?: string;
  /** 行程标识：本次旅行的出发/到达时刻（秒级 epoch）与到站记录 id */
  depart_at?: number;
  arrive_at?: number;
  record_id?: number;
  /** 今日派出名额已用尽（服务端按 CST 自然日重置，workbuddy2api 同口径） */
  daily_limit_reached?: boolean;
  /** 到站可领奖励（status 实测有值；CodeBuddy-Usage 旧版恒 0，仅作展示参考不作判据） */
  reward_credit?: number;
  location?: { name?: string };
}

/** 连登档位门槛（成长中心 7/14/28 天档，ADR-0037）。距档天数**纯本地计算**：
 *  streak 响应里的 next_tier/next_tier_remaining 语义无实证（参考项目声明了字段但
 *  从不消费，2026-09-27 真机对表发现直译「距下一档天数」与服务端口径不符），弃用 */
export const TIER_THRESHOLDS = [7, 14, 28] as const;

/** 距下一档还差几天：days=1 → 6（距 7 天档）；days≥28 → null（全档已解锁） */
export function nextTierGap(days: number): { tier: number; gap: number } | null {
  const next = TIER_THRESHOLDS.find((threshold) => threshold > days);
  return next === undefined ? null : { tier: next, gap: next - days };
}

/** 连登卡片行：天数 + 距下一档尾巴（本地计算，不依赖服务端 next_tier 字段） */
export function parseStreakLine(data: WorkbuddyStreakFullData | undefined): MetricLine | null {
  const days = data?.streak?.days;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return null;
  const next = nextTierGap(days);
  if (next) {
    return {
      type: "text",
      label: "连登",
      value: "{days} 天 · 距 {tier} 天档还差 {gap} 天",
      valueParams: { days, tier: next.tier, gap: next.gap },
    };
  }
  return { type: "text", label: "连登", value: "{days} 天", valueParams: { days } };
}

/** 旅行中卡片行：目的地 + 预计回来时刻（本地墙钟，快照采样定格）。到站/空闲不出行——
 *  领奖结果走通知（检测器），不出常驻行 */
export function parseTravelLine(data: WorkbuddyTravelStatus | null | undefined): MetricLine | null {
  if (!data || data.state !== "traveling") return null;
  const place = data.location?.name?.trim();
  let backAt: string | undefined;
  if (typeof data.arrive_at === "number" && Number.isFinite(data.arrive_at) && data.arrive_at > 0) {
    const at = new Date(data.arrive_at * 1000);
    if (!Number.isNaN(at.getTime())) {
      const pad = (n: number) => String(n).padStart(2, "0");
      backAt = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }
  }
  const valueParams: Record<string, string> = {};
  if (place) valueParams.place = place;
  if (backAt) valueParams.backAt = backAt;
  const value =
    place && backAt
      ? "旅行中 · {place} · {backAt} 回来"
      : place
        ? "旅行中 · {place}"
        : backAt
          ? "旅行中 · {backAt} 回来"
          : "旅行中";
  return {
    type: "text",
    label: "喵喵旅行",
    value,
    valueParams: Object.keys(valueParams).length > 0 ? valueParams : undefined,
  };
}

/** 签到响应的归一化结果：done=本轮新签成功（带到账积分）；already=已签或账号无签到体系
 *  （当日不再重试）；fail=可重试失败（网络/解析层，不设标记下轮再试）。
 *  判定顺序与参考项目同序（workbuddy2api checkinStatusOf / CodeBuddy-Usage doCheckin）：
 *  成功是最强信号先判，再查幂等信号。注意「今日已签」实测走 HTTP 400 + 业务码 10001，
 *  幂等信号不能按状态码先拦 */
export type CheckinOutcome = { kind: "done"; credit: number } | { kind: "already" } | { kind: "fail" };

const ALREADY_CHECKED_CODES = new Set(["10001", "14001"]);
/** 「已签」与「无签到体系」的业务文案标记（workbuddy2api cmd/signin 同款判据）：
 *  global 站无签到体系时返回未开启/已过期类措辞，同样按已签处理防止当日反复重试 */
const ALREADY_MSG_PATTERN = /已签到|未开启|未开放|已过期|already|inactive/i;

export function parseCheckinResult(result: HttpResult): CheckinOutcome {
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope<{ credit?: number | string }>;
    const code = json.code == null ? "" : String(json.code);
    // 新签成功 = HTTP 200 + 成功业务码（code 0/200 优先于文案匹配，防止成功响应
    // msg 撞上幂等文案时被吞成 already）
    if (result.status === 200 && (code === "0" || code === "200")) {
      return { kind: "done", credit: toCount(json.data?.credit) ?? 0 };
    }
    if (ALREADY_CHECKED_CODES.has(code)) return { kind: "already" };
    if (json.msg && ALREADY_MSG_PATTERN.test(json.msg)) return { kind: "already" };
    // 其余（网络错、5xx、未识别码）都可重试
    return { kind: "fail" };
  } catch {
    return { kind: "fail" };
  }
}

/** 旅行领奖响应归一化：claimed=本轮新领成功；none=无可领取（已领过/无到站记录，
 *  正常状态静默）；fail=可重试失败（网络/解析层，不记行程键下轮再试）。
 *  判据是两家参考实现的并集：code=0 成功（workbuddy2api 读 data.reward_credit、
 *  CodeBuddy-Usage 读 data.credit，都容）；「无可领取」看 no unclaimed 措辞 */
export type TravelClaimOutcome =
  | { kind: "claimed"; credit: number }
  | { kind: "none" }
  | { kind: "fail" };

const NO_UNCLAIMED_PATTERN = /no unclaimed/i;

export function parseClaimResult(result: HttpResult): TravelClaimOutcome {
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope<{
      credit?: number | string;
      reward_credit?: number | string;
    }>;
    const code = json.code == null ? "" : String(json.code);
    if (result.status === 200 && (code === "0" || code === "200")) {
      return {
        kind: "claimed",
        credit: toCount(json.data?.credit) ?? toCount(json.data?.reward_credit) ?? 0,
      };
    }
    if (json.msg && NO_UNCLAIMED_PATTERN.test(json.msg)) return { kind: "none" };
    return { kind: "fail" };
  } catch {
    return { kind: "fail" };
  }
}
