import { invoke } from "@tauri-apps/api/core";
import type {
  HttpResult,
  InstanceCredentialStatus,
  MetricLine,
  ProviderInstance,
  ProviderSite,
} from "../types/ipc";
import {
  cstDateString,
  isEnvelopeOk,
  parseCheckinResult,
  parseClaimResult,
  parseTravelLine,
  resolveWorkbuddyChannel,
  toCount,
  workbuddyApi,
  workbuddySiteOf,
  workbuddyTokenApi,
  type WorkbuddyEnvelope,
  type WorkbuddyStreakFullData,
  type WorkbuddyTravelStatus,
} from "./workbuddy-channel";

// WorkBuddy 成长中心例程层（ADR-0037）：签到、喵喵旅行、连登管家（补签 → 礼包/补偿 →
// 兑换档位 → 抽奖）、国际站 trial 的一套统一例程。双通道差异（auth/域/头族）全部内化
// 在 GrowthContext 的端点装配里——取数链（workbuddy.ts）与任务动作
// （workbuddy-tasks.ts）共用本层的上下文与出站，不再各自手写请求段。
//
// 接口与判据（参考项目 linguo2625469/workbuddy2api-panel streak.go/blackcat.go 对表
// 2026-09-27；均属 ADR-0029 白名单的「积分只进不出」写动作，除补签卡按官方用途消耗）：
// - 连登完整状态 GET /activity/growth/streak（取数链已在调的同一端点，启用完整响应）
// - 兑换档位 POST /activity/growth/redeem {tier, client_token}（未解锁 HTTP 403）
// - 抽奖 GET /activity/growth/lottery/summary → POST .../lottery/draw {client_token}
//   （次数只能从兑换获得；module.enabled=false 表示官方下线该模块）
// - 打卡日历 GET /activity/growth/heatmap（昨日 cell score==0 即漏签）+ 补签
//   POST /activity/growth/makeup-cards/use {target_date}（只补昨日——更早日期服务端拒绝）
// - 新手礼包/活动补偿 POST /billing/meter/claim-gift | claim-compensation（每号一次，
//   无则业务错误静默跳过）
// - 国际站试用加油包 POST /billing/ide/trial（仅国际站；已领幂等码 14051）
//
// 幂等与容错语义（与签到/旅行同哲学）：每步独立容错——单步失败不影响后续步骤；
// 例程只在「本轮无任何可重试失败」时打当日标记，半失败的下轮刷新自动补跑
// （locked/claimed/无卡/无礼包都是幂等静默跳过，重跑不重复发奖）。

// ─── 通道上下文 ───

type WorkbuddyChannel = "token" | "cookie";

/** Cookie 通道的账号摘要（事件上报事件体的 userId/昵称来源）。token 通道不查——
 *  vault 里有 uid/nickname，占位符由 Rust 替换。
 *  安全注记（ADR-0036 设计内例外）：uid/nickname 进前端内存，但 uid 单独不构成
 *  认证凭据（Cookie 通道认证靠 session，本体每次由 Rust 注入），渲染进程被控时
 *  攻击者可直接冒用 session_cookie 通道，实质攻击面未扩大。内存态、按实例数有界、
 *  实例删除后残留至进程退出（可接受） */
export interface WorkbuddyAccount {
  uid: string;
  nickname: string;
}

/** 成长中心例程的通道上下文：登录方式 + 站点 + 能力位 + Cookie 账号摘要。
 *  account 是可选的——取数链不需要 uid（只有任务事件上报强制），Cookie 通道
 *  console/account 拉取失败不得拖垮取数 */
export interface GrowthContext {
  instance: ProviderInstance;
  channel: WorkbuddyChannel;
  site: ProviderSite;
  capabilities: ReturnType<typeof workbuddyApi>["capabilities"];
  /** Cookie 通道的 uid/nickname（任务上报用）；token 通道恒 null；Cookie 拉取失败也为 null */
  account: WorkbuddyAccount | null;
}

/** 例程的出站端点（按 (站点, 通道) 装配，growth 层外不可见） */
interface GrowthEndpoints {
  auth: "session_cookie" | "workbuddy_token";
  /** growth 域基址（无 /v2 前缀：streak/redeem/lottery/heatmap/makeup/travel） */
  growthBase: string;
  growthHeaders: Record<string, string>;
  /** billing/meter 族基址（签到/礼包/补偿；token 国区含 /v2） */
  meterBase: string;
  meterHeaders: Record<string, string>;
  /** billing/ide 族基址（trial） */
  ideBase: string;
}

function endpointsFor(ctx: GrowthContext): GrowthEndpoints {
  if (ctx.channel === "cookie") {
    const api = workbuddyApi(ctx.site);
    return {
      auth: "session_cookie",
      growthBase: api.growthBase,
      growthHeaders: api.headers.travel,
      meterBase: api.meterBase,
      meterHeaders: api.headers.billing,
      ideBase: api.ideBase,
    };
  }
  const api = workbuddyTokenApi(ctx.site);
  return {
    auth: "workbuddy_token",
    growthBase: api.growthBase,
    growthHeaders: api.headers.growth,
    meterBase: api.meterBase,
    meterHeaders: api.headers.billing,
    ideBase: api.ideBase,
  };
}

// ─── Cookie 通道账号信息（uid 来源；自 workbuddy-tasks.ts 迁入）───

const accountCache = new Map<string, { account: WorkbuddyAccount; fetchedAt: number }>();
const ACCOUNT_CACHE_TTL_MS = 10 * 60 * 1000;

/** Cookie 通道 uid 的字符集白名单（与 token 通道 instances.rs 同标准）：
 *  uid 要进 X-User-Id 请求头与事件体 JSON，必须先排除 CRLF/引号/非 ASCII */
const UID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** console/account（网页控制台自己的账号接口，Cookie 会话配套；用户 spike 实证） */
async function fetchCookieAccount(instance: ProviderInstance): Promise<WorkbuddyAccount | null> {
  const cached = accountCache.get(instance.id);
  if (cached && Date.now() - cached.fetchedAt < ACCOUNT_CACHE_TTL_MS) return cached.account;
  let result: HttpResult;
  try {
    result = await invoke<HttpResult>("provider_request", {
      instanceId: instance.id,
      url: `${workbuddyApi(workbuddySiteOf(instance)).origin}/console/account`,
      method: "GET",
      auth: "session_cookie",
      headers: {
        Accept: "application/json",
        Origin: workbuddyApi(workbuddySiteOf(instance)).origin,
        "x-client-platform": "web",
      },
    });
  } catch {
    return null;
  }
  if (result.status !== 200) return null;
  let uid = "";
  let nickname = "";
  try {
    const json = JSON.parse(result.bodyText) as {
      code?: number;
      data?: { uid?: string; nickname?: string };
    };
    if (json.code !== 0) return null;
    uid = json.data?.uid ?? "";
    nickname = json.data?.nickname ?? "";
  } catch {
    // 200 + 非 JSON（WAF 挑战页等半失效形态）：按获取失败处理，绝不向上抛
    return null;
  }
  if (!UID_PATTERN.test(uid)) return null;
  const account = { uid, nickname };
  accountCache.set(instance.id, { account, fetchedAt: Date.now() });
  return account;
}

/** 建立成长中心上下文：token 槽非空即 token 通道（ADR-0035 互斥读出）。Cookie 通道
 *  尽力取 console/account——失败 account=null 但上下文仍可用（取数链不需要 uid；
 *  任务执行走 createTaskContext 的严格口径） */
export async function createGrowthContext(
  instance: ProviderInstance,
): Promise<GrowthContext | null> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  const channel = resolveWorkbuddyChannel(status);
  if (!channel) return null;
  const site = workbuddySiteOf(instance);
  const capabilities = workbuddyApi(site).capabilities;
  if (channel === "token") return { instance, channel, site, capabilities, account: null };
  const account = await fetchCookieAccount(instance);
  return { instance, channel, site, capabilities, account };
}

/** 统一出站（成长例程原子操作的唯一通道）：auth 与实例绑定，头族/基址由 ctx 装配 */
async function growthRequest(
  ctx: GrowthContext,
  endpoints: GrowthEndpoints,
  url: string,
  options: { method?: "GET" | "POST"; headers?: Record<string, string>; bodyText?: string } = {},
): Promise<HttpResult> {
  return invoke<HttpResult>("provider_request", {
    instanceId: ctx.instance.id,
    url,
    method: options.method ?? "GET",
    auth: endpoints.auth,
    headers: options.headers,
    bodyText: options.bodyText,
  });
}

/** 信封解包（成长例程口径）：HTTP 200 + code∈{0,200} 或无 code → data；否则给上游 msg */
function unwrapGrowthEnvelope(result: HttpResult): { ok: boolean; data?: unknown; msg: string } {
  if (result.status !== 200) return { ok: false, msg: `HTTP ${result.status}` };
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope<unknown>;
    if (isEnvelopeOk(json)) return { ok: true, data: json.data, msg: json.msg ?? "" };
    return { ok: false, msg: json.msg || "invalid response" };
  } catch {
    return { ok: false, msg: "invalid response" };
  }
}

// ─── 签到例程（自取数链双份实现收敛；幂等标记与解析判据逐字保留）───

/** 每实例的「今日已签」内存标记（每个 webview 独立；标记缺失最多多发一次幂等请求，
 *  服务端按账号当日判重，不会重复发积分——ADR-0029） */
const checkedInToday = new Map<string, string>();

export interface DailyCheckinResult {
  date: string;
  credited: number;
}

/** 每日签到（挂每天第一次刷新链，ADR-0029）：done 返回到账积分，already/fail 静默——
 *  fail 不设标记，下轮刷新重试；能力位门控（国际站无签到）整段跳过 */
export async function runDailyCheckin(
  ctx: GrowthContext,
  today: string,
): Promise<DailyCheckinResult | undefined> {
  if (!ctx.capabilities.checkin) return undefined;
  if (checkedInToday.get(ctx.instance.id) === today) return undefined;
  const endpoints = endpointsFor(ctx);
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.meterBase}/daily-checkin`, {
      method: "POST",
      headers: endpoints.meterHeaders,
      bodyText: "{}",
    });
    const outcome = parseCheckinResult(result);
    if (outcome.kind === "done") {
      checkedInToday.set(ctx.instance.id, today);
      return { date: today, credited: outcome.credit };
    }
    if (outcome.kind === "already") {
      checkedInToday.set(ctx.instance.id, today);
    }
  } catch {
    // 网络/调用层失败：不设标记，下轮刷新重试
  }
  return undefined;
}

// ─── 喵喵旅行状态机（自取数链迁入；判重标记与静默语义逐字保留）───

/** 每实例最近一次领奖的行程键（depart_at）内存投影；通知判重权威在 Rust 端
 *  workbuddy_travel_claims 行，这里只省同轮重复请求。标记缺失最多多发一次领奖，
 *  服务端按到站记录判重（已领返回「无可领取」措辞，不会重复发积分） */
const buddyClaimedKeys = new Map<string, string>();

/** 派出喵喵（location_id 1~4 收益/时长区间相同，workbuddy2api 实测，固定 1）；
 *  结果静默——失败不重试不标记，服务端 daily_limit 与行程状态天然节流 */
async function departTravel(ctx: GrowthContext, travelBase: string): Promise<boolean> {
  const endpoints = endpointsFor(ctx);
  try {
    const result = await growthRequest(ctx, endpoints, `${travelBase}/depart`, {
      method: "POST",
      headers: endpoints.growthHeaders,
      bodyText: JSON.stringify({ location_id: 1 }),
    });
    return result.status === 200 && isEnvelopeOk(JSON.parse(result.bodyText) as WorkbuddyEnvelope<unknown>);
  } catch {
    return false;
  }
}

function parseTravelStatus(result: HttpResult): WorkbuddyTravelStatus | null {
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope<WorkbuddyTravelStatus>;
    if (!isEnvelopeOk(json) || !json.data) return null;
    return json.data;
  } catch {
    return null;
  }
}

/** 喵喵旅行状态机（领奖 → 出发 → 回查，ADR-0029 修订；两通道共用本份实现）：
 *  通道差异全部在 ctx。辅助源语义不变：任何失败静默跳过不影响快照状态，
 *  只有「本轮真实领到」才返回 travel 喂通知检测器 */
export async function runTravelMachine(
  ctx: GrowthContext,
): Promise<{ travel?: { tripKey: string; credited: number }; travelLine: MetricLine | null }> {
  if (!ctx.capabilities.travel) return { travelLine: null };
  const endpoints = endpointsFor(ctx);
  const travelBase = `${endpoints.growthBase}/activity/growth/buddy/travel`;
  let travel: { tripKey: string; credited: number } | undefined;
  let travelLine: MetricLine | null = null;
  try {
    const travelStatus = parseTravelStatus(
      await growthRequest(ctx, endpoints, `${travelBase}/status`, { headers: endpoints.growthHeaders }),
    );
    if (travelStatus?.state === "traveling") {
      travelLine = parseTravelLine(travelStatus);
    } else if (travelStatus?.state === "arrived" || travelStatus?.state === "idle") {
      // 领奖只对到站记录发起（idle 无 record_id，跳过）；同一行程只尝试一次
      if (travelStatus.record_id != null) {
        const tripKey = String(travelStatus.depart_at ?? travelStatus.record_id);
        if (buddyClaimedKeys.get(ctx.instance.id) !== tripKey) {
          const claim = await growthRequest(ctx, endpoints, `${travelBase}/claim`, {
            method: "POST",
            headers: endpoints.growthHeaders,
            bodyText: JSON.stringify({ record_id: travelStatus.record_id }),
          });
          const outcome = parseClaimResult(claim);
          if (outcome.kind !== "fail") {
            buddyClaimedKeys.set(ctx.instance.id, tripKey);
            if (outcome.kind === "claimed") {
              travel = { tripKey, credited: outcome.credit };
            }
          }
        }
      }
      // 出发：名额已用尽（daily_limit_reached）或刚出发失败时不动；出发响应不含行程
      // 信息，回查 status 换旅行中行
      if (travelStatus.daily_limit_reached !== true && (await departTravel(ctx, travelBase))) {
        travelLine = parseTravelLine(
          parseTravelStatus(
            await growthRequest(ctx, endpoints, `${travelBase}/status`, { headers: endpoints.growthHeaders }),
          ),
        );
      }
    }
  } catch {
    // 静默：旅行是辅助源，下轮刷新重走状态机
  }
  return { ...(travel ? { travel } : {}), travelLine };
}

// ─── 连登完整状态（原子操作：管家与抽屉共用）───

/** 拉连登完整状态（GET /activity/growth/streak；取数链在调的同一端点）。
 *  失败/非 200/信封不 ok 返回 null——调用方按辅助源静默 */
export async function fetchStreakFull(ctx: GrowthContext): Promise<WorkbuddyStreakFullData | null> {
  if (!ctx.capabilities.streak) return null;
  const endpoints = endpointsFor(ctx);
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.growthBase}/activity/growth/streak`, {
      headers: endpoints.growthHeaders,
    });
    if (result.status !== 200) return null;
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope<WorkbuddyStreakFullData>;
    return isEnvelopeOk(json) ? (json.data ?? null) : null;
  } catch {
    return null;
  }
}

// ─── 连登管家例程（ADR-0037 核心）───

/** 兑换档位的到账明细（tiers[] 条目） */
export interface ButlerRedeem {
  tier: string;
  credit: number;
  energy: number;
  cards: number;
  chances: number;
}

/** 一轮管家闭环的事件汇总：全部字段可空/为零 = 无事件（静默）。
 *  作为快照瞬时字段喂 GrowthNoticeDetector（通知）与抽屉行内记录 */
export interface GrowthButlerOutcome {
  date: string;
  /** 本轮用补签卡补签的张数（0/1——只补昨日） */
  makeupUsed: number;
  giftCredit: number;
  compensationCredit: number;
  redeemed: ButlerRedeem[];
  /** 抽奖奖品可读名（提取失败给截断 JSON——奖品形状由活动期决定，参考项目同策略） */
  draws: string[];
  /** 闭环后回读的连登天数（抽屉行内刷新用；不进通知） */
  streakDays: number | null;
  /** 闭环后回读的完整状态（抽屉刷新档位胶囊用） */
  streakFull: WorkbuddyStreakFullData | null;
}

/** 每实例「当日管家已完整跑过」标记：只有整轮无任何可重试失败才打上——半失败
 *  （网络抖动/单步异常）下轮刷新自动补跑，locked/claimed/无卡/无礼包幂等跳过 */
const butlerRanToday = new Map<string, string>();

/** 前端幂等令牌（参考 clientToken：randomUUID 同款语义）。crypto.randomUUID 在
 *  webview 不可用时退化为时间+随机拼 UUID 形态（服务端只要求全局唯一形态） */
function clientToken(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fallthrough */
  }
  const hex = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

/** 昨天的 CST 日界（补签目标日：只补昨日，更早日期服务端拒绝——参考实测口径） */
function yesterdayCst(): string {
  return cstDateString(Date.now() - 86_400_000);
}

/** 打卡日历里昨天是否漏签（cell score==0）。查询失败抛错由例程统一容错 */
async function heatmapYesterdayMissed(ctx: GrowthContext, endpoints: GrowthEndpoints): Promise<boolean> {
  const result = await growthRequest(ctx, endpoints, `${endpoints.growthBase}/activity/growth/heatmap`, {
    headers: endpoints.growthHeaders,
  });
  const envelope = unwrapGrowthEnvelope(result);
  if (!envelope.ok) throw new Error(envelope.msg);
  const cells = (envelope.data as { cells?: { date?: string; score?: number }[] } | undefined)?.cells ?? [];
  const yesterday = yesterdayCst();
  for (const cell of cells) {
    if ((cell.date ?? "").slice(0, 10) === yesterday) return (cell.score ?? 0) === 0;
  }
  return false;
}

/** 用补签卡补指定日期（保住连登连续天数；无卡/不可补返回 false） */
async function useMakeupCard(
  ctx: GrowthContext,
  endpoints: GrowthEndpoints,
  date: string,
): Promise<boolean> {
  const result = await growthRequest(ctx, endpoints, `${endpoints.growthBase}/activity/growth/makeup-cards/use`, {
    method: "POST",
    headers: endpoints.growthHeaders,
    bodyText: JSON.stringify({ target_date: date }),
  });
  return unwrapGrowthEnvelope(result).ok;
}

/** 一次性礼包类领取（礼包/补偿）：返回到账积分；0=没有（信封业务错，静默）；
 *  null=可重试失败（网络/非 200——交由例程置 failed 下轮补跑） */
async function claimOneShot(
  ctx: GrowthContext,
  endpoints: GrowthEndpoints,
  action: "claim-gift" | "claim-compensation",
): Promise<number | null> {
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.meterBase}/${action}`, {
      method: "POST",
      headers: endpoints.meterHeaders,
      bodyText: "{}",
    });
    const envelope = unwrapGrowthEnvelope(result);
    if (!envelope.ok) return envelope.msg.startsWith("HTTP") ? null : 0;
    return toCount((envelope.data as { credit?: number | string } | undefined)?.credit) ?? 0;
  } catch {
    return null;
  }
}

/** 兑换单档（POST /activity/growth/redeem {tier, client_token}）：
 *  "redeemed"=成功；"locked"=未解锁（HTTP 403「连续登录天数不足」，预期静默——
 *  tiers 状态可能滞后于服务端）；null=可重试失败。管家闭环与抽屉的单档兑换共用 */
export async function redeemTier(
  ctx: GrowthContext,
  endpoints: GrowthEndpoints,
  tier: string,
): Promise<"redeemed" | "locked" | null> {
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.growthBase}/activity/growth/redeem`, {
      method: "POST",
      headers: endpoints.growthHeaders,
      bodyText: JSON.stringify({ tier, client_token: clientToken() }),
    });
    if (result.status === 403) return "locked";
    const envelope = unwrapGrowthEnvelope(result);
    if (envelope.ok) return "redeemed";
    // 信封失败：403 常以业务码/措辞出现（HTTP 200 + msg），按 locked 静默；其余按失败
    if (/连续登录|天数不足|locked/i.test(envelope.msg) || result.status >= 400 && result.status < 500) {
      return "locked";
    }
    return null;
  } catch {
    return null;
  }
}

interface LotterySummary {
  chances: number;
  enabled: boolean;
}

/** 抽奖次数与模块开关（GET /activity/growth/lottery/summary）；失败返回 null */
async function fetchLotterySummary(
  ctx: GrowthContext,
  endpoints: GrowthEndpoints,
): Promise<LotterySummary | null> {
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.growthBase}/activity/growth/lottery/summary`, {
      headers: endpoints.growthHeaders,
    });
    const envelope = unwrapGrowthEnvelope(result);
    if (!envelope.ok) return null;
    const payload = (envelope.data ?? {}) as {
      chances?: number | string;
      module?: { enabled?: boolean };
    };
    return {
      chances: toCount(payload.chances) ?? 0,
      enabled: payload.module?.enabled !== false,
    };
  } catch {
    return null;
  }
}

/** 抽奖奖品可读名提取：形状由活动期决定（参考项目透传策略），取常见字段链，
 *  全部落空给截断 JSON（宁给原文不给空） */
function prizeLabel(payload: unknown): string {
  const record = (payload ?? {}) as Record<string, unknown>;
  const candidates = [
    record.prize_name,
    record.prizeName,
    (record.prize as Record<string, unknown> | undefined)?.name,
    (record.prize as Record<string, unknown> | undefined)?.prize_name,
    record.name,
    record.title,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number") return String(candidate);
  }
  const raw = JSON.stringify(payload ?? {});
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

/** 抽一次（POST /activity/growth/lottery/draw {client_token}）：成功返回奖品可读名；
 *  null=可重试失败（中断本轮抽奖，已抽次数不退不重） */
async function lotteryDraw(ctx: GrowthContext, endpoints: GrowthEndpoints): Promise<string | null> {
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.growthBase}/activity/growth/lottery/draw`, {
      method: "POST",
      headers: endpoints.growthHeaders,
      bodyText: JSON.stringify({ client_token: clientToken() }),
    });
    const envelope = unwrapGrowthEnvelope(result);
    if (!envelope.ok) return null;
    return prizeLabel(envelope.data);
  } catch {
    return null;
  }
}

/** 连登管家闭环（ADR-0037）：补签 → 礼包/补偿 → 兑换已解锁档位 → 抽完抽奖次数。
 *  每步独立容错；整轮无任何可重试失败才打当日标记（半失败下轮补跑，幂等不重复发）。
 *  initialFull 传入调用方已拉取的连登状态可省一次 GET（抽屉回传场景）；
 *  无 butler 能力位返回 null。返回本轮事件汇总（含回读天数，无事件时全零字段） */
export async function runGrowthButler(
  ctx: GrowthContext,
  today: string,
  initialFull?: WorkbuddyStreakFullData | null,
): Promise<GrowthButlerOutcome | null> {
  if (!ctx.capabilities.butler) return null;
  if (butlerRanToday.get(ctx.instance.id) === today) return null;
  const endpoints = endpointsFor(ctx);
  const outcome: GrowthButlerOutcome = {
    date: today,
    makeupUsed: 0,
    giftCredit: 0,
    compensationCredit: 0,
    redeemed: [],
    draws: [],
    streakDays: null,
    streakFull: null,
  };
  let failed = false;

  // 1. 补签保连登：昨日漏签且有卡才用卡（连登一断要从第 1 天重攒，卡过期也浪费）
  try {
    if (await heatmapYesterdayMissed(ctx, endpoints)) {
      const full = initialFull ?? (await fetchStreakFull(ctx));
      if (full && (full.makeup_cards?.balance ?? 0) > 0) {
        if (await useMakeupCard(ctx, endpoints, yesterdayCst())) {
          outcome.makeupUsed = 1;
        } else {
          failed = true;
        }
      }
    }
  } catch {
    failed = true;
  }

  // 2. 礼包/补偿（每号一次；无则业务错误静默跳过）
  const gift = await claimOneShot(ctx, endpoints, "claim-gift");
  if (gift === null) failed = true;
  else outcome.giftCredit = gift;
  const compensation = await claimOneShot(ctx, endpoints, "claim-compensation");
  if (compensation === null) failed = true;
  else outcome.compensationCredit = compensation;

  // 3. 拉连登完整状态（initialFull 在补签步可能已被消费——兑换前必须有一份最新）
  let full = await fetchStreakFull(ctx);
  if (!full) failed = true;

  // 4. 兑换所有已解锁档位（locked/claimed 跳过；403 未解锁属预期静默不发奖）
  for (const tier of full?.redemption_status?.tiers ?? []) {
    const status = tierStatus(full!, tier.tier ?? "");
    if (status === "locked" || status === "claimed") continue;
    const redeemed = await redeemTier(ctx, endpoints, tier.tier ?? "");
    if (redeemed === "redeemed") {
      outcome.redeemed.push({
        tier: tier.tier ?? "",
        credit: tier.credit ?? 0,
        energy: tier.energy ?? 0,
        cards: tier.cards ?? 0,
        chances: tier.chances ?? 0,
      });
    } else if (redeemed === null) {
      failed = true;
    }
  }

  // 5. 抽奖：按当前次数全抽完（兑换刚发的次数服务端已实时累加；模块下线静默跳过）
  const summary = await fetchLotterySummary(ctx, endpoints);
  if (summary === null) {
    failed = true;
  } else if (summary.enabled) {
    for (let index = 0; index < summary.chances; index += 1) {
      const prize = await lotteryDraw(ctx, endpoints);
      if (prize === null) {
        failed = true;
        break;
      }
      outcome.draws.push(prize);
    }
  }

  // 6. 回读连登状态：天数与档位给抽屉刷新（兑换只发奖不改天数，补签可能续上连登）
  const finalFull = await fetchStreakFull(ctx);
  outcome.streakFull = finalFull ?? full;
  outcome.streakDays = finalFull?.streak?.days ?? full?.streak?.days ?? null;

  if (!failed) butlerRanToday.set(ctx.instance.id, today);
  return outcome;
}

/** 档位兑换状态（抽屉胶囊判定）：claimed=已兑换；locked=未解锁；其余=可兑换。
 *  顶层 tier_*_status 字段优先，tiers[] 条目兜底（两形状都容） */
export function tierStatus(full: WorkbuddyStreakFullData, tier: string): string {
  const topStatus = (full.redemption_status as Record<string, unknown> | undefined)?.[`tier_${tier}_status`];
  if (typeof topStatus === "string" && topStatus) return topStatus;
  const entry = full.redemption_status?.tiers?.find((item) => item.tier === tier);
  return entry ? "unlocked" : "locked";
}

/** 抽屉单档兑换入口（自建端点装配；结果语义同 redeemTier） */
export async function redeemSingleTier(
  ctx: GrowthContext,
  tier: string,
): Promise<"redeemed" | "locked" | null> {
  return redeemTier(ctx, endpointsFor(ctx), tier);
}

/** 抽奖次数与模块开关（抽屉区块展示用；失败返回 null） */
export async function fetchLotterySummaryForDisplay(
  ctx: GrowthContext,
): Promise<{ chances: number; enabled: boolean } | null> {
  return fetchLotterySummary(ctx, endpointsFor(ctx));
}

// ─── 国际站试用加油包（ADR-0037：仅 trial 能力位站点；一次性，已领永久静默）───

/** trial 已处理标记（进程内）：claimed/已领/4xx 都标记——一次性端点，反复试探无意义；
 *  网络类失败不标记，下轮刷新再试。领取成功只有一次，重启后重试只会拿到幂等静默，
 *  因此通知无需按日期判重的事实源行 */
const trialAttempted = new Map<string, true>();

export interface TrialClaimResult {
  /** 到账积分（端点未返回时 0；加油包本体随余额套餐行出现） */
  credit: number;
}

/** 试用加油包领取：成功返回到账；已领（幂等码 14051/措辞）与 4xx 永久静默；
 *  网络/5xx 不标记下轮再试。端点响应形状未真机验证（实施前置项），credit 缺失按 0 */
export async function runTrialClaim(ctx: GrowthContext): Promise<TrialClaimResult | undefined> {
  if (!ctx.capabilities.trial) return undefined;
  if (trialAttempted.has(ctx.instance.id)) return undefined;
  const endpoints = endpointsFor(ctx);
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.ideBase}/trial`, {
      method: "POST",
      headers: endpoints.meterHeaders,
      bodyText: "{}",
    });
    const envelope = unwrapGrowthEnvelope(result);
    if (envelope.ok) {
      trialAttempted.set(ctx.instance.id, true);
      return { credit: toCount((envelope.data as { credit?: number | string } | undefined)?.credit) ?? 0 };
    }
    // 已领取过（幂等）：永久静默——「已领取」措辞与幂等码 14051 双判据
    if (/14051|已领取|已经领取|already/i.test(envelope.msg) || (result.status >= 400 && result.status < 500)) {
      trialAttempted.set(ctx.instance.id, true);
    }
  } catch {
    // 网络/调用层失败：不标记，下轮刷新再试
  }
  return undefined;
}
