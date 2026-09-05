import { invoke } from "@tauri-apps/api/core";
import { applyParams } from "../i18n";
import type {
  HttpResult,
  InstanceCredentialStatus,
  MetricLine,
  ProviderInstance,
  ProviderSnapshot,
} from "../types/ipc";
import type { ProviderModule } from "./types";

// 端点与响应结构以实测结论为准（2026-09-01 配额 / 2026-09-04 余额，见 ADR-0009/0013/0014）：
// - 配额：open.bigmodel.cn/api/monitor/usage/quota/limit（Coding Plan API Key 鉴权，
//   与智谱官方 glm-plan-usage 插件同款用法，Bearer/裸值均可用）
// - 余额：www.bigmodel.cn/api/biz/account/query-customer-account-report。
//   ADR-0010 曾因「仅控制台 JWT 可用、易过期」移除该通道；2026-09-04 实测 Coding Plan Key
//   直调同样返回 code 200（社区 GCMP/CodexBar 同款用法），通道以同一枚 Key 恢复（ADR-0013）。
// - 重置卡：www.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL
//   （官网「用量重置额度」，每张 1 次、独立有效期；鉴权同 biz 族，ADR-0014）。
const QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const BALANCE_URL = "https://www.bigmodel.cn/api/biz/account/query-customer-account-report";
const RESET_URL = "https://www.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL";

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

/** query-customer-account-report 的 data；字段与控制台财务页一一对应（2026-09-04 实测固化） */
export interface GlmBalanceData {
  /** 当前余额（元）＝充值 + 赠送 − 累计消费 */
  balance?: number | string | null;
  /** 可用余额（元）＝当前余额 − 冻结 */
  availableBalance?: number | string | null;
  /** 累计充值（元） */
  rechargeAmount?: number | string | null;
  /** 赠送金额（元） */
  giveAmount?: number | string | null;
  /** 累计消费（元） */
  totalSpendAmount?: number | string | null;
  /** 冻结金额（元） */
  frozenBalance?: number | string | null;
  /** 信用余额（元）；未开通为 null */
  creditBalance?: number | string | null;
  /** 信用状态；未开通为 "NOT_OPEN" */
  creditStatus?: string | null;
}

const currencyFormatter = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });

/** 金额字段统一转数值（接口对整数返回 number、小数可能返回字符串，如 "0E-9" 形态为 number） */
export function toAmount(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** 当前余额（控制台「当前余额」口径）：balance 优先，缺失回退 availableBalance */
export function parseGlmBalance(data: GlmBalanceData | undefined): number | null {
  if (!data) return null;
  return toAmount(data.balance) ?? toAmount(data.availableBalance);
}

/** 卡片上的「账户余额」文本行；解析不出金额返回 null（该行直接不渲染） */
export function parseBalanceLine(data: GlmBalanceData | undefined): MetricLine | null {
  const amount = parseGlmBalance(data);
  if (amount == null) return null;
  return { type: "text", label: "账户余额", value: currencyFormatter.format(amount) };
}

/** customer-package-reset/list 的单张重置卡（每张 1 次；available=false 且未过期视为已使用） */
export interface GlmResetCardRaw {
  recordId?: number;
  /** 服务端本地时间 "YYYY-MM-DD HH:mm:ss" */
  expireTime?: string;
  available?: boolean;
}

/** 重置额度列表响应 data（官网「用量重置额度」；周卡使用时会同步重置 5h 额度） */
export interface GlmPackageResetData {
  lastFiveHourResetTime?: string | null;
  lastWeekResetTime?: string | null;
  fiveHourResets?: GlmResetCardRaw[];
  weekResets?: GlmResetCardRaw[];
}

export function countAvailableResets(cards: GlmResetCardRaw[] | undefined): number {
  return (cards ?? []).filter((card) => card.available === true).length;
}

/**
 * 卡片上的「可用重置卡」文本行：仅在有可用卡时渲染（与 DeepSeek 充值/赠送行的按需展示一致），
 * 无卡是常态，不显示「0 张」。
 */
export function parseResetLine(data: GlmPackageResetData | undefined): MetricLine | null {
  if (!data) return null;
  const fiveHour = countAvailableResets(data.fiveHourResets);
  const week = countAvailableResets(data.weekResets);
  if (fiveHour + week === 0) return null;
  const parts: string[] = [];
  if (fiveHour > 0) parts.push(`5 小时 ×${fiveHour}`);
  if (week > 0) parts.push(`周 ×${week}`);
  return { type: "text", label: "可用重置卡", value: parts.join(" · ") };
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WindowSpec {
  label: string;
  params?: Record<string, number>;
}

/**
 * 窗口语义按实测与官方 glm-plan-usage 插件的处理约定：
 * - 国内站 CREDIT_LIMIT：unit=3 → N 小时滚动窗口、unit=6 → 滚动周窗口
 * - 国际站/旧版 TOKENS_LIMIT（5 小时 Token 窗口）、TIME_LIMIT（MCP 月度窗口）
 * 未知 type/unit 一律忽略。
 */
function windowSpec(limit: QuotaLimit): WindowSpec | null {
  if (limit.type === "CREDIT_LIMIT") {
    if (limit.unit === 3) {
      const hours = typeof limit.number === "number" && limit.number > 0 ? limit.number : 5;
      return { label: "{hours} 小时请求配额", params: { hours } };
    }
    if (limit.unit === 6) return { label: "每周请求配额" };
    return null;
  }
  if (limit.type === "TOKENS_LIMIT") {
    const hours = typeof limit.number === "number" && limit.number > 0 ? limit.number : 5;
    return { label: "{hours} 小时 Token 配额", params: { hours } };
  }
  if (limit.type === "TIME_LIMIT") return { label: "MCP 月度用量" };
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
    const spec = windowSpec(limit);
    if (!spec) continue;
    const used =
      limit.currentValue ??
      (limit.usage != null && limit.remaining != null ? limit.usage - limit.remaining : undefined);
    const limitValue =
      limit.usage ??
      (limit.remaining != null && limit.currentValue != null ? limit.remaining + limit.currentValue : undefined);
    if (limit.percentage == null && (used == null || limitValue == null)) continue;
    lines.push({
      type: "progress",
      label: spec.label,
      ...(spec.params ? { params: spec.params } : {}),
      ...(used != null && limitValue != null ? { used, limit: limitValue } : {}),
      ...(limit.percentage != null ? { percentUsed: limit.percentage } : {}),
      ...(limit.nextResetTime != null && limit.nextResetTime > 0
        ? { resetsAt: new Date(limit.nextResetTime).toISOString() }
        : {}),
    });
  }
  return lines;
}

/** 配额响应整体处理：区分「未订阅/无数据」与「返回了未识别的类型」两种空结果 */
function processQuota(result: HttpResult): {
  ok: boolean;
  lines: MetricLine[];
  error?: string;
  errorParams?: Record<string, string | number>;
} {
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return {
      ok: false,
      lines: [],
      error: "Coding Plan 配额接口返回 HTTP {status}{detail}",
      errorParams: { status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  try {
    const json = JSON.parse(result.bodyText) as GlmEnvelope<GlmQuotaData>;
    if (json.success === false) {
      return {
        ok: false,
        lines: [],
        error: "Coding Plan 配额查询失败：{detail}",
        errorParams: {
          detail: `code=${json.code ?? "unknown"}${json.msg ? ` msg=${truncate(json.msg, 120)}` : ""}`,
        },
      };
    }
    const lines = parseQuotaLimits(json.data);
    const progressCount = lines.filter((line) => line.type === "progress").length;
    if (progressCount === 0) {
      // 仅剩 badge 行（或全空）不算成功快照：区分「未订阅/无数据」与「类型未识别」
      const hasRawLimits = (json.data?.limits?.length ?? 0) > 0;
      return {
        ok: false,
        lines: [],
        error: hasRawLimits
          ? "配额响应包含未识别的窗口类型，已忽略"
          : "未订阅 Coding Plan 或暂无配额数据",
      };
    }
    return { ok: true, lines };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: "Coding Plan 配额返回数据解析失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }
}

interface SourceOutcome {
  ok: boolean;
  lines: MetricLine[];
  error?: string;
  errorParams?: Record<string, string | number>;
}

/** 余额响应整体处理：解析不出金额（如纯订阅账户无现金数据）按失败处理，仅丢余额行不拖垮快照 */
function processBalance(result: HttpResult): SourceOutcome {
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return {
      ok: false,
      lines: [],
      error: "账户余额接口返回 HTTP {status}{detail}",
      errorParams: { status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  try {
    const json = JSON.parse(result.bodyText) as GlmEnvelope<GlmBalanceData>;
    if (json.success === false) {
      return {
        ok: false,
        lines: [],
        error: "账户余额查询失败：{detail}",
        errorParams: {
          detail: `code=${json.code ?? "unknown"}${json.msg ? ` msg=${truncate(json.msg, 120)}` : ""}`,
        },
      };
    }
    const line = parseBalanceLine(json.data);
    if (!line) {
      return { ok: false, lines: [], error: "账户余额接口未返回可用数据" };
    }
    return { ok: true, lines: [line] };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: "账户余额返回数据解析失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }
}

/** 重置额度响应整体处理：无可用卡是常态（不报错、无行），仅请求/解析失败按失败处理 */
function processReset(result: HttpResult): SourceOutcome {
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return {
      ok: false,
      lines: [],
      error: "重置卡接口返回 HTTP {status}{detail}",
      errorParams: { status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  try {
    const json = JSON.parse(result.bodyText) as GlmEnvelope<GlmPackageResetData>;
    if (json.success === false) {
      return {
        ok: false,
        lines: [],
        error: "重置卡查询失败：{detail}",
        errorParams: {
          detail: `code=${json.code ?? "unknown"}${json.msg ? ` msg=${truncate(json.msg, 120)}` : ""}`,
        },
      };
    }
    const line = parseResetLine(json.data);
    return { ok: true, lines: line ? [line] : [] };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: "重置卡返回数据解析失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }
}

async function fetchGlmSnapshot(instance: ProviderInstance): Promise<ProviderSnapshot> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  const updatedAt = Date.now();
  if (!status.planKey) {
    return {
      instanceId: instance.id,
      providerId: "glm",
      providerName: PROVIDER_NAME,
      status: "needs_config",
      updatedAt,
      message: "请在设置中填写智谱 Coding Plan API Key",
      lines: [],
    };
  }

  // 配额、余额、重置卡三路并行取数，同一枚 Coding Plan Key（ADR-0013/0014）；任一源可用即出快照
  const [quotaSettled, balanceSettled, resetSettled] = await Promise.allSettled([
    invoke<HttpResult>("provider_request", {
      instanceId: instance.id,
      url: QUOTA_URL,
      method: "GET",
      auth: "bearer",
      headers: { Accept: "application/json" },
    }),
    invoke<HttpResult>("provider_request", {
      instanceId: instance.id,
      url: BALANCE_URL,
      method: "GET",
      auth: "bearer",
      headers: { Accept: "application/json" },
    }),
    invoke<HttpResult>("provider_request", {
      instanceId: instance.id,
      url: RESET_URL,
      method: "GET",
      auth: "bearer",
      headers: { Accept: "application/json" },
    }),
  ]);

  const toOutcome = (
    settled: PromiseSettledResult<HttpResult>,
    process: (result: HttpResult) => SourceOutcome,
    failureTemplate: string,
  ): SourceOutcome =>
    settled.status === "fulfilled"
      ? process(settled.value)
      : {
          ok: false,
          lines: [],
          error: failureTemplate,
          errorParams: { detail: toErrorText(settled.reason) },
        };

  const quotaOutcome = toOutcome(quotaSettled, processQuota, "Coding Plan 配额查询失败：{detail}");
  const balanceOutcome = toOutcome(balanceSettled, processBalance, "账户余额查询失败：{detail}");
  const resetOutcome = toOutcome(resetSettled, processReset, "重置卡查询失败：{detail}");

  if (!quotaOutcome.ok && !balanceOutcome.ok && !resetOutcome.ok) {
    // 三源全失败：渲染后的错误串直接拼接（渲染端 t() 对未知键原样返回，与旧版行为一致）
    const detail = [
      applyParams(quotaOutcome.error ?? "", quotaOutcome.errorParams),
      applyParams(balanceOutcome.error ?? "", balanceOutcome.errorParams),
      applyParams(resetOutcome.error ?? "", resetOutcome.errorParams),
    ]
      .filter(Boolean)
      .join("；");
    return {
      instanceId: instance.id,
      providerId: "glm",
      providerName: PROVIDER_NAME,
      status: "error",
      updatedAt,
      message: truncate(detail),
      lines: [],
    };
  }

  const messages: string[] = [];
  const messageParams: Record<string, string | number> = {};
  for (const outcome of [quotaOutcome, balanceOutcome, resetOutcome]) {
    if (!outcome.ok && outcome.error) {
      messages.push(outcome.error);
      Object.assign(messageParams, outcome.errorParams);
    }
  }

  return {
    instanceId: instance.id,
    providerId: "glm",
    providerName: PROVIDER_NAME,
    status: "ok",
    updatedAt,
    ...(messages.length > 0
      ? {
          message: messages.join("；"),
          messageParams,
        }
      : {}),
    lines: [...quotaOutcome.lines, ...balanceOutcome.lines, ...resetOutcome.lines],
  };
}

export const glmProvider: ProviderModule = {
  id: "glm",
  name: "智谱 GLM",
  description: "查询智谱 Coding Plan 配额、用量与账户余额",
  fetch: fetchGlmSnapshot,
};
