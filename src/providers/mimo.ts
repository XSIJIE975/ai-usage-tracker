import { invoke } from "@tauri-apps/api/core";
import type {
  HttpResult,
  InstanceCredentialStatus,
  MetricLine,
  ProviderInstance,
  ProviderSnapshot,
} from "../types/ipc";
import type { ProviderModule } from "./types";

// 端点与请求形态依据社区先例 CodexBar（steipete/CodexBar：docs/mimo.md 与实现
// Sources/CodexBarCore/Providers/MiMo/MiMoUsageFetcher.swift，2026-10-03 逐行核对；非公开
// web 接口、随官方改版需跟随维护，接入边界见 ADR-0038）：
// - 三个只读 GET：balance（现金账户）、tokenPlan/detail（订阅与周期末）、tokenPlan/usage
//   （本月额度）。全部同域同鉴权，目的地白名单一条主机即覆盖
// - 鉴权是网页控制台登录态：api-platform_serviceToken + userId 两个 Cookie 必需
//   （api-platform_ph / api-platform_slh 可选，缺了不报错）。登录域经查是同一个
//   account.xiaomi.com 的 sid=api-platform STS 会话（裸探 401 的 loginUrl 证实），
//   platform.xiaomimimo.com 与 mimo.mi.com 只是同一账号空间的两个前置域名，故按单站接入
// - 两格各存用户填的**值**原文，键名与 Cookie 头由 Rust 端 mimo_cookie 通道拼（与 qoder 的
//   qoder_cookie、workbuddy 的 session_cookie 同法）；前端只过字符集白名单，不加工输入
// - UA 不占格：网关不绑定登录时 UA（CodexBar 硬编码 Chrome UA 实证），后端按编译目标给常量
// - 扫码通道（ADR-0042）多一个目的地域：`https://account.xiaomi.com`（及其轮转子域
//   `https://c3.account.xiaomi.com` / `https://ak.lp.account.xiaomi.com` 等，白名单按
//   `*.account.xiaomi.com` 放行）。铸票三步都在 Rust 侧，前端不出这个域的 URL
// - 响应是 {code, message, data} 信封，code=0 才取 data；未订阅账号的 data 里那些字段是
//   **null** 而不是空数组/空串（2026-10-03 真机），所以逐项判空而不是假设形状
//
// 三处刻意不照抄 CodexBar（理由见 ADR-0038）：① 它把 currentPeriodEnd 按 UTC 解析，本模块按
// Asia/Shanghai 解析成绝对时刻；② 它把 expired 当必填布尔，真机未订阅账号回的是 null；
// ③ 它只读 monthUsage.items 的第一项，本模块逐项出行。

const PROVIDER_NAME = "小米 MiMo";

/** 两个凭据槽（值原文），键名见下方 Cookie 常量 */
export const SERVICE_TOKEN_SLOT = "serviceToken";
export const USER_ID_SLOT = "userId";
/** 扫码通道的槽位（ADR-0042）：passToken 是 30 天的小米账号凭据，deviceId 是发起扫码时
 *  自造并绑进票据与 sts 链的设备标识；serviceToken 不入库——它是会话级 Cookie，每轮刷新
 *  由 Rust 用这两格现铸 */
export const PASS_TOKEN_SLOT = "passToken";
export const DEVICE_ID_SLOT = "deviceId";
export const MIMO_PASS_SLOTS = [PASS_TOKEN_SLOT, USER_ID_SLOT, DEVICE_ID_SLOT] as const;
/** 净切换到 Cookie 登录 / 退出扫码登录时要清除的**独占**槽。`userId` 不在其中：它是两条
 *  通道共用的一格（Cookie 通道必填），把它一起清掉会让用户刚填的那格凭空变空、存完就
 *  needs_config（代码审查 2026-10-10 指出）。互斥性由 resolveMimoChannel 优先看 passToken
 *  保证，Rust 侧 claim 也只清 serviceToken，两边口径一致 */
export const MIMO_PASS_CLEAR_SLOTS = [PASS_TOKEN_SLOT, DEVICE_ID_SLOT] as const;

/** 通道判定（ADR-0035 互斥模型）：passToken 非空即扫码通道，否则两格齐走 Cookie 通道，
 *  两者都缺返回 null（needs_config，文案同时给出两种出路） */
export function resolveMimoChannel(
  status: InstanceCredentialStatus,
): "pass" | "cookie" | null {
  if (status[PASS_TOKEN_SLOT]) return "pass";
  if (status[SERVICE_TOKEN_SLOT] && status[USER_ID_SLOT]) return "cookie";
  return null;
}

/** 凭据所在的 Cookie 名：槽里只有值，键名由 Rust 端拼进 Cookie 头 */
export const SERVICE_TOKEN_COOKIE_NAME = "api-platform_serviceToken";
export const USER_ID_COOKIE_NAME = "userId";

const API_BASE = "https://platform.xiaomimimo.com/api/v1";
export const MIMO_BALANCE_URL = `${API_BASE}/balance`;
export const MIMO_PLAN_DETAIL_URL = `${API_BASE}/tokenPlan/detail`;
export const MIMO_PLAN_USAGE_URL = `${API_BASE}/tokenPlan/usage`;

/** 凭据失效的话按通道给：出路不同（重扫 vs 重贴），不静默换通道（ADR-0024） */
export const CREDENTIAL_EXPIRED_MESSAGE =
  "小米 MiMo 登录凭据无效或已过期，请在设置中重新填写 serviceToken 与 userId";
export const PASS_EXPIRED_MESSAGE =
  "小米账号授权已失效，请在设置中重新扫码（一次授权约可续 30 天）";

/** 缺哪点点名哪点（WorkBuddy 同法）：两格都是出数前提，只补一格不会变好。返回的是
 *  Cookie 名本身（语言中性、不进字典），模板与参数见调用点 */
export function mimoMissingCredentialSlots(status: InstanceCredentialStatus): string {
  const missing = [
    !status[SERVICE_TOKEN_SLOT] ? SERVICE_TOKEN_COOKIE_NAME : null,
    !status[USER_ID_SLOT] ? USER_ID_COOKIE_NAME : null,
  ].filter((name): name is string => !!name);
  if (missing.length === 0) return "";
  return missing.join(" / ");
}

/** 单个 Cookie 值的字符集（RFC 6265 cookie-value：可见 ASCII，排除空白、`"`、`,`、`;`）。
 *  与 Rust 端 `instances::mimo_cookies` 里的同款判定（三家共用 `is_cookie_value_chars`）逐字符
 *  一致——任一处收紧都会误伤真机凭据 */
const COOKIE_VALUE_CHARS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x7e]+$/;

/**
 * MiMo 凭据输入合法性：槽里只接受该 Cookie 的**值**（键名与 Cookie 头由 Rust 拼）。
 * 拒三类误输入——`Cookie:` 前缀、连自己的键名一起贴、超出 cookie-value 字符集的内容
 * （整段 Cookie 头必带 `;` 与空格，落在这里）。只判定不加工（ADR-0030 §2 同口径）
 */
export function isValidMimoCredentialValue(value: string, cookieName: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  if (lower.startsWith("cookie:")) return false;
  if (lower.startsWith(`${cookieName.toLowerCase()}=`)) return false;
  return COOKIE_VALUE_CHARS.test(value);
}

/** 本机时区偏移，形如 `UTC+08:00`：MiMo 控制台自己就发这个头，本工具发真实值而不是
 *  CodexBar 写死的 `UTC+01:00`（自报一个假时区比不发更可疑，且它没有依据） */
export function mimoTimeZoneHeader(now: Date = new Date()): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/** 静态协议头（Origin/Referer 指向余额页，与控制台自己发的那次请求同形） */
export function mimoRequestHeaders(now: Date = new Date()): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Origin: "https://platform.xiaomimimo.com",
    Referer: "https://platform.xiaomimimo.com/#/console/balance",
    "x-timeZone": mimoTimeZoneHeader(now),
  };
}

interface MimoEnvelope {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

interface BalanceData {
  balance?: unknown;
  currency?: unknown;
  cashBalance?: unknown;
  giftBalance?: unknown;
  frozenBalance?: unknown;
}

interface PlanDetailData {
  planCode?: unknown;
  planName?: unknown;
  currentPeriodEnd?: unknown;
  expired?: unknown;
}

interface UsageItem {
  name?: unknown;
  used?: unknown;
  limit?: unknown;
  percent?: unknown;
}

interface UsageData {
  monthUsage?: {
    percent?: unknown;
    items?: UsageItem[] | null;
  } | null;
  /** 顶层 `usage` 字段真机为 null、形状未证实，本模块不读（ADR-0038） */
  usage?: unknown;
}

/** 订阅状态：中性事实行的三种成因，互斥且各有真机/合成依据 */
export type PlanState =
  /** detail 源本轮没读到（不据此断言未订阅，只断言「没有周期信息」） */
  | { kind: "unknown" }
  | { kind: "unsubscribed" }
  | { kind: "expired" }
  | { kind: "active"; tier: string | null; resetsAt: Date | null };

export interface MimoBalance {
  amount: number;
  currency: string;
}

/** 月总量那一项的内部名（agentic-usage-meter 的筛选键，2026-10-03 据其解码器） */
export const MONTH_TOTAL_NAME = "month_total_token";

export interface MimoUsageWindow {
  used: number;
  limit: number;
  remaining: number;
  percent: number;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 数值字段：非有限数与负数按缺失（脏数据不画成 0，那会把「读不到」显示成「零用量」） */
function toCount(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

function toText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text || null;
}

/** 金额：字符串 "1.00" 或数字都收；空串与非有限数返回 null。
 *  空串不当 0 处理（Number("")===0，那会把「这个账户没这项数据」显示成「余额为零」，
 *  还会让余额告警先响一次） */
export function toAmount(raw: unknown): number | null {
  if (typeof raw === "string" && !raw.trim()) return null;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** 币种码：ISO 4217 三字母才交给 Intl，其余按原样拼在金额后面（Intl 对非法码直接抛错） */
export function formatMimoAmount(amount: number, currency: string | null): string {
  const digits = amount.toFixed(2);
  const code = currency?.toUpperCase() ?? null;
  if (code && /^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat("zh-CN", { style: "currency", currency: code }).format(amount);
    } catch {
      // 三位字母不合法币种的响应：落到下面拼串，不因为格式化失败丢整行
    }
  }
  return code ? `${digits} ${code}` : digits;
}

/**
 * 周期末时刻：MiMo 下发的是**无时区的挂钟串**（`2026-10-31 23:59:59`）。按 Asia/Shanghai
 * 换算成绝对时刻——周期终点是服务端的数据属性，用 `Date.parse` 的本地时区语义会让同一个
 * 账号的重置时刻随用户笔记本时区漂移（CodexBar 按 UTC 解析，恒早 8 小时，不照抄）。
 * 串里自带 Z 或 ±hh:mm 偏移时按它说的算，不再叠 8 小时。解析不出返回 null
 */
export function parseMimoPeriodEnd(raw: unknown, now: number = Date.now()): Date | null {
  const text = toText(raw);
  if (!text) return null;
  const plain = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!plain) return parseAmbiguous(text);
  const ms = Date.UTC(
    Number(plain[1]),
    Number(plain[2]) - 1,
    Number(plain[3]),
    Number(plain[4]),
    Number(plain[5]),
    Number(plain[6]),
  );
  if (!Number.isFinite(ms)) return null;
  const asShanghai = new Date(ms - 8 * 60 * 60 * 1000);
  // 只认未来的时刻：过期与缺失同处理（隐藏那一格），不挂一个过去的「重置」
  return asShanghai.getTime() > now ? asShanghai : null;
}

function parseAmbiguous(text: string): Date | null {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return ms > Date.now() ? new Date(ms) : null;
}

/** 余额响应 → 金额与币种 */
export function parseBalanceData(data: BalanceData | null | undefined): MimoBalance | null {
  if (!data || typeof data !== "object") return null;
  const amount = toAmount(data.balance);
  if (amount == null) return null;
  return { amount, currency: toText(data.currency) ?? "" };
}

/** 订阅详情 → 状态。`expired` 真机是三态（未订阅账号回 null），不能当必填布尔读 */
export function parsePlanDetail(data: PlanDetailData | null | undefined, now = Date.now()): PlanState {
  if (!data || typeof data !== "object") return { kind: "unknown" };
  const tier = toText(data.planName) ?? toText(data.planCode);
  const expired = data.expired;
  if (expired === true) return { kind: "expired" };
  // 未订阅判据：没有任何套餐标识、且 expired 不是明确为 false（明确 false 说明订阅在期内）
  if (!tier && expired !== false) return { kind: "unsubscribed" };
  return { kind: "active", tier, resetsAt: parseMimoPeriodEnd(data.currentPeriodEnd, now) };
}

/**
 * 本月额度 → 一行读数。未订阅账号 `items` 是 **null**（不是空数组）。
 *
 * 只取一项，且行名不用接口的 `name`：三份独立社区实现（CodexBar 取 items.first、
 * prime-radiant 的 agentic-usage-meter 只认 `month_total_token`、Pulse 取 first 并把
 * 「多桶时第一个未必是套餐本体」列为未决）没有一个画多行，而 `monthUsage.percent`
 * 是月级的单个数字——多出来的 `plan_total_token` / `compensation_total_token` 这类
 * 名字看着是这个月的**构成**，并列成兄弟行就是 Qoder 那种「汇总位与分容器相加」的
 * 重复计数风险（ADR-0030 §4）。`name` 本身是 snake_case 内部标识符（同 WorkBuddy 的
 * agentPurpose），印到卡片上等于给用户看调试串，所以行名固定用「Token Plan 额度」。
 * 单位是 token（两种实现的字段名后缀 `_token` 与 unit: "tokens"），故不标「积分」。
 */
export function parseUsageWindow(data: UsageData | null | undefined): MimoUsageWindow | null {
  const items = data?.monthUsage?.items;
  if (!Array.isArray(items)) return null;
  const valid = items.filter((item): item is UsageItem => {
    if (!item || typeof item !== "object") return false;
    return toCount(item.used) != null && toCount(item.limit) != null;
  });
  const chosen = valid.find((item) => toText(item.name) === MONTH_TOTAL_NAME) ?? valid[0];
  if (!chosen) return null;
  const used = toCount(chosen.used) as number;
  const limit = toCount(chosen.limit) as number;
  // 恒零 = 这个月没分配额度（与 Qoder 的恒零容器同口径，不出行、不画 0%）
  if (limit <= 0) return null;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    // 百分比一律本地按 used/limit 算，下发的 percent 不参与判定（同 ADR-0030 §4 的精度理由）
    percent: (used / limit) * 100,
  };
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * 卡片指标行：档位徽章 + 额度行 + 账户余额。顺序是刻意的——徽章不是 text 行，速览的
 * `neutralText` 取第一条 text；未订阅/已过期时那条 text 必须是状态行而不是余额行，
 * 所以状态行排在余额行之前（一个状态只让一个控件说）。
 *
 * 三条口径：
 * 1. **未订阅与已过期走中性事实行**（与 GLM「未订阅 Coding Plan」、Qoder「未分配积分」
 *    同族）：不出进度行，于是红条、重置倒计时、耗尽告警与托盘满环都无从产生。
 *    已过期套餐的 used/limit 仍是历史数字，画成进度等于给它挂一个「重置前不可用」的假承诺。
 * 2. **`balance` 标记只挂在金额行上**（GLM 同法）：MiMo 有现金账户，速览余额位就该是它，
 *    不需要像 Qoder 那样让进度行代持。
 * 3. **进度行只有一条**（见 parseUsageWindow 的取证），`resetsAt` 就挂它。周期时长（月/年）
 *    接口不下发，故不填 `windowPeriodMs`——猜一个 30 天会让托盘环层序与「余量还能撑多久」
 *    都建立在编造的分母上（CodexBar 的 fail-closed 决议同结论）。
 */
export function buildMimoLines(
  plan: PlanState,
  window: MimoUsageWindow | null,
  balance: MimoBalance | null,
  /** 额度源这一轮是否成功：失败时不写「暂无额度数据」——那是「取到了、只是没额度」，
   *  与「没取到」是两回事（中性事实行与错误快照的分工） */
  usageAvailable = true,
): MetricLine[] {
  const lines: MetricLine[] = [];

  if (plan.kind === "active" && plan.tier) {
    lines.push({ type: "badge", label: "套餐档位", value: plan.tier });
  }

  if (plan.kind === "unsubscribed") {
    lines.push({ type: "text", label: "Token Plan", value: "未订阅", status: true });
  } else if (plan.kind === "expired") {
    // label 已经说了 Token Plan，value 只写状态——旧值「Token Plan 已过期」会让
    // 主卡片渲染成「Token Plan Token Plan 已过期」
    lines.push({ type: "text", label: "Token Plan", value: "已过期", status: true });
  } else if (window) {
    const line: MetricLine = {
      type: "progress",
      label: "Token Plan 额度",
      used: window.used,
      limit: window.limit,
      percentUsed: clampPercent(window.percent),
    };
    // detail 源失败时（kind=unknown）没有周期信息，进度行照出、只是不带倒计时
    if (plan.kind === "active" && plan.resetsAt) line.resetsAt = plan.resetsAt.toISOString();
    lines.push(line);
  } else if (plan.kind === "active" && usageAvailable) {
    // 订阅在期内但这一轮没有可画的窗口（未用过 / 接口没给明细）：陈述状态而非故障
    lines.push({ type: "text", label: "Token Plan", value: "暂无额度数据", status: true });
  }

  if (balance) {
    lines.push({
      type: "text",
      label: "账户余额",
      value: formatMimoAmount(balance.amount, balance.currency),
      balance: true,
    });
  }
  return lines;
}

interface SourceOutcome<T> {
  ok: boolean;
  value: T | null;
  error?: string;
  errorParams?: Record<string, string | number>;
  /** 凭据失效：与「这个源自己出问题」区分开，前者要让整张卡报错而不是少一行 */
  credentialExpired?: boolean;
}

/** 信封读取：HTTP 层与业务码层两道都过，401/403 与回登录页 HTML 统一映射为凭据失效
 *  （不区分成因——区分需要额外探测且给不出不同建议，出路都是重贴） */
export function readEnvelope<T>(
  result: HttpResult,
  apiName: string,
): SourceOutcome<T> {
  const looksHtml = result.bodyText?.trimStart().startsWith("<") === true;
  if (result.status === 401 || result.status === 403 || (result.status === 200 && looksHtml)) {
    return {
      ok: false,
      value: null,
      credentialExpired: true,
      error: CREDENTIAL_EXPIRED_MESSAGE,
    };
  }
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() ?? "";
    return {
      ok: false,
      value: null,
      error: "MiMo {api} 接口返回 HTTP {status}{detail}",
      errorParams: { api: apiName, status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  let envelope: MimoEnvelope;
  try {
    envelope = JSON.parse(result.bodyText ?? "") as MimoEnvelope;
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: "MiMo {api} 接口返回数据解析失败：{detail}",
      errorParams: { api: apiName, detail: toErrorText(error) },
    };
  }
  const code = typeof envelope.code === "number" ? envelope.code : null;
  // code 缺失/非数值即信封形状不对：不能按 Number(null)===0 蒙成成功
  if (code === null) {
    return {
      ok: false,
      value: null,
      error: "MiMo {api} 接口返回数据解析失败：{detail}",
      errorParams: { api: apiName, detail: "code 字段缺失" },
    };
  }
  if (code === 401 || code === 403) {
    return { ok: false, value: null, credentialExpired: true, error: CREDENTIAL_EXPIRED_MESSAGE };
  }
  if (code !== 0) {
    const message = toText(envelope.message) ?? "";
    return {
      ok: false,
      value: null,
      error: "MiMo {api} 接口返回 code={code}{message}",
      errorParams: { api: apiName, code, message: message ? `：${message}` : "" },
    };
  }
  return { ok: true, value: (envelope.data ?? null) as T | null };
}

function settledOutcome<T>(
  settled: PromiseSettledResult<HttpResult>,
  apiName: string,
  parse: (data: unknown) => T | null,
): SourceOutcome<T> {
  if (settled.status === "rejected") {
    return {
      ok: false,
      value: null,
      error: "MiMo {api} 接口查询失败：{detail}",
      errorParams: { api: apiName, detail: toErrorText(settled.reason) },
    };
  }
  const envelope = readEnvelope<T>(settled.value, apiName);
  if (!envelope.ok) return envelope;
  const value = parse(envelope.value ?? undefined);
  if (value === null) {
    return {
      ok: false,
      value: null,
      error: "MiMo {api} 接口未返回可用数据",
      errorParams: { api: apiName },
    };
  }
  return { ok: true, value };
}

async function requestMimo(
  url: string,
  instanceId: string,
  auth: "mimo_cookie" | "mimo_pass",
): Promise<HttpResult> {
  return invoke<HttpResult>("provider_request", {
    instanceId,
    url,
    method: "GET",
    auth,
    headers: mimoRequestHeaders(),
  });
}

async function fetchMimoSnapshot(instance: ProviderInstance): Promise<ProviderSnapshot> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  const updatedAt = Date.now();
  const channel = resolveMimoChannel(status);
  if (!channel) {
    return {
      instanceId: instance.id,
      providerId: "mimo",
      providerName: PROVIDER_NAME,
      status: "needs_config",
      updatedAt,
      message: "请在设置中扫码登录小米 MiMo，或填写 {slots}",
      messageParams: { slots: mimoMissingCredentialSlots(status) },
      lines: [],
    };
  }
  const expiredMessage = channel === "pass" ? PASS_EXPIRED_MESSAGE : CREDENTIAL_EXPIRED_MESSAGE;
  const auth = channel === "pass" ? ("mimo_pass" as const) : ("mimo_cookie" as const);

  // 三路并行（GLM 同法）：余额与订阅是两回事，一个源挂了不该让另一个源的数据消失
  const [balanceSettled, detailSettled, usageSettled] = await Promise.allSettled([
    requestMimo(MIMO_BALANCE_URL, instance.id, auth),
    requestMimo(MIMO_PLAN_DETAIL_URL, instance.id, auth),
    requestMimo(MIMO_PLAN_USAGE_URL, instance.id, auth),
  ]);

  const balance = settledOutcome<MimoBalance>(balanceSettled, "balance", (data) =>
    parseBalanceData(data as BalanceData | undefined),
  );
  const plan = settledOutcome<PlanState>(detailSettled, "tokenPlan/detail", (data) =>
    parsePlanDetail(data as PlanDetailData | undefined),
  );
  // 包一层对象：parseUsageWindow 返回 null 是「取到了、这个月没有额度」，
  // 而 settledOutcome 把 null 当「这个源没读到」——两种 null 不能共用一个信号
  const usage = settledOutcome<{ window: MimoUsageWindow | null }>(
    usageSettled,
    "tokenPlan/usage",
    (data) => ({ window: parseUsageWindow(data as UsageData | undefined) }),
  );

  // 凭据失效是三个源共同的成因，任一源报这个就把整张卡判为错误快照（重贴即恢复）；
  // 全源失败同样报错，部分源失败出 ok 快照并把失败拼进 message（ADR-0024 错误可见）
  const sources = [balance, plan, usage];
  const credentialExpired = sources.some((source) => source.credentialExpired);
  // 多源错误模板拼成一条 message（渲染端统一 t+params）：各源模板共用 {api}/{detail} 等
  // 占位符，直接合并参数会互相覆盖——第 2 段起加序号后缀，模板与参数同步改写（GLM 同法）
  const messages: string[] = [];
  const messageParams: Record<string, string | number> = {};
  let segment = 0;
  for (const source of sources) {
    if (source.ok || !source.error) continue;
    segment += 1;
    const params = source.errorParams ?? {};
    let template = source.error;
    if (segment > 1) {
      for (const key of Object.keys(params)) {
        template = template.split(`{${key}}`).join(`{${key}${segment}}`);
      }
    }
    messages.push(template);
    for (const [key, value] of Object.entries(params)) {
      messageParams[segment === 1 ? key : `${key}${segment}`] = value;
    }
  }
  const snapshotBase = {
    instanceId: instance.id,
    providerId: "mimo" as const,
    providerName: PROVIDER_NAME,
    updatedAt,
  };
  if (credentialExpired || sources.every((source) => !source.ok)) {
    return {
      ...snapshotBase,
      status: "error",
      // 凭据失效优先：三源同因，拼三份相同的话只会把真正要做的动作埋掉
      message: credentialExpired ? expiredMessage : messages.join("；"),
      ...(credentialExpired ? {} : { messageParams }),
      lines: [],
    };
  }

  const lines = buildMimoLines(
    plan.value ?? { kind: "unknown" },
    usage.value?.window ?? null,
    balance.value,
    usage.ok,
  );
  return {
    ...snapshotBase,
    status: "ok",
    ...(messages.length > 0 ? { message: messages.join("；"), messageParams } : {}),
    lines,
  };
}

export const mimoProvider: ProviderModule = {
  id: "mimo",
  name: PROVIDER_NAME,
  description: "查询小米 MiMo 的 Token Plan 额度与账户余额",
  fetch: (instance) => fetchMimoSnapshot(instance),
};
