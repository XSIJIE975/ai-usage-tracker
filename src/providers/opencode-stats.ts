import { invoke } from "@tauri-apps/api/core";
import { hasOpenCodeConsoleSession, normalizeOpenCodeAuthCookie } from "../lib/utils";
import type { HttpResult, InstanceCredentials, ProviderInstance } from "../types/ipc";
import type { StatsResult } from "./stats-result";

/** 控制台统计页签的区间；请求日志按滚动窗口取 since。 */
export type OpenCodeStatsRange = "24h" | "7d" | "30d";

export interface OpenCodeSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface OpenCodeDailyCost {
  /** 日桶为 YYYY-MM-DD；24h 小时桶可能是 ISO 时刻，渲染端两种都认 */
  date: string;
  costUsd: number;
  tokens: number;
  requests: number;
}

export interface OpenCodeModelUsage {
  model: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface OpenCodeOverview {
  summary: OpenCodeSummary;
  daily: OpenCodeDailyCost[];
  models: OpenCodeModelUsage[];
}

export interface OpenCodeRequestLog {
  id: string;
  startedAt: number;
  /** null = 上游没给（失败请求常见），表格显示 — */
  durationMs: number | null;
  statusCode: number | null;
  outcome: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 控制台日志里的 cost 已经是美元，不是 micro-cents；null = 未计费/缺失 */
  costUsd: number | null;
  sessionId: string;
}

export interface OpenCodeLogsPage {
  items: OpenCodeRequestLog[];
  nextCursor: string | null;
  retentionDays: number;
}

const RANGE_MS: Record<OpenCodeStatsRange, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

const NEEDS_KEY_MESSAGE = "请在配置中填写 OpenCode Go API Key";
const NEEDS_LOGS_MESSAGE = "请在配置中填写 Workspace ID 和 Cookie 才能查看请求日志";
const NEEDS_CONSOLE_COOKIE_MESSAGE =
  "当前 Cookie 不含 __Host-console_session，请重新复制控制台 Cookie";
const API_INVALID_MESSAGE = "OpenCode Go API Key 无效或已过期";
const API_NO_SUBSCRIPTION_MESSAGE = "该 API Key 未开通 OpenCode Go 订阅";
const AUTH_EXPIRED_MESSAGE = "OpenCode 登录态已失效，请在配置中重新复制 Cookie";
const ORG_REQUIRED_MESSAGE = "OpenCode 控制台要求 x-org-id，请核对 Workspace ID";
/** Bearer 走官方用量接口，Cookie 走控制台接口：报错时不能都叫「控制台」 */
const USAGE_HTTP_MESSAGE = "OpenCode 用量接口返回 HTTP {status}";
const CONSOLE_HTTP_MESSAGE = "OpenCode 控制台返回 HTTP {status}";
const USAGE_PARSE_MESSAGE = "OpenCode 用量接口返回结构无法解析";
const CONSOLE_PARSE_MESSAGE = "OpenCode 控制台返回结构无法解析";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const toNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

/** 与 toNumber 同口径，但缺失/非法保留 null——用于「未知」不能冒充 0 的字段 */
const nullableNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const toText = (value: unknown): string => (typeof value === "string" ? value : "");

const microCentsToUsd = (value: unknown): number => toNumber(value) / 100_000_000;

/** `GET /console/api/usage/summary`：总量字段都是十进制字符串，成本是 micro-cents。 */
export function parseOpenCodeSummary(payload: unknown): OpenCodeSummary {
  const root = asRecord(payload);
  const inputTokens = toNumber(root.totalInputTokens);
  const outputTokens = toNumber(root.totalOutputTokens);
  const cacheReadTokens = toNumber(root.totalCacheReadTokens);
  const cacheWriteTokens =
    toNumber(root.totalCacheWrite5mTokens) + toNumber(root.totalCacheWrite1hTokens);
  return {
    requests: toNumber(root.totalRequests),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: microCentsToUsd(root.totalCostMicroCents),
  };
}

/** `GET /console/api/usage/cost-by-day`：数组项 `{date,totalCostMicroCents,totalTokens,totalRequests}`。 */
export function parseOpenCodeDailyCost(payload: unknown): OpenCodeDailyCost[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item) => {
      const root = asRecord(item);
      return {
        date: toText(root.date),
        costUsd: microCentsToUsd(root.totalCostMicroCents),
        tokens: toNumber(root.totalTokens),
        requests: toNumber(root.totalRequests),
      };
    })
    .filter((item) => item.date !== "")
    // 控制台按升序出图；接口若改序也不会把折线画反
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** `GET /console/api/usage/models`：一页 `items[]` + `pageInfo.pageCount`。 */
export function parseOpenCodeModelUsage(payload: unknown): {
  items: OpenCodeModelUsage[];
  pageCount: number;
} {
  const root = asRecord(payload);
  const items = Array.isArray(root.items)
    ? root.items.map((item) => {
        const record = asRecord(item);
        return {
          model: toText(record.model),
          provider: toText(record.provider),
          requests: toNumber(record.totalRequests),
          inputTokens: toNumber(record.totalInputTokens),
          outputTokens: toNumber(record.totalOutputTokens),
          cacheReadTokens: toNumber(record.totalCacheReadTokens),
          cacheWriteTokens:
            toNumber(record.totalCacheWrite5mTokens) + toNumber(record.totalCacheWrite1hTokens),
          costUsd: microCentsToUsd(record.totalCostMicroCents),
        };
      })
    : [];
  const pageInfo = asRecord(root.pageInfo);
  return { items, pageCount: Math.max(1, toNumber(pageInfo.pageCount)) };
}

/** `GET /console/api/request-logs`：一页请求明细 + 游标。 */
export function parseOpenCodeRequestLogs(payload: unknown): OpenCodeLogsPage {
  const root = asRecord(payload);
  const items = Array.isArray(root.items)
    ? root.items.map((item) => {
        const record = asRecord(item);
        const status = toNumber(record.statusCode);
        return {
          // id/requestID 都缺失时用起点+会话拼一个稳定兜底，避免整列空 key
          id:
            toText(record.id) ||
            toText(record.requestID) ||
            `${toNumber(record.startedAt)}:${toText(record.sessionID)}`,
          startedAt: toNumber(record.startedAt),
          durationMs: nullableNumber(record.durationMs),
          statusCode: status > 0 ? status : null,
          outcome: toText(record.outcome),
          model: toText(record.model) || toText(record.requestedModel),
          provider: toText(record.provider),
          inputTokens: toNumber(record.inputTokens),
          outputTokens: toNumber(record.outputTokens),
          reasoningTokens: toNumber(record.reasoningTokens),
          cacheReadTokens: toNumber(record.cacheReadTokens),
          cacheWriteTokens: toNumber(record.cacheWriteTokens),
          costUsd: nullableNumber(record.cost),
          sessionId: toText(record.sessionID),
        };
      })
    : [];
  const nextCursor = toText(root.nextCursor);
  return {
    items,
    nextCursor: nextCursor === "" ? null : nextCursor,
    retentionDays: toNumber(root.retentionDays),
  };
}

/** 概览统计只认 API Key；服务 Key 已实测可读 summary / cost-by-day / models。 */
async function loadOverviewCredentials(
  instance: ProviderInstance,
): Promise<StatsResult<null>> {
  const credentials = await invoke<InstanceCredentials>("vault_credentials", {
    instanceId: instance.id,
  });
  return credentials.apiKey?.trim()
    ? { status: "ok", data: null }
    : { status: "needs_config", message: NEEDS_KEY_MESSAGE };
}

/** 请求日志与余额一样需要控制台登录态；服务 Key 打 request-logs 会回 403。 */
async function loadLogsCredentials(
  instance: ProviderInstance,
): Promise<StatsResult<{ workspaceId: string }>> {
  const credentials = await invoke<InstanceCredentials>("vault_credentials", {
    instanceId: instance.id,
  });
  const workspaceId = credentials.workspaceId?.trim() ?? "";
  const cookie = credentials.cookie?.trim() ?? "";
  if (!workspaceId || !cookie) return { status: "needs_config", message: NEEDS_LOGS_MESSAGE };
  // 旧版存的是裸值：先按请求侧同一套规则归一化，再判断有没有控制台会话
  if (!hasOpenCodeConsoleSession(normalizeOpenCodeAuthCookie(cookie))) {
    return { status: "needs_config", message: NEEDS_CONSOLE_COOKIE_MESSAGE };
  }
  return { status: "ok", data: { workspaceId } };
}

async function requestJson(
  instance: ProviderInstance,
  path: string,
  auth: "bearer" | "cookie",
  workspaceId?: string,
): Promise<StatsResult<unknown>> {
  const http = await invoke<HttpResult>("provider_request", {
    instanceId: instance.id,
    url: `https://opencode.ai${path}`,
    method: "GET",
    auth,
    headers:
      auth === "cookie"
        ? { Accept: "application/json", "x-org-id": workspaceId ?? "" }
        : { Accept: "application/json" },
  });
  if (auth === "bearer") {
    if (http.status === 401) return { status: "error", message: API_INVALID_MESSAGE };
    if (http.status === 403) return { status: "error", message: API_NO_SUBSCRIPTION_MESSAGE };
  } else {
    if (http.status === 401 || http.status === 403) {
      return { status: "error", message: AUTH_EXPIRED_MESSAGE };
    }
    if (http.status === 400) return { status: "error", message: ORG_REQUIRED_MESSAGE };
  }
  if (http.status !== 200) {
    return {
      status: "error",
      message: auth === "bearer" ? USAGE_HTTP_MESSAGE : CONSOLE_HTTP_MESSAGE,
      params: { status: http.status },
    };
  }
  try {
    return { status: "ok", data: JSON.parse(http.bodyText) };
  } catch {
    return {
      status: "error",
      message: auth === "bearer" ? USAGE_PARSE_MESSAGE : CONSOLE_PARSE_MESSAGE,
    };
  }
}

async function fetchAllModels(
  instance: ProviderInstance,
  range: OpenCodeStatsRange,
): Promise<StatsResult<OpenCodeModelUsage[]>> {
  const items: OpenCodeModelUsage[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await requestJson(
      instance,
      `/console/api/usage/models?range=${range}&page=${page}&pageSize=100&costOrder=desc&includeLegacyKeys=true`,
      "bearer",
    );
    if (result.status !== "ok") return result;
    const parsed = parseOpenCodeModelUsage(result.data);
    items.push(...parsed.items);
    if (page >= parsed.pageCount) break;
  }
  return { status: "ok", data: items };
}

/** 概览：summary + 按日成本 + 按模型用量，三路并行，全部走 API Key。 */
export async function fetchOpenCodeOverview(
  instance: ProviderInstance,
  range: OpenCodeStatsRange,
): Promise<StatsResult<OpenCodeOverview>> {
  const credentials = await loadOverviewCredentials(instance);
  if (credentials.status !== "ok") return credentials;
  const bucket = range === "24h" ? "hour" : "day";
  const [summaryResult, dailyResult, modelsResult] = await Promise.all([
    requestJson(instance, `/console/api/usage/summary?range=${range}`, "bearer"),
    requestJson(
      instance,
      `/console/api/usage/cost-by-day?range=${range}&bucket=${bucket}`,
      "bearer",
    ),
    fetchAllModels(instance, range),
  ]);
  if (summaryResult.status !== "ok") return summaryResult;
  if (dailyResult.status !== "ok") return dailyResult;
  if (modelsResult.status !== "ok") return modelsResult;
  return {
    status: "ok",
    data: {
      summary: parseOpenCodeSummary(summaryResult.data),
      daily: parseOpenCodeDailyCost(dailyResult.data),
      models: modelsResult.data,
    },
  };
}

/** 请求日志：控制台登录态 + 滚动 since + 游标翻页。 */
export async function fetchOpenCodeLogs(
  instance: ProviderInstance,
  range: OpenCodeStatsRange,
  cursor?: string,
): Promise<StatsResult<OpenCodeLogsPage>> {
  const credentials = await loadLogsCredentials(instance);
  if (credentials.status !== "ok") return credentials;
  const params = new URLSearchParams({
    since: String(Date.now() - RANGE_MS[range]),
    limit: "50",
    // 只取推理请求；控制台自身的 console/api 调用也在同一张表里，混进来会让模型/Token/成本列全空
    category: "inference",
  });
  if (cursor) params.set("cursor", cursor);
  const result = await requestJson(
    instance,
    `/console/api/request-logs?${params.toString()}`,
    "cookie",
    credentials.data.workspaceId,
  );
  if (result.status !== "ok") return result;
  return { status: "ok", data: parseOpenCodeRequestLogs(result.data) };
}
