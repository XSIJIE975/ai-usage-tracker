import { invoke } from "@tauri-apps/api/core";
import type { CredentialStatus, HttpResult, MetricLine, ProviderSnapshot } from "../types/ipc";
import type { ProviderModule } from "./types";

// 端点与响应结构以 GLM_PROVIDER_PLAN.md 3.2/3.3/3.4 的实测结论为准（2026-09-01）：
// - 配额：open.bigmodel.cn/api/monitor/usage/quota/limit（Coding Plan Key 优先，缺失时 Rust 侧降用控制台登录 JWT）
// - 余额：www.bigmodel.cn/api/biz/account/query-customer-account-report（控制台登录 JWT）
// 两种凭据对 Authorization: Bearer <jwt> 均可用，无需裸头变体。
const QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const BALANCE_URL = "https://www.bigmodel.cn/api/biz/account/query-customer-account-report";

const PROVIDER_NAME = "智谱 GLM";

interface QuotaLimit {
  type?: string;
  /** 窗口单位（实测 3=小时、6=周）；未知值忽略 */
  unit?: number;
  /** 窗口数量（如 unit=3 & number=5 → 5 小时窗口） */
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  /** epoch 毫秒；仅在有消耗的窗口上出现 */
  nextResetTime?: number;
}

export interface GlmQuotaData {
  /** 套餐档位名（小写，如 "lite"） */
  level?: string;
  limits?: QuotaLimit[];
}

interface GlmEnvelope<T> {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: T;
}

interface GlmBalanceData {
  balance?: number | string | null;
  availableBalance?: number | string | null;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function windowLabel(limit: QuotaLimit): string | null {
  if (limit.unit === 3) {
    const hours = typeof limit.number === "number" && limit.number > 0 ? limit.number : 5;
    return `${hours} 小时请求配额`;
  }
  if (limit.unit === 6) return "每周请求配额";
  return null;
}

/** 档位名按官方习惯首字母大写显示（接口返回小写，如 "lite" → "Lite"） */
function formatLevel(level: string): string {
  const text = level.trim();
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 解析 quota/limit 响应为卡片指标行（实测结构见计划文档 3.3；未知 type/unit 忽略） */
export function parseQuotaLimits(data: GlmQuotaData | undefined): MetricLine[] {
  const lines: MetricLine[] = [];
  if (!data) return lines;
  if (data.level) {
    lines.push({ type: "badge", label: "套餐档位", value: formatLevel(data.level) });
  }
  for (const limit of data.limits ?? []) {
    if (limit.type !== "CREDIT_LIMIT") continue;
    const label = windowLabel(limit);
    if (!label) continue;
    const used =
      limit.currentValue ??
      (limit.usage != null && limit.remaining != null ? limit.usage - limit.remaining : undefined);
    const limitValue =
      limit.usage ??
      (limit.remaining != null && limit.currentValue != null ? limit.remaining + limit.currentValue : undefined);
    if (limit.percentage == null && (used == null || limitValue == null)) continue;
    lines.push({
      type: "progress",
      label,
      ...(used != null && limitValue != null ? { used, limit: limitValue } : {}),
      ...(limit.percentage != null ? { percentUsed: limit.percentage } : {}),
      ...(limit.nextResetTime != null && limit.nextResetTime > 0
        ? { resetsAt: new Date(limit.nextResetTime).toISOString() }
        : {}),
    });
  }
  return lines;
}

/** 解析余额响应为「账户余额」行（实测结构见计划文档 3.4）；解析失败返回 null（仅丢该行，不拖垮快照） */
export function parseFinanceBalance(json: GlmEnvelope<GlmBalanceData>): MetricLine | null {
  const data = json.data;
  if (!data) return null;
  const raw = data.balance ?? data.availableBalance;
  const amount = raw == null ? Number.NaN : Number(raw);
  if (!Number.isFinite(amount)) return null;
  const formatter = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
  return { type: "text", label: "账户余额", value: formatter.format(amount) };
}

interface SourceOutcome {
  ok: boolean;
  lines: MetricLine[];
  error?: string;
}

function processQuota(result: HttpResult): SourceOutcome {
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return { ok: false, lines: [], error: `Coding Plan 配额接口返回 HTTP ${result.status}${detail ? `：${truncate(detail)}` : ""}` };
  }
  try {
    const json = JSON.parse(result.bodyText) as GlmEnvelope<GlmQuotaData>;
    if (json.success === false) {
      return { ok: false, lines: [], error: `Coding Plan 配额查询失败：code=${json.code ?? "未知"}${json.msg ? ` msg=${truncate(json.msg, 120)}` : ""}` };
    }
    const lines = parseQuotaLimits(json.data);
    if (lines.length === 0) {
      return { ok: false, lines: [], error: "未订阅 Coding Plan 或暂无配额数据" };
    }
    return { ok: true, lines };
  } catch (error) {
    return { ok: false, lines: [], error: `Coding Plan 配额返回数据解析失败：${toErrorText(error)}` };
  }
}

function processBalance(result: HttpResult): SourceOutcome {
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return { ok: false, lines: [], error: `余额接口返回 HTTP ${result.status}${detail ? `：${truncate(detail)}` : ""}` };
  }
  try {
    const json = JSON.parse(result.bodyText) as GlmEnvelope<GlmBalanceData>;
    const line = parseFinanceBalance(json);
    if (!line) {
      return { ok: false, lines: [], error: "余额接口未返回可用数据" };
    }
    return { ok: true, lines: [line] };
  } catch (error) {
    return { ok: false, lines: [], error: `余额返回数据解析失败：${toErrorText(error)}` };
  }
}

async function fetchGlmSnapshot(): Promise<ProviderSnapshot> {
  const status = await invoke<CredentialStatus>("vault_credential_status");
  const updatedAt = Date.now();
  if (!status.glmCodingPlanKey && !status.glmWebToken) {
    return {
      providerId: "glm",
      providerName: PROVIDER_NAME,
      status: "needs_config",
      updatedAt,
      message: "请在设置中填写智谱凭据（Coding Plan Key 或控制台登录 JWT）",
      lines: [],
    };
  }

  const hasWebToken = Boolean(status.glmWebToken);
  const [quotaSettled, balanceSettled] = await Promise.allSettled([
    invoke<HttpResult>("provider_request", {
      providerId: "glm",
      url: QUOTA_URL,
      method: "GET",
      auth: "bearer",
      headers: { Accept: "application/json" },
    }),
    hasWebToken
      ? invoke<HttpResult>("provider_request", {
          providerId: "glm-web",
          url: BALANCE_URL,
          method: "GET",
          auth: "bearer",
          headers: { Accept: "application/json" },
        })
      : Promise.resolve(null),
  ]);

  const messages: string[] = [];
  const lines: MetricLine[] = [];
  let anyOk = false;
  let anyFailure = false;

  if (quotaSettled.status === "fulfilled") {
    const outcome = processQuota(quotaSettled.value);
    if (outcome.ok) {
      anyOk = true;
      lines.push(...outcome.lines);
    } else {
      anyFailure = true;
      messages.push(outcome.error ?? "Coding Plan 配额查询失败");
    }
  } else {
    anyFailure = true;
    messages.push(`Coding Plan 配额查询失败：${toErrorText(quotaSettled.reason)}`);
  }

  if (hasWebToken) {
    if (balanceSettled.status === "fulfilled" && balanceSettled.value) {
      const outcome = processBalance(balanceSettled.value);
      if (outcome.ok) {
        anyOk = true;
        lines.push(...outcome.lines);
      } else {
        anyFailure = true;
        messages.push(outcome.error ?? "余额查询失败");
      }
    } else if (balanceSettled.status === "rejected") {
      anyFailure = true;
      messages.push(`余额查询失败：${toErrorText(balanceSettled.reason)}`);
    }
  }

  if (!anyOk) {
    return {
      providerId: "glm",
      providerName: PROVIDER_NAME,
      status: "error",
      updatedAt,
      message: truncate(messages.join("；")),
      lines: [],
    };
  }

  return {
    providerId: "glm",
    providerName: PROVIDER_NAME,
    status: "ok",
    updatedAt,
    ...(anyFailure ? { message: truncate(messages.join("；")) } : {}),
    lines,
  };
}

export const glmProvider: ProviderModule = {
  id: "glm",
  name: "智谱 GLM",
  description: "查询智谱 Coding Plan 配额与按量付费余额",
  fetch: fetchGlmSnapshot,
};
