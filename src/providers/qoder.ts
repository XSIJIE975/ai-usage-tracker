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

// 端点与请求形态依据社区先例 CodexBar（steipete/CodexBar，docs/qoder.md 与
// QoderUsageFetcher.swift，2026-09-22 交叉验证；非公开 web 接口、随官方改版需跟随
// 维护，接入边界见 ADR-0030）：
// - 唯一数据源：GET /api/v2/me/usages/big_model_credits（账号控制台大模型积分汇总，
//   无请求级历史/token 口径端点，故无统计页，卡片即全部展示面）
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

export interface QoderUsageData {
  totalQuota?: QuotaContainerRaw;
  total_quota?: QuotaContainerRaw;
  sharedQuota?: QuotaContainerRaw;
  shared_quota?: QuotaContainerRaw;
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
 * 汇总解析与合并（CodexBar mergedQuota 同口径，ADR-0030）：totalQuota 与 sharedQuota
 * 的 used/total/remaining 逐项相加；余量缺失按 max(0, limit−used) 推。
 * 百分比一律按合并后的 used/total 计算，不取接口下发的 usagePercentage——下发值的
 * 量纲（0~100 还是 0~1）没有真机数据可证，猜错会让主指标、阈值告警、托盘环与耗尽告警
 * 同时静默失真；used/total 是必填字段，合并与单配额两条路径因此同口径。
 * 总量为 0 且用量为 0 视为 100%（额度耗尽形态），总量为 0 但用量非 0 是矛盾数据，
 * 整体拒收。结构不完整返回 null（解析失败）。
 */
export function parseUsageData(data: QoderUsageData | undefined): QoderUsage | null {
  if (!data || typeof data !== "object") return null;
  const summaryOf = (container: QuotaContainerRaw | undefined): QuotaSummaryRaw | undefined =>
    container?.quotaSummary ?? container?.quota_summary;
  const base = parseQuotaSummary(summaryOf(data.totalQuota ?? data.total_quota));
  if (!base) return null;
  const shared = parseQuotaSummary(summaryOf(data.sharedQuota ?? data.shared_quota));
  const remainingOf = (summary: QoderQuotaSummary): number =>
    summary.remainingValue ?? Math.max(0, summary.limitValue - summary.usedValue);
  const resetsAt = parseNextReset(data.nextResetAt ?? data.next_reset_at);

  const used = base.usedValue + (shared?.usedValue ?? 0);
  const total = base.limitValue + (shared?.limitValue ?? 0);
  if (total <= 0) {
    // 零总量：零用量按 100%（耗尽形态，CodexBar 同款）；有用量是矛盾数据
    if (used > 0) return null;
    return { used: 0, total: 0, remaining: 0, percent: 100, resetsAt };
  }
  const remaining = remainingOf(base) + (shared ? remainingOf(shared) : 0);
  return { used, total, remaining, percent: (used / total) * 100, resetsAt };
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** 快照主行：单个百分比配额窗口（与 OpenCode Go 同构）——进度行喂主指标、阈值
 *  告警、额度耗尽与托盘环；value 带余量数值打 balance 标记（速览余额位同 WorkBuddy
 *  惯例显示余量），resetsAt 有则携带（卡片自动出重置倒计时行） */
export function parseUsageLines(usage: QoderUsage): MetricLine[] {
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
