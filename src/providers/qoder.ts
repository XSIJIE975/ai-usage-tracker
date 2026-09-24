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
import { formatInt } from "../lib/utils";

// 端点与请求形态依据社区先例 CodexBar（steipete/CodexBar：docs/qoder.md 与实现
// Sources/CodexBarCore/Resources/Plugins/qoder.js，2026-09-24 逐行核对；非公开 web 接口、
// 随官方改版需跟随维护，接入边界见 ADR-0030）：
// - 唯一数据源：GET /api/v2/me/usages/big_model_credits（账号控制台大模型积分汇总）。
//   本期只读它，故无统计页——但「没有历史端点」这个说法已被证伪：官网用量页自己就有每日
//   消耗热力图、按天/周/月趋势与「Credits 记录」列表，只是端点没去侦察（ADR-0030）
// - 双登录域：国际站 qoder.com 与中国站 qoder.com.cn，Cookie 不互通；站点是实例的
//   显式属性（不从粘贴内容判站）
// - 凭据是单个网页 Cookie 的值：真机验证只需 qoder_session_cookie 这一对（2026-09-23），
//   所以凭据槽存的是它的**值**原文，键名与 Cookie 头由 Rust 端 qoder_cookie 通道拼；
//   前端不加工输入，合法性只在前端保存/探测前用字符集白名单把关（RFC 6265 cookie-value，
//   顺带挡住「贴整段 Cookie 头」和连键名一起贴）。UA 缺省按本机平台生成 Chrome 常量
//   ——Qoder 网关不绑定登录时 UA，与 WorkBuddy 的三元组同源校验截然不同；
//   Origin/Referer/Bx-V 是静态协议头，随端点定义在这里
// - 响应支持 camelCase 与 snake_case 两套键名（CodexBar 解码器同款双兼容）

const PROVIDER_NAME = "Qoder";

/** 凭据槽（qoder 实例存的会话 Cookie 值，见 SESSION_COOKIE_NAME） */
export const CREDENTIAL_SLOT = "cookie";

/** 登录态所在的 Cookie 名：界面上告诉用户取哪个键，取数时由 Rust 端拼成
 *  `Cookie: qoder_session_cookie=<值>`（凭据头只由鉴权分支注入，ADR-0030 §2） */
export const SESSION_COOKIE_NAME = "qoder_session_cookie";

/** 单个 Cookie 值的字符集（RFC 6265 cookie-value：可见 ASCII，排除空白、`"`、`,`、`;`）。
 *  与 Rust 端 `instances::validate_cookie_value`、WorkBuddy 的同名校验逐字符一致——三处
 *  任一处收紧都会误伤真机凭据 */
const COOKIE_VALUE_CHARS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x7e]+$/;

/**
 * Qoder 凭据输入合法性：只接受会话 Cookie 的**值**（键名与 Cookie 头由 Rust 拼）。
 * 拒三类误输入——`Cookie:` 前缀（那是请求头名）、连 `qoder_session_cookie=` 键名一起贴、
 * 以及超出 cookie-value 字符集的内容（整段 Cookie 头必带 `;` 与空格，落在这里）。
 * 只判定不加工：存进去的就是用户贴的那段值（ADR-0030 §2）
 */
export function isValidSessionCookieValue(value: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  if (lower.startsWith("cookie:")) return false;
  if (lower.startsWith(`${SESSION_COOKIE_NAME}=`)) return false;
  return COOKIE_VALUE_CHARS.test(value);
}

interface SiteConfig {
  origin: string;
  usageUrl: string;
}

const SITES: Record<ProviderSite, SiteConfig> = {
  china: {
    origin: "https://qoder.com.cn",
    usageUrl: "https://qoder.com.cn/api/v2/me/usages/big_model_credits",
  },
  international: {
    origin: "https://qoder.com",
    usageUrl: "https://qoder.com/api/v2/me/usages/big_model_credits",
  },
};

/** 实例的取数站点：site 缺失/未知值回退中国站（中文环境默认） */
export function qoderSiteOf(instance: Pick<ProviderInstance, "site">): ProviderSite {
  return instance.site === "international" ? "international" : "china";
}

export function qoderUsageUrl(site: ProviderSite): string {
  return SITES[site].usageUrl;
}

/** 用量接口的静态协议头：Origin/Referer 随站点切换，Bx-V 是 Qoder 网关
 *  （Baxia 风控）的版本头，写死 CodexBar 实证可用的 2.5.35，风控升级时跟随更新 */
export function qoderUsageHeaders(site: ProviderSite): Record<string, string> {
  const origin = SITES[site].origin;
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: origin,
    Referer: `${origin}/account/usage`,
    "X-Requested-With": "XMLHttpRequest",
    "Bx-V": "2.5.35",
  };
}

interface QuotaSummaryRaw {
  usedValue?: unknown;
  used_value?: unknown;
  limitValue?: unknown;
  limit_value?: unknown;
  remainingValue?: unknown;
  remaining_value?: unknown;
}

interface QuotaContainerRaw {
  quotaSummary?: QuotaSummaryRaw;
  quota_summary?: QuotaSummaryRaw;
}

/** 只声明我方读取的键（其余 plan_quota / resource_package_quota /
 *  dedicated_resource_package_quota / quota_detail / unit 一律忽略，见下）。
 *  真机样本的键名混用两套：容器是 snake_case（`total_quota`），两个重置时刻是 camelCase
 *  （`nextResetAt`），故两套都留。
 *  **没有 shared_quota**：CodexBar 插件读的那个键在真机两个站点都不存在，而两份样本对账
 *  证明 total_quota 就是 plan + 资源包 + 专属资源包的汇总位（2000+1200=3200、2000+534=2534、
 *  0+666=666），再叠一次是重复计数，故不实现（ADR-0030 §4） */
export interface QoderUsageData {
  totalQuota?: QuotaContainerRaw;
  total_quota?: QuotaContainerRaw;
  nextResetAt?: unknown;
  next_reset_at?: unknown;
}

export interface QoderQuotaSummary {
  usedValue: number;
  limitValue: number;
  /** 接口可能不下发余量（用 limit−used 推） */
  remainingValue: number | null;
}

/** 解析单份配额摘要：used/limit 必填（数值），缺失即整体无效（null）。
 *  接口同款的 usagePercentage/unit 字段刻意不入模型——百分比一律由 used/total 算 */
export function parseQuotaSummary(raw: QuotaSummaryRaw | undefined): QoderQuotaSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const used = toCount(raw.usedValue ?? raw.used_value);
  const limit = toCount(raw.limitValue ?? raw.limit_value);
  if (used == null || limit == null) return null;
  return {
    usedValue: used,
    limitValue: limit,
    remainingValue: toCount(raw.remainingValue ?? raw.remaining_value),
  };
}

/** 数值字段统一转数值；负数与 NaN 视为缺失（脏数据按 CodexBar 口径整体拒收，
 *  由调用方回落解析失败） */
function toCount(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

export interface QoderUsage {
  used: number;
  total: number;
  remaining: number;
  /** 已用百分比（0~100），语义见 parseUsageData */
  percent: number;
  resetsAt: Date | null;
}
/** 重置时刻：ISO 串或 epoch（秒/毫秒自适应，CodexBar 解码器同款）；解析不出返回 null */
export function parseNextReset(raw: unknown): Date | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const date = new Date(raw > 10_000_000_000 ? raw : raw * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof raw === "string" && raw.trim()) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  return null;
}

/**
 * 汇总解析（ADR-0030）：只读 `total_quota.quota_summary`，余量缺失按 max(0, limit−used) 推。
 *
 * 两份真机样本（2026-09-24，体验版国际站 + 付费中国站）对账证明 total_quota 就是
 * plan_quota + resource_package_quota + dedicated_resource_package_quota 的汇总位
 * （2000+1200=3200、2000+534=2534、0+666=666），所以三个分容器与 quota_detail 一律不读，
 * 更不再叠 CodexBar 那个真机不存在的 shared_quota（叠了是重复计数）。
 *
 * 百分比一律本地按 used/total 计算，不取下发的 usage_percentage：中国站付费样本
 * （__fixtures__/qoder-usage-china.json）证实它是 0~100 的**向上取整**整数——2534/3200=79.19
 * 下发 80，明细里 34/100 下发 35。用它就是把精度丢掉，还会让阈值告警在边界上比真实用量先响
 * （阈值设 80 时实际 79.19% 已经告）。CodexBar 插件相反：它优先信下发值，只在有 shared 容器时
 * 才本地算，所以体验版（无 shared、下发 0）它显示 0% 而非 100%——那个「零总量=100」只是它
 * shared 分支的兜底，我方首版把它当成了通用口径（见 ADR-0030 §3）。零总量样本下发的
 * usage_percentage 恰为 0，也正面证伪了「零总量就是耗尽」。结构不完整返回 null（解析失败）。
 *
 * 零总量（total=0 且 used=0）是「这个套餐没分配积分」（样本即如此），不是「用满等重置」——
 * 真用满时接口回的是 used=limit>0（付费样本的 plan 就是 2000/2000），百分比自然算到 100，
 * 无需伪造。故零总量下百分比与重置时刻都置空，展示口径由 parseUsageLines 按 total 判为
 * 中性事实行。
 *
 * 重置时刻只认未来的：体验版样本里 nextResetAt=1767708936459（2026-01-06 22:15 CST）相对
 * 当天已是八个月前，和 lastResetAt 一起算出个 14 天周期停在原地——未分配积分的账号周期是
 * 冻结的。照挂就是卡片上永远显示「1/6 22:15 重置」、切到相对口径更是「即将重置」，两句都是
 * 假话。（付费样本这一项正常：1790382507566 = 2026-09-26 08:28:27 CST，与官网「将于 2026年
 * 9月26日 08:28:27 刷新配额」逐字对得上。）
 */
export function parseUsageData(data: QoderUsageData | undefined, now = Date.now()): QoderUsage | null {
  if (!data || typeof data !== "object") return null;
  const container = data.totalQuota ?? data.total_quota;
  const summary = container?.quotaSummary ?? container?.quota_summary;
  const quota = parseQuotaSummary(summary);
  if (!quota) return null;
  const used = quota.usedValue;
  const total = quota.limitValue;
  const remaining = quota.remainingValue ?? Math.max(0, total - used);
  const rawReset = parseNextReset(data.nextResetAt ?? data.next_reset_at);
  const resetsAt = rawReset && rawReset.getTime() > now ? rawReset : null;
  if (total <= 0) {
    // 零总量却还有用量或余量：矛盾数据，整体拒收（CodexBar 插件同一条判定）
    if (used > 0 || remaining > 0) return null;
    return { used: 0, total: 0, remaining: 0, percent: 0, resetsAt: null };
  }
  return { used, total, remaining, percent: (used / total) * 100, resetsAt };
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** 快照主行：单个百分比配额窗口（与 OpenCode Go 同构）——进度行喂主指标、阈值
 *  告警、额度耗尽与托盘环；value 带余量数值打 balance 标记（速览余额位同 WorkBuddy
 *  惯例显示余量），resetsAt 有则携带（卡片自动出重置倒计时行） */
export function parseUsageLines(usage: QoderUsage): MetricLine[] {
  if (usage.total <= 0) {
    // 未分配积分（体验版）走中性事实行，与 WorkBuddy 无套餐同法（workbuddy.ts:284）：
    // 不出进度行，红条、已用 100%、重置倒计时、耗尽告警与托盘满环就都无从产生
    return [{ type: "text", label: "积分余量", value: "未分配积分" }];
  }
  const lines: MetricLine[] = [
    {
      type: "progress",
      label: "积分余量",
      used: usage.used,
      limit: usage.total,
      percentUsed: clampPercent(usage.percent),
      value: formatInt(usage.remaining),
      balance: true,
    },
  ];
  if (usage.resetsAt) {
    lines[0].resetsAt = usage.resetsAt.toISOString();
  }
  return lines;
}

export interface UsageOutcome {
  ok: boolean;
  lines: MetricLine[];
  error?: string;
  errorParams?: Record<string, string | number>;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 用量响应整体处理：401/403 或返回登录页 HTML 统一映射为「凭据无效或已过期，
 *  重贴会话 Cookie 值」——不区分成因（区分需要额外探测且给不出不同建议，ADR-0030） */
export function processUsageResult(result: HttpResult): UsageOutcome {
  const looksHtml = result.bodyText.trimStart().startsWith("<");
  if (result.status === 401 || result.status === 403 || (result.status === 200 && looksHtml)) {
    return {
      ok: false,
      lines: [],
      error: "Qoder 登录凭据无效或已过期，请在设置中重新粘贴 qoder_session_cookie 的值",
    };
  }
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return {
      ok: false,
      lines: [],
      error: "积分接口返回 HTTP {status}{detail}",
      errorParams: { status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  try {
    const usage = parseUsageData(JSON.parse(result.bodyText) as QoderUsageData);
    if (!usage) {
      return {
        ok: false,
        lines: [],
        error: "积分接口返回数据解析失败：{detail}",
        errorParams: { detail: "quota_summary 结构缺失" },
      };
    }
    return { ok: true, lines: parseUsageLines(usage) };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: "积分接口返回数据解析失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }
}

async function fetchQoderSnapshot(instance: ProviderInstance): Promise<ProviderSnapshot> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  const updatedAt = Date.now();
  if (!status.cookie) {
    return {
      instanceId: instance.id,
      providerId: "qoder",
      providerName: PROVIDER_NAME,
      status: "needs_config",
      updatedAt,
      message: "请在设置中粘贴 Qoder 会话 Cookie（qoder_session_cookie）的值",
      lines: [],
    };
  }

  const site = qoderSiteOf(instance);
  let outcome: UsageOutcome;
  try {
    const result = await invoke<HttpResult>("provider_request", {
      instanceId: instance.id,
      url: qoderUsageUrl(site),
      method: "GET",
      auth: "qoder_cookie",
      credentialSlot: CREDENTIAL_SLOT,
      headers: qoderUsageHeaders(site),
    });
    outcome = processUsageResult(result);
  } catch (error) {
    outcome = {
      ok: false,
      lines: [],
      error: "积分接口查询失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }

  if (!outcome.ok) {
    return {
      instanceId: instance.id,
      providerId: "qoder",
      providerName: PROVIDER_NAME,
      status: "error",
      updatedAt,
      message: outcome.error,
      messageParams: outcome.errorParams,
      lines: [],
    };
  }

  return {
    instanceId: instance.id,
    providerId: "qoder",
    providerName: PROVIDER_NAME,
    status: "ok",
    updatedAt,
    lines: outcome.lines,
  };
}

export const qoderProvider: ProviderModule = {
  id: "qoder",
  name: "Qoder",
  description: "查询 Qoder 大模型积分余量与重置时间",
  fetch: fetchQoderSnapshot,
};
