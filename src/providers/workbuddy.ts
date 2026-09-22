import { invoke } from "@tauri-apps/api/core";
import type {
  HttpResult,
  InstanceCredentialStatus,
  MetricLine,
  ProviderInstance,
  ProviderSite,
  ProviderSnapshot,
} from "../types/ipc";
import type { ProviderModule } from "./types";

// 端点与响应结构依据两个社区实现的交叉验证 + 用户浏览器实测请求（2026-09-21，
// 非公开 web 接口、随官方改版需跟随维护，接入边界见 ADR-0029）：
// - Sliverkiss/workbuddy2api internal/upstream/client.go 与 wwenc6621/CodeBuddy-Usage
//   src/extension.ts 揭示了接口族与响应形态；
// - 用户从 workbuddy.cn 抓包证实：**网页端不用 Bearer JWT，身份是 Cookie 会话**，
//   请求体也带真实 PackageCodes（与 CodeBuddy-Usage 的内置清单一致）。
// - 网关放行的是 (session, session_2, 登录时 UA) 三元组，缺一即 401：只发 session
//   被 APISIX 拒，UA 改一位（`Edg/153.0.0.0`→`153.0.0.1`）同一有效 Cookie 也被拒。
//   所以凭据槽存用户粘贴的 Copy as cURL 原文，**Cookie 与 UA 都由 Rust 端解析注入**
//   （src-tauri/src/curl_paste.rs），前端既不出 UA 也不拼 Cookie 头。
// - 余额/套餐：POST /billing/meter/get-user-resource（与两个社区实现同端点同主机：
//   CodeBuddy-Usage 逐字同路径，workbuddy2api 在 codebuddy.cn 走 /v2 前缀同族；
//   网页端 plans-usage 页用的同族 -free-packages 实测也可用，但顾名思义只覆盖免费包，
//   通用端点不限定免费包，付费套餐也在响应内）
//   （响应 data.Accounts[] 或 data.Response.Data.Accounts[] 为套餐级明细，无调用级用量）
// - 每日签到：POST /billing/meter/daily-checkin（空 body，幂等；code=0 成功带 data.credit，
//   code=10001/14001 当日已签；「未开启/已过期」= 账号无签到体系，按已签处理当日不再重试）
// - 连登天数：GET /activity/growth/streak（data.streak.days；同响应带补签卡余额，暂不接入）
// - 喵喵旅行：GET /activity/growth/buddy/travel/status + POST .../claim（带 record_id，
//   到站领奖）+ POST .../depart（location_id 1~4 收益/时长区间相同）。领奖与出发都是
//   非消耗写操作（积分只会进不会出）；出发由服务端 daily_limit_reached 节流
//   （workbuddy2api：按 CST 自然日重置的一日一出），领奖按行程 depart_at 判重
// billing/activity 族只要求 web 客户端特征（referer + x-client-platform），
// 不触碰聊天补全的 CLI 指纹门禁。
const PROVIDER_NAME = "腾讯 WorkBuddy / CodeBuddy";

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
}

interface WorkbuddySiteConfig {
  origin: string;
  capabilities: WorkbuddyCapabilities;
}

/** 实例的取数站点：site 缺失/未知值回退中国站（与 qoder 同口径） */
export function workbuddySiteOf(instance: Pick<ProviderInstance, "site">): ProviderSite {
  return instance.site === "international" ? "international" : "china";
}

/** get-user-resource 请求体（两站共用）：ProductCode/Status/OnlyValidPeriod 与两个社区实现
 *  对齐——workbuddy2api client.go 与 CodeBuddy-Usage extension.ts 都发 Status:[0,3]（状态 3
 *  的周期进行中套餐会被 [0] 滤掉而少算余量），并用 OnlyValidPeriod 让服务端滤掉已过期套餐
 *  （防作废积分虚增余量、阈值告警失明）。
 *  刻意不带网页抓包里的 PackageCodes 快照与 NeedInUsage：2026-09-22 两站真机回放四变体
 *  （带码+SlicePeriod / 带码 / 去码 / 去码+NeedInUsage）结果完全一致——国区 53 个套餐、
 *  周期总额 4394，国际站 2 个、350，四个变体一条不差。目录码不参与结果，留着它只是
 *  一份要跟随官方扩目录维护的清单（ADR-0029 §2 的备选方案就此落地） */
const RESOURCE_BODY = JSON.stringify({
  PageNumber: 1,
  PageSize: 200,
  ProductCode: "p_tcaca",
  Status: [0, 3],
  OnlyValidPeriod: true,
});

const SITES: Record<ProviderSite, WorkbuddySiteConfig> = {
  china: {
    origin: "https://www.workbuddy.cn",
    // 国区四件套 2026-09-21 实测在用（ADR-0029）
    capabilities: { checkin: true, streak: true, travel: true, stats: true },
  },
  international: {
    origin: "https://www.workbuddy.ai",
    // 2026-09-22 真机确认：国际站没有签到与成长中心（连登、喵喵旅行都不存在）；
    // 用量页与中国站同款，消耗明细按同族端点接入
    capabilities: { checkin: false, streak: false, travel: false, stats: true },
  },
};

/** 一站的取数面：URL、请求头与能力位。路径与请求体两站同构（2026-09-22 真机确认），
 *  实测出差异再拆进站点配置 */
export interface WorkbuddyApi {
  origin: string;
  resourceBody: string;
  capabilities: WorkbuddyCapabilities;
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

/** 凭据槽（workbuddy 实例存的 session Cookie 的 Value 原文） */
const CREDENTIAL_SLOT = "cookie";

interface WorkbuddyEnvelope<T> {
  /** 业务码：0/200 成功；10001/14001 当日已签；措辞类错误看 msg */
  code?: number | string;
  msg?: string;
  success?: boolean;
  data?: T;
}

/** get-user-resource 的单份套餐（字段名为服务端 PascalCase 原样；Precise 系为高精度数值，
 *  整数返回 number、小数可能返回字符串）。周期制套餐（Cycle 系）优先于总量制（Capacity 系） */
export interface WorkbuddyPackage {
  PackageName?: string;
  Status?: number;
  /** 套餐到期时刻（服务端本地时间 "YYYY-MM-DD HH:mm:ss"）；到期未用完的积分作废 */
  CycleEndTime?: string | number;
  CapacityRemainPrecise?: number | string;
  CapacityUsedPrecise?: number | string;
  CapacitySizePrecise?: number | string;
  CycleCapacityRemainPrecise?: number | string;
  CycleCapacitySizePrecise?: number | string;
}

export interface WorkbuddyResourceData {
  /** get-user-resource 的形态是 data.Response.Data.Accounts 包裹（CodeBuddy-Usage 同端点
   *  解析）；同族 -free-packages 端点 2026-09-21 实测为 data.Accounts 直挂。
   *  两种都容——取先命中的 */
  Accounts?: WorkbuddyPackage[];
  Response?: { Data?: { Accounts?: WorkbuddyPackage[] } };
}

export interface WorkbuddyStreakData {
  streak?: { days?: number };
}

/** 数值字段统一转数值（Precise 系整数是 number、小数可能是字符串）。
 *  空串视为缺失（实测部分字段下发的就是 ""），回落到另一组字段 */
export function toCount(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

const positiveOrZero = (value: number | null): number => (value != null && value > 0 ? value : 0);

/** remain 钳到 [0, size]：负余量、超总量的脏数据会把聚合 used 算成负值/虚高百分比
 *  （workbuddy2api packageRemainUsed 同款钳制）；size 缺失时只钳非负 */
function clampRemain(remain: number, size: number | null): number {
  const value = Math.max(0, remain);
  return size != null && size > 0 ? Math.min(value, size) : value;
}

/** 单套餐余量/总量：周期制（Cycle 系）以 CycleCapacitySize>0 为门槛**整组采用**
 *  （缺失的余量按 0，不与总量制跨制混搭——workbuddy2api packageRemainUsed 与
 *  CodeBuddy-Usage fetchUsage 同口径，周期制包只看本周期可用，未发放的未来额度不计入）；
 *  否则回退总量制（Capacity 系） */
function packageUsage(pkg: WorkbuddyPackage): { remain: number; size: number } {
  const cycleSize = toCount(pkg.CycleCapacitySizePrecise);
  if (cycleSize != null && cycleSize > 0) {
    return {
      remain: clampRemain(toCount(pkg.CycleCapacityRemainPrecise) ?? 0, cycleSize),
      size: cycleSize,
    };
  }
  const remain = positiveOrZero(toCount(pkg.CapacityRemainPrecise));
  const size = positiveOrZero(toCount(pkg.CapacitySizePrecise));
  return { remain: clampRemain(remain, size), size };
}

/** 到期时刻解析：服务端本地时间串按本地时区解释（用户与服务端同为 CST 时无偏差）；
 *  秒/毫秒 epoch 亦兼容，解析不出返回 null（该套餐不显示到期日） */
export function parseExpiry(raw: string | number | undefined): Date | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const date = new Date(raw > 1e12 ? raw : raw * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = raw.trim();
  if (!text) return null;
  // "YYYY-MM-DD HH:mm:ss" 不是合法 ISO，替换空格后按本地时区解析
  const ms = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
  if (Number.isFinite(ms)) return new Date(ms);
  const epoch = Number(text);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch > 1e12 ? epoch : epoch * 1000);
  return null;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("zh-CN") : value.toFixed(2);
}

/** 卡片指标行：主行 = 全部有效套餐聚合的积分余量（progress，喂托盘与告警；
 *  已耗尽/已用完的套餐同样计入分母——累计已用口径，与 workbuddy2api ResourceSummary
 *  一致，见 ADR-0029），明细行 = 按套餐名合并（同名套餐是同一包的不同发放周期，
 *  逐行展示会刷爆卡片——2026-09-21 实测单账号 15 条 Account 同名），到期时间取组内
 *  最早（最紧急先显示）；超过 3 组合并为一行 */
export function parseResourceLines(data: WorkbuddyResourceData | undefined): MetricLine[] {
  const accounts = data?.Accounts ?? data?.Response?.Data?.Accounts ?? [];
  const packages = accounts
    .map((pkg) => ({ pkg, usage: packageUsage(pkg) }))
    .filter(({ usage }) => usage.remain > 0 || usage.size > 0);
  if (packages.length === 0) {
    return [{ type: "text", label: "积分余量", value: "暂无有效套餐" }];
  }

  let totalRemain = 0;
  let totalSize = 0;
  for (const { usage } of packages) {
    totalRemain += usage.remain;
    totalSize += usage.size;
  }
  const lines: MetricLine[] = [];
  if (totalSize > 0) {
    lines.push({
      type: "progress",
      label: "积分余量",
      used: totalSize - totalRemain,
      limit: totalSize,
      percentUsed: ((totalSize - totalRemain) / totalSize) * 100,
      // 余额位数值（速览按 balance 标记选行）：纯数字，卡片进度分支不渲染 value
      value: formatCount(totalRemain),
      balance: true,
    });
  } else {
    // 只有余量没有总量：出不了百分比，退化为文本行（主指标回退余额数值的口径不适用，
    // workbuddy 没有金额量纲，该实例不参与托盘环与阈值告警）
    lines.push({
      type: "text",
      label: "积分余量",
      value: "余 {remain}",
      valueParams: { remain: formatCount(totalRemain) },
      balance: true,
    });
  }

  interface PackageGroup {
    name: string;
    remain: number;
    size: number;
    expiry: Date | null;
  }
  const groups = new Map<string, PackageGroup>();
  for (const { pkg, usage } of packages) {
    const name = pkg.PackageName?.trim() || "套餐";
    const group = groups.get(name) ?? { name, remain: 0, size: 0, expiry: null };
    group.remain += usage.remain;
    group.size += usage.size;
    const expiry = parseExpiry(pkg.CycleEndTime);
    if (expiry && (!group.expiry || expiry < group.expiry)) group.expiry = expiry;
    groups.set(name, group);
  }
  const sortedGroups = [...groups.values()].sort((a, b) => {
    const ea = a.expiry?.getTime() ?? Number.POSITIVE_INFINITY;
    const eb = b.expiry?.getTime() ?? Number.POSITIVE_INFINITY;
    return ea - eb;
  });
  const MAX_PACKAGE_LINES = 3;
  for (const group of sortedGroups.slice(0, MAX_PACKAGE_LINES)) {
    const remain = { remain: formatCount(group.remain) };
    lines.push(
      group.expiry
        ? {
            type: "text",
            label: group.name,
            value: "余 {remain} · {expiresAt}到期",
            valueParams: { ...remain, expiresAt: group.expiry.toISOString() },
          }
        : { type: "text", label: group.name, value: "余 {remain}", valueParams: remain },
    );
  }
  if (sortedGroups.length > MAX_PACKAGE_LINES) {
    const rest = sortedGroups.slice(MAX_PACKAGE_LINES);
    const restRemain = rest.reduce((sum, group) => sum + group.remain, 0);
    lines.push({
      type: "text",
      label: "其余 {count} 个套餐",
      params: { count: rest.length },
      value: "余 {remain}",
      valueParams: { remain: formatCount(restRemain) },
    });
  }
  return lines;
}

/** 连登天数行；取不到（无签到体系/接口失败）返回 null，该行直接不渲染 */
export function parseStreakLine(data: WorkbuddyStreakData | undefined): MetricLine | null {
  const days = data?.streak?.days;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return null;
  return { type: "text", label: "连登", value: "{days} 天", valueParams: { days } };
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

/** travel 响应整体处理：封套不成功/解析失败返回 null（辅助源，静默） */
function parseTravelStatus(result: HttpResult): WorkbuddyTravelStatus | null {
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope<WorkbuddyTravelStatus>;
    if (!isEnvelopeOk(json) || !json.data) return null;
    return json.data;
  } catch {
    return null;
  }
}

/** 签到日界按服务端时区 CST（UTC+8 固定无夏令时）计算 YYYY-MM-DD */
export function cstDateString(atMs: number = Date.now()): string {
  return new Date(atMs + 8 * 3_600_000).toISOString().slice(0, 10);
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

/** 封套成功判定：业务码 0/200；无业务码时按 success 缺省成功处理（activity 族可能不带 code） */
function isEnvelopeOk(json: WorkbuddyEnvelope<unknown>): boolean {
  const code = json.code == null ? "" : String(json.code);
  if (code) return code === "0" || code === "200";
  return json.success !== false;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ResourceOutcome {
  ok: boolean;
  lines: MetricLine[];
  error?: string;
  errorParams?: Record<string, string | number>;
}

/** 余额/套餐响应整体处理：401/403 或返回登录页 HTML 映射为「凭据无效或已过期」——
 *  网关对 session 成对与 UA 一致性任一不满足都回 401，出路同为重贴 Copy as cURL */
function processResource(result: HttpResult): ResourceOutcome {
  const looksHtml = result.bodyText.trimStart().startsWith("<");
  if (result.status === 401 || result.status === 403 || (result.status === 200 && looksHtml)) {
    return {
      ok: false,
      lines: [],
      error: "WorkBuddy 登录凭据无效或已过期，请在设置中重新粘贴 Copy as cURL",
    };
  }
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return {
      ok: false,
      lines: [],
      error: "积分套餐接口返回 HTTP {status}{detail}",
      errorParams: { status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope<WorkbuddyResourceData>;
    if (!isEnvelopeOk(json)) {
      return {
        ok: false,
        lines: [],
        error: "积分套餐查询失败：{detail}",
        errorParams: {
          detail: `code=${json.code ?? "unknown"}${json.msg ? ` msg=${truncate(json.msg, 120)}` : ""}`,
        },
      };
    }
    return { ok: true, lines: parseResourceLines(json.data) };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: "积分套餐返回数据解析失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }
}

/** 每实例的「今日已签」内存标记（每个 webview 独立；标记缺失最多多发一次幂等请求，
 *  服务端按账号当日判重，不会重复发积分——ADR-0029） */
const checkedInToday = new Map<string, string>();

/** 每实例最近一次领奖的行程键（depart_at）内存投影；通知判重权威在 Rust 端
 *  workbuddy_travel_claims 行，这里只省同轮重复请求。标记缺失最多多发一次领奖，
 *  服务端按到站记录判重（已领返回「无可领取」措辞，不会重复发积分） */
const buddyClaimedKeys = new Map<string, string>();

/** 派出喵喵（location_id 1~4 收益/时长区间相同，workbuddy2api 实测，固定 1）；
 *  结果静默——失败不重试不标记，服务端 daily_limit 与行程状态天然节流 */
async function departTravel(instanceId: string, api: WorkbuddyApi): Promise<boolean> {
  try {
    const result = await invoke<HttpResult>("provider_request", {
      instanceId,
      url: `${api.urls.travel}/depart`,
      method: "POST",
      auth: "session_cookie",
      credentialSlot: CREDENTIAL_SLOT,
      headers: api.headers.travel,
      bodyText: JSON.stringify({ location_id: 1 }),
    });
    return result.status === 200 && isEnvelopeOk(JSON.parse(result.bodyText) as WorkbuddyEnvelope<unknown>);
  } catch {
    return false;
  }
}

async function fetchWorkbuddySnapshot(instance: ProviderInstance): Promise<ProviderSnapshot> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  const updatedAt = Date.now();
  if (!status.cookie) {
    return {
      instanceId: instance.id,
      providerId: "workbuddy",
      providerName: PROVIDER_NAME,
      status: "needs_config",
      updatedAt,
      message: "请在设置中粘贴 WorkBuddy 登录凭据（Copy as cURL）",
      lines: [],
    };
  }

  const site = workbuddySiteOf(instance);
  const api = workbuddyApi(site);
  const { capabilities } = api;

  // 先签到后取数（ADR-0029）：签到到账的积分当轮即可见。签到失败不打断取数——
  // 余额是快照的主数据，签到下轮刷新会自动重试。本站无签到能力时整段跳过（ADR-0031）
  let checkin: { date: string; credited: number } | undefined;
  const today = cstDateString(updatedAt);
  if (capabilities.checkin && checkedInToday.get(instance.id) !== today) {
    try {
      const result = await invoke<HttpResult>("provider_request", {
        instanceId: instance.id,
        url: api.urls.checkin,
        method: "POST",
        auth: "session_cookie",
        credentialSlot: CREDENTIAL_SLOT,
        headers: api.headers.billing,
        bodyText: "{}",
      });
      const outcome = parseCheckinResult(result);
      if (outcome.kind === "done") {
        checkedInToday.set(instance.id, today);
        checkin = { date: today, credited: outcome.credit };
      } else if (outcome.kind === "already") {
        checkedInToday.set(instance.id, today);
      }
    } catch {
      // 网络/调用层失败：不设标记，下轮刷新重试
    }
  }

  // 喵喵旅行（ADR-0029 修订）：领奖与出发都是非消耗写操作（积分只进不出），挂在签到后、
  // 取数前——领到的积分当轮余额即可见。领奖按行程键（depart_at）判重，出发由服务端
  // daily_limit_reached 节流（CST 自然日重置的一日一出，无需本地标记）。整段是辅助源：
  // 任何失败静默跳过不影响快照状态，只有「本轮真实领到」才写 travel 字段喂通知检测器
  let travel: { tripKey: string; credited: number } | undefined;
  let travelLine: MetricLine | null = null;
  if (capabilities.travel) {
    try {
      const requestInit = {
        instanceId: instance.id,
        auth: "session_cookie" as const,
        credentialSlot: CREDENTIAL_SLOT,
        headers: api.headers.travel,
      };
      const travelStatus = parseTravelStatus(
        await invoke<HttpResult>("provider_request", {
          ...requestInit,
          url: `${api.urls.travel}/status`,
          method: "GET",
        }),
      );
      if (travelStatus?.state === "traveling") {
        travelLine = parseTravelLine(travelStatus);
      } else if (travelStatus?.state === "arrived" || travelStatus?.state === "idle") {
        // 领奖只对到站记录发起（idle 无 record_id，跳过）；同一行程只尝试一次
        if (travelStatus.record_id != null) {
          const tripKey = String(travelStatus.depart_at ?? travelStatus.record_id);
          if (buddyClaimedKeys.get(instance.id) !== tripKey) {
            const claim = await invoke<HttpResult>("provider_request", {
              ...requestInit,
              url: `${api.urls.travel}/claim`,
              method: "POST",
              bodyText: JSON.stringify({ record_id: travelStatus.record_id }),
            });
            const outcome = parseClaimResult(claim);
            if (outcome.kind !== "fail") {
              buddyClaimedKeys.set(instance.id, tripKey);
              if (outcome.kind === "claimed") {
                travel = { tripKey, credited: outcome.credit };
              }
            }
          }
        }
        // 出发：名额已用尽（daily_limit_reached）或刚出发失败时不动；出发响应不含行程
        // 信息，回查 status 换旅行中行
        if (travelStatus.daily_limit_reached !== true && (await departTravel(instance.id, api))) {
          travelLine = parseTravelLine(
            parseTravelStatus(
              await invoke<HttpResult>("provider_request", {
                ...requestInit,
                url: `${api.urls.travel}/status`,
                method: "GET",
              }),
            ),
          );
        }
      }
    } catch {
      // 静默：旅行是辅助源，下轮刷新重走状态机
    }
  }

  // 连登按能力位取数：本站没有就把这一路置为 null，下游 value?.status 的判断自然出局
  const [resourceSettled, streakSettled] = await Promise.allSettled([
    invoke<HttpResult>("provider_request", {
      instanceId: instance.id,
      url: api.urls.resource,
      method: "POST",
      auth: "session_cookie",
      credentialSlot: CREDENTIAL_SLOT,
      headers: api.headers.billing,
      bodyText: api.resourceBody,
    }),
    capabilities.streak
      ? invoke<HttpResult>("provider_request", {
          instanceId: instance.id,
          url: api.urls.streak,
          method: "GET",
          auth: "session_cookie",
          credentialSlot: CREDENTIAL_SLOT,
          headers: api.headers.activity,
        })
      : Promise.resolve(null),
  ]);

  let resourceOutcome: ResourceOutcome;
  if (resourceSettled.status === "fulfilled") {
    resourceOutcome = processResource(resourceSettled.value);
  } else {
    resourceOutcome = {
      ok: false,
      lines: [],
      error: "积分套餐查询失败：{detail}",
      errorParams: { detail: toErrorText(resourceSettled.reason) },
    };
  }

  if (!resourceOutcome.ok) {
    return {
      instanceId: instance.id,
      providerId: "workbuddy",
      providerName: PROVIDER_NAME,
      status: "error",
      updatedAt,
      message: resourceOutcome.error,
      messageParams: resourceOutcome.errorParams,
      lines: [],
      // 错误快照也携带签到/领奖字段：签到、领奖与取数是不同源，取数失败不吞掉已发生的事件
      ...(checkin ? { checkin } : {}),
      ...(travel ? { travel } : {}),
    };
  }

  // 连登是辅助展示源：失败静默（无行、无 message），不拖累快照
  let streakLine: MetricLine | null = null;
  if (streakSettled.status === "fulfilled" && streakSettled.value?.status === 200) {
    try {
      const json = JSON.parse(streakSettled.value.bodyText) as WorkbuddyEnvelope<WorkbuddyStreakData>;
      if (isEnvelopeOk(json)) streakLine = parseStreakLine(json.data);
    } catch {
      // 静默
    }
  }

  return {
    instanceId: instance.id,
    providerId: "workbuddy",
    providerName: PROVIDER_NAME,
    status: "ok",
    updatedAt,
    lines: [
      ...resourceOutcome.lines,
      ...(travelLine ? [travelLine] : []),
      ...(streakLine ? [streakLine] : []),
    ],
    ...(checkin ? { checkin } : {}),
    ...(travel ? { travel } : {}),
  };
}

export const workbuddyProvider: ProviderModule = {
  id: "workbuddy",
  name: "腾讯 WorkBuddy / CodeBuddy",
  description: "查询 WorkBuddy 积分余量、套餐明细、连登天数、签到与喵喵旅行",
  fetch: fetchWorkbuddySnapshot,
};
