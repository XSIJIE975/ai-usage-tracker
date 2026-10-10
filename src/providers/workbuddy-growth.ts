import { invoke } from "@tauri-apps/api/core";
import {
  oneShotValue,
  readWorkbuddyState,
  wbStateKind,
  writeWorkbuddyState,
} from "../lib/workbuddy-states";
import type {
  HttpResult,
  InstanceCredentialStatus,
  MetricLine,
  ProviderInstance,
  ProviderSite,
} from "../types/ipc";
import {
  BILLING_ORIGIN,
  WEB_ORIGIN,
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

/** console/account（网页控制台自己的账号接口，Cookie 会话配套；用户 spike 实证）。
 *  成功即把这份账号摘要落进 cookie_account 格：uid 是账号固有属性、不随会话变化，
 *  而它又是活跃上报的硬门槛（缺 uid 的上报会被服务端静默不计分），取到过一次之后
 *  这一轮拉取偶发失败不该让当天那次上报作废 */
async function fetchCookieAccount(instance: ProviderInstance): Promise<WorkbuddyAccount | null> {
  const cached = accountCache.get(instance.id);
  if (cached && Date.now() - cached.fetchedAt < ACCOUNT_CACHE_TTL_MS) return cached.account;
  const fetched = await requestConsoleAccount(instance);
  if (fetched) {
    accountCache.set(instance.id, { account: fetched, fetchedAt: Date.now() });
    void writeWorkbuddyState(instance.id, wbStateKind.cookieAccount, JSON.stringify(fetched));
    return fetched;
  }
  return readStoredCookieAccount(instance.id);
}

/** 本轮 console/account 的实际请求与解析；任何失败形态（非 200、WAF 挑战页、
 *  uid 不合白名单）都返回 null，绝不向上抛 */
async function requestConsoleAccount(instance: ProviderInstance): Promise<WorkbuddyAccount | null> {
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
  return { uid, nickname };
}

/** 读库里留存的 Cookie 通道账号；没有、或留下的 uid 已不合白名单都算没有 */
async function readStoredCookieAccount(instanceId: string): Promise<WorkbuddyAccount | null> {
  const stored = await readWorkbuddyState(instanceId, wbStateKind.cookieAccount);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<WorkbuddyAccount>;
    const uid = typeof parsed.uid === "string" ? parsed.uid : "";
    if (!UID_PATTERN.test(uid)) return null;
    return { uid, nickname: typeof parsed.nickname === "string" ? parsed.nickname : "" };
  } catch {
    return null;
  }
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

// ─── 活跃上报（chat_request_send 事件；点亮连登的唯一日常入口，ADR-0039）───

/** 事件体里的 uid 占位符：token 通道由 Rust 的 workbuddy_report 分支换成 vault 里的
 *  明文，Cookie 通道前端替换。缺 uid 的上报服务端返回成功但静默不计分（参考项目
 *  report.go 实测），所以它是这条上报的硬门槛而非可选项 */
export const WB_UID_PLACEHOLDER = "{{WB_UID}}";

/** chat 活跃上报的 Cookie 通道头族（= ADR-0036 spike 第二关的实证组合）。
 *  每日上报与国际站的分流在 chatReportTarget 里做；任务层的桌面/web 事件在
 *  Cookie 通道复用这一族（同一域同一会话形态） */
export const chatReportHeadersCookie = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: WEB_ORIGIN,
  Referer: `${WEB_ORIGIN}/profile/plans-usage`,
  "x-client-platform": "web",
};

/** 事件上报的凭据（Cookie 走会话 Cookie，token 走 Rust 的 report 分支——那一支同时
 *  负责占位符替换）。任务层的其它上报共用这里 */
export function reportAuthFor(ctx: GrowthContext): string {
  return ctx.channel === "cookie" ? "session_cookie" : "workbuddy_report";
}

/** chat 活跃上报事件（照参考实现 report.go 的 chatRequestEvent 完整形状，三十余个
 *  字段一个不删——参考项目点名「勿用最小 3 字段，防上游加严」）。conversationId 由
 *  调用方自造即可：服务端不校验它对应一场真实会话，这正是「不打开客户端也算活跃」的
 *  机制根据（参考项目 README「其余全部为行为事件上报，零对话消耗」） */
export function chatActivityEvent(
  conversationId: string,
  modelId?: string,
  modelName?: string,
): Record<string, unknown> {
  const timestamp = Date.now();
  return {
    eventCode: "chat_request_send",
    timestamp,
    reportDelay: 0,
    mode: "craft",
    conversationId,
    requestId: conversationId,
    inputLength: 12,
    requestModelId: modelId ?? "deepseek-v4-flash",
    requestModelName: modelName ?? "DeepSeek V4 Flash",
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    expertId: "",
    recommendId: "",
    skillId: "",
    skillCount: 0,
    totalCount: 0,
    fileUri: "",
    presentAt: timestamp,
    traceId: "",
    rootRequestId: conversationId,
    parentConversationId: conversationId,
    agentName: "default",
    agentType: "conversation",
    userId: WB_UID_PLACEHOLDER,
  };
}

/** 上报的域与头族按 (站点, 通道) 装配：
 *  - 国区两通道都打 codebuddy.cn/v2/report（ADR-0036 两轮真机修正：copilot 域对 POST
 *    一律要 Bearer，Cookie 会话只在 codebuddy 侧实证过计分）
 *  - 国际站打本站 www.workbuddy.ai/v2/report（参考项目 billingBase 的 realm 分流同口径；
 *    2026-10-08 无凭据探测该路由存在）
 *  X-Domain 与 Origin/Referer 跟着域走：把国际站账号的事件发到国区域，服务端即使回
 *  code 0 也计不到国际站那套连登上——上报端点对空 body 都回 code 0，成功响应本身
 *  从来不是计分证据，判据只有连登天数回读 */
function chatReportTarget(ctx: GrowthContext): { url: string; headers: Record<string, string> } {
  const siteOrigin = workbuddyApi(ctx.site).origin;
  const base = ctx.site === "international" ? siteOrigin : BILLING_ORIGIN;
  if (ctx.channel === "cookie") {
    return {
      url: `${base}/v2/report`,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: siteOrigin,
        Referer: `${siteOrigin}/profile/plans-usage`,
        "x-client-platform": "web",
      },
    };
  }
  // token 通道：复用本站的 billing 头族（含 Accept-Language 按站点切、X-Domain 随域走），
  // 与签到/余额同一族——参考项目 report.go 走的正是 BillingHeaders 这一族。
  // 自己拼一份头表就会漏掉按站点变化的那几项（国际站要 en-US，2026-10-08 对表发现）
  return { url: `${base}/v2/report`, headers: workbuddyTokenApi(ctx.site).headers.billing };
}

/** chat 活跃上报的出站本体（域与头族见 chatReportTarget）。
 *  返回信封判定而不抛错：任务层要把它转成动作错误，每日例程要把上游原文留进
 *  activity_status 格给抽屉看——两种消费共用同一个本体，不再各写一份请求 */
export async function sendChatActivity(
  ctx: GrowthContext,
  event: Record<string, unknown>,
): Promise<{ ok: boolean; msg: string }> {
  const target = chatReportTarget(ctx);
  const raw = JSON.stringify([event]);
  const result = await invoke<HttpResult>("provider_request", {
    instanceId: ctx.instance.id,
    url: target.url,
    method: "POST",
    auth: reportAuthFor(ctx),
    headers: target.headers,
    bodyText:
      ctx.channel === "cookie" && ctx.account
        ? raw.split(WB_UID_PLACEHOLDER).join(ctx.account.uid)
        : raw,
  });
  return unwrapGrowthEnvelope(result);
}

/** 本轮活跃上报的结果（null=能力位整段门掉，不显示这一行） */
export interface ActivityReportOutcome {
  status: "reported" | "already" | "skipped" | "failed";
  /** failed 时的上游原文（语言中性写法，进 {detail} 不翻译） */
  detail?: string;
}

/** activity_status 格的形状：给抽屉说清「今天为什么没有上报」。
 *  与 activity_acted 分工：那格只在成功时写（动作判据），这格每轮都写（展示用） */
export interface ActivityStatus {
  date: string;
  status: ActivityReportOutcome["status"];
  detail?: string;
}

/** 每日活跃上报（挂每天第一次刷新链，签到之后、连登回读之前，ADR-0039）：
 *  每实例每天发一条 chat_request_send 点亮当日连登。成功才写 activity_acted 格——
 *  失败的下轮刷新重试（与签到同口径）；参考项目的风控自律是「每号每天 1 次」，
 *  activity_acted 格正是把这条落到跨重启都成立的约束上。
 *  拿不到 uid 就不发：发了也不计分，白多一条无归属的埋点，还把「没做」和「做了没效」
 *  弄成同一个样子（ADR-0024 错误必须可见） */
export async function runDailyActivityReport(
  ctx: GrowthContext,
  today: string,
): Promise<ActivityReportOutcome | null> {
  if (!ctx.capabilities.activity) return null;
  if ((await readWorkbuddyState(ctx.instance.id, wbStateKind.activityActed)) === today) {
    return { status: "already" };
  }
  const uid = ctx.channel === "token" || ctx.account?.uid;
  if (!uid) {
    await writeActivityStatus(ctx.instance.id, { date: today, status: "skipped" });
    return { status: "skipped" };
  }
  try {
    const envelope = await sendChatActivity(ctx, chatActivityEvent(freshConversationId(today)));
    if (envelope.ok) {
      void writeWorkbuddyState(ctx.instance.id, wbStateKind.activityActed, today);
      await writeActivityStatus(ctx.instance.id, { date: today, status: "reported" });
      return { status: "reported" };
    }
    await writeActivityStatus(ctx.instance.id, {
      date: today,
      status: "failed",
      detail: envelope.msg,
    });
    return { status: "failed", detail: envelope.msg };
  } catch (error) {
    // 调用层失败（网络/命令异常）：与信封失败同处理——留原因、不写 acted，下轮再试。
    // 上报是辅助源，任何形态的失败都不能拖垮快照
    const detail = error instanceof Error ? error.message : String(error);
    await writeActivityStatus(ctx.instance.id, { date: today, status: "failed", detail });
    return { status: "failed", detail };
  }
}

/** 会话 id：`wb2api-` 前缀沿用参考项目形状，带当天日期便于对账 */
function freshConversationId(today: string): string {
  return `wb2api-${today}-${Date.now().toString(36)}`;
}

async function writeActivityStatus(instanceId: string, status: ActivityStatus): Promise<void> {
  await writeWorkbuddyState(instanceId, wbStateKind.activityStatus, JSON.stringify(status));
}

/** 读今日活跃上报状态（抽屉那一行的数据源；无格或日期不是今天按「未上报」处理） */
export async function loadActivityStatus(
  instanceId: string,
  today: string,
): Promise<ActivityStatus | null> {
  const stored = await readWorkbuddyState(instanceId, wbStateKind.activityStatus);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<ActivityStatus>;
    if (parsed.date !== today || typeof parsed.status !== "string") return null;
    return { date: today, status: parsed.status, detail: parsed.detail };
  } catch {
    return null;
  }
}

// ─── 签到例程（自取数链双份实现收敛；解析判据逐字保留，幂等标记改为库判据）───

/** 「今日已签」判据在 workbuddy_states 表的 checkin_acted 格（ADR-0039）：旧版是每
 *  webview 一份内存 Map，重启即失效——签到本身服务端按日幂等，最坏多发一次请求；
 *  但同一张表里还存着那些「多发一次就不再成立」的判据，判定与留痕从此走同一处 */
export interface DailyCheckinResult {
  date: string;
  credited: number;
}

/** 每日签到（挂每天第一次刷新链，ADR-0029）：done 返回到账积分，already/fail 静默——
 *  fail 不写标记，下轮刷新重试；能力位门控（国际站无签到）整段跳过 */
export async function runDailyCheckin(
  ctx: GrowthContext,
  today: string,
): Promise<DailyCheckinResult | undefined> {
  if (!ctx.capabilities.checkin) return undefined;
  if ((await readWorkbuddyState(ctx.instance.id, wbStateKind.checkinActed)) === today) {
    return undefined;
  }
  const endpoints = endpointsFor(ctx);
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.meterBase}/daily-checkin`, {
      method: "POST",
      headers: endpoints.meterHeaders,
      bodyText: "{}",
    });
    const outcome = parseCheckinResult(result);
    // 「已签」与「刚签成功」都算今日已做过：都是不必再发一次的结果
    if (outcome.kind === "done" || outcome.kind === "already") {
      void writeWorkbuddyState(ctx.instance.id, wbStateKind.checkinActed, today);
    }
    if (outcome.kind === "done") return { date: today, credited: outcome.credit };
  } catch {
    // 网络/调用层失败：不写标记，下轮刷新重试
  }
  return undefined;
}

// ─── 喵喵旅行状态机（自取数链迁入；判据改为 workbuddy_states 的 travel_tried 格）───

/** 每实例「这趟行程已尝试过领奖」记在 travel_tried 格（值为行程键 depart_at）；
 *  通知那一路另存 travel_notified 格。标记缺失最多多发一次领奖，服务端按到站记录
 *  判重（已领返回「无可领取」措辞，不会重复发积分） */

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
        if ((await readWorkbuddyState(ctx.instance.id, wbStateKind.travelTried)) !== tripKey) {
          const claim = await growthRequest(ctx, endpoints, `${travelBase}/claim`, {
            method: "POST",
            headers: endpoints.growthHeaders,
            bodyText: JSON.stringify({ record_id: travelStatus.record_id }),
          });
          const outcome = parseClaimResult(claim);
          if (outcome.kind !== "fail") {
            void writeWorkbuddyState(ctx.instance.id, wbStateKind.travelTried, tripKey);
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

/** 一轮闭环里值得留档的到账明细：抽屉「最近一次领取」的数据形状，也是
 *  workbuddy_states 的 butler_detail 格里的内容（与快照 growthNotice 字段同形） */
export interface ButlerRecordDetail {
  date: string;
  /** 本轮用补签卡补签的张数（0/1——只补昨日） */
  makeupUsed: number;
  giftCredit: number;
  compensationCredit: number;
  redeemed: ButlerRedeem[];
  /** 抽奖奖品可读名（提取失败给截断 JSON——奖品形状由活动期决定，参考项目同策略） */
  draws: string[];
}

/** 一轮管家闭环的事件汇总：全部字段可空/为零 = 无事件（静默）。
 *  作为快照瞬时字段喂 GrowthNoticeDetector（通知）与抽屉行内记录 */
export interface GrowthButlerOutcome extends ButlerRecordDetail {
  /** 闭环后回读的连登天数（抽屉行内刷新用；不进通知） */
  streakDays: number | null;
  /** 闭环后回读的完整状态（抽屉刷新档位胶囊用） */
  streakFull: WorkbuddyStreakFullData | null;
}

/** 「当日管家已完整跑过」记在 workbuddy_states 的 butler_acted 格：只有整轮无任何
 *  可重试失败才写——半失败（网络抖动/单步异常）下轮刷新自动补跑，
 *  locked/claimed/无卡/无礼包幂等跳过 */

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
 *  force 忽略当日标记——抽屉里用户主动点「领取全部奖励」时要当场真跑一遍给出结果，
 *  而不是因为今天自动那轮跑过就静默无输出；
 *  无 butler 能力位返回 null。返回本轮事件汇总（含回读天数，无事件时全零字段） */
export async function runGrowthButler(
  ctx: GrowthContext,
  today: string,
  initialFull?: WorkbuddyStreakFullData | null,
  options?: { force?: boolean },
): Promise<GrowthButlerOutcome | null> {
  if (!ctx.capabilities.butler) return null;
  if (
    !options?.force &&
    (await readWorkbuddyState(ctx.instance.id, wbStateKind.butlerActed)) === today
  ) {
    return null;
  }
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

  if (!failed) void writeWorkbuddyState(ctx.instance.id, wbStateKind.butlerActed, today);
  return outcome;
}

/** 读抽屉「最近一次领取」的留档：workbuddy_states 的 butler_detail 格（自动闭环发通知
 *  时由通知检测器写入当轮明细）。手动当场跑的那轮不进这里——它的结果在抽屉会话内
 *  即时可见。升级当天旧留档不搬，读不到留档返回 null，区块照旧不显示 */
export async function loadLastButlerRecord(
  instanceId: string,
): Promise<ButlerRecordDetail | null> {
  const stored = await readWorkbuddyState(instanceId, wbStateKind.butlerDetail);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as ButlerRecordDetail;
  } catch {
    // 留档是展示用的辅助源：读失败不报错、不阻断抽屉其余部分
    return null;
  }
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

export interface TrialClaimResult {
  /** 到账积分（端点未返回时 0；加油包本体随余额套餐行出现） */
  credit: number;
}

/** 试用加油包领取：成功返回到账；已领（幂等码 14051/措辞）与 4xx 永久静默——
 *  这三种都写 trial_acted 格（恒 '1'），一次性端点反复试探没有意义；网络/5xx 不写格，
 *  下轮再试。写格即写库，重启后「已经处理过」依然成立，不再每轮重启都重试一次。
 *  端点响应形状未真机验证（实施前置项），credit 缺失按 0 */
export async function runTrialClaim(ctx: GrowthContext): Promise<TrialClaimResult | undefined> {
  if (!ctx.capabilities.trial) return undefined;
  if ((await readWorkbuddyState(ctx.instance.id, wbStateKind.trialActed)) === oneShotValue) {
    return undefined;
  }
  const endpoints = endpointsFor(ctx);
  try {
    const result = await growthRequest(ctx, endpoints, `${endpoints.ideBase}/trial`, {
      method: "POST",
      headers: endpoints.meterHeaders,
      bodyText: "{}",
    });
    const envelope = unwrapGrowthEnvelope(result);
    if (envelope.ok) {
      void writeWorkbuddyState(ctx.instance.id, wbStateKind.trialActed, oneShotValue);
      return { credit: toCount((envelope.data as { credit?: number | string } | undefined)?.credit) ?? 0 };
    }
    // 已领取过（幂等）：永久静默——「已领取」措辞与幂等码 14051 双判据
    if (/14051|已领取|已经领取|already/i.test(envelope.msg) || (result.status >= 400 && result.status < 500)) {
      void writeWorkbuddyState(ctx.instance.id, wbStateKind.trialActed, oneShotValue);
    }
  } catch {
    // 网络/调用层失败：不写格，下轮刷新再试
  }
  return undefined;
}
