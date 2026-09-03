import { invoke } from "@tauri-apps/api/core";
import type {
  HttpResult,
  InstanceCredentialStatus,
  MetricLine,
  ProviderInstance,
  ProviderSnapshot,
} from "../types/ipc";
import type { ProviderModule } from "./types";

// 端点与响应结构以 GLM_PROVIDER_PLAN.md 3.2/3.3/3.4 的实测结论为准（2026-09-01）：
// - 配额：open.bigmodel.cn/api/monitor/usage/quota/limit（Coding Plan API Key 鉴权，
//   与智谱官方 glm-plan-usage 插件同款用法，Bearer/裸值均可用）
// 按量付费余额通道（控制台登录 JWT + query-customer-account-report）已于 2026-09-02 移除。
const QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

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

  let outcome: {
    ok: boolean;
    lines: MetricLine[];
    error?: string;
    errorParams?: Record<string, string | number>;
  };
  try {
    const result = await invoke<HttpResult>("provider_request", {
      instanceId: instance.id,
      url: QUOTA_URL,
      method: "GET",
      auth: "bearer",
      headers: { Accept: "application/json" },
    });
    outcome = processQuota(result);
  } catch (error) {
    outcome = {
      ok: false,
      lines: [],
      error: "Coding Plan 配额查询失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }

  if (!outcome.ok) {
    return {
      instanceId: instance.id,
      providerId: "glm",
      providerName: PROVIDER_NAME,
      status: "error",
      updatedAt,
      message: outcome.error ?? "Coding Plan 配额查询失败",
      messageParams: outcome.errorParams,
      lines: [],
    };
  }

  return {
    instanceId: instance.id,
    providerId: "glm",
    providerName: PROVIDER_NAME,
    status: "ok",
    updatedAt,
    lines: outcome.lines,
  };
}

export const glmProvider: ProviderModule = {
  id: "glm",
  name: "智谱 GLM",
  description: "查询智谱 Coding Plan 配额与用量",
  fetch: fetchGlmSnapshot,
};
