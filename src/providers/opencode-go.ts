import { invoke } from "@tauri-apps/api/core";
import { hasOpenCodeConsoleSession, normalizeOpenCodeAuthCookie } from "../lib/utils";
import type {
  HttpResult,
  InstanceCredentialStatus,
  InstanceCredentials,
  MetricLine,
  ProviderInstance,
  ProviderSnapshot,
} from "../types/ipc";
import type { ProviderModule } from "./types";

// 窗口周期（ADR-0017 层序键）：rolling=5 小时、weekly=7 天、monthly=30 天。
// 月取 30 天为约定近似——层序只需量级序（小时 ≪ 周 ≪ 月），不影响排序结果
const WINDOWS = {
  rolling: { label: "5 小时额度", periodMs: 5 * 3_600_000 },
  weekly: { label: "本周额度", periodMs: 7 * 86_400_000 },
  monthly: { label: "本月额度", periodMs: 30 * 86_400_000 },
} as const;

type WindowKey = keyof typeof WINDOWS;

interface UsageWindow {
  usagePercent: number;
  /** 距下次重置的秒数；null = 上游没给重置时刻 */
  resetInSec: number | null;
}

type WindowMap = Partial<Record<WindowKey, UsageWindow>>;

/** 官方用量接口（Bearer API Key）：三个窗口的百分比与重置时刻。 */
const API_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** 控制台余额接口（Cookie + x-org-id）：Zen 预付余额，micro-cents 字符串。 */
const BILLING_STATUS_URL = "https://opencode.ai/console/api/billing/status";

const NEEDS_CONFIG_MESSAGE = "请在配置中填写 OpenCode Go API Key";
const API_INVALID_MESSAGE = "OpenCode Go API Key 无效或已过期";
const API_NO_SUBSCRIPTION_MESSAGE = "该 API Key 未开通 OpenCode Go 订阅";
const API_HTTP_MESSAGE = "OpenCode Go 用量接口返回 HTTP {status}";
const API_PARSE_MESSAGE = "OpenCode Go 用量接口返回结构无法解析";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** 余额是可选装饰：最多等 5s，避免控制台挂住把整张卡片拖到 HTTP 超时 */
const BALANCE_TIMEOUT_MS = 5_000;
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

/** ISO 时刻 → 距 now 的秒数；解析不了返回 null */
const resetInSecFrom = (value: unknown, now: number): number | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((at - now) / 1000));
};

/** 同时兼容相对秒数（resetInSec 族）与绝对时刻（resetsAt 族） */
const resetInSecOf = (meter: Record<string, unknown>, now: number): number | null => {
  const relative =
    numberValue(meter.resetInSec) ??
    numberValue(meter.resetInSeconds) ??
    numberValue(meter.resetsInSec);
  if (relative !== null) return Math.max(0, Math.round(relative));
  return resetInSecFrom(meter.resetsAt ?? meter.resetAt, now);
};

/**
 * 百分比口径：官方接口的 `percent` 是 0–100，不做「≤1 视为比例」的猜测——
 * 0.5% 与 50% 必须按上游字面值读。
 */
const percentOf = (meter: Record<string, unknown>): number | null => {
  const direct =
    numberValue(meter.percent) ??
    numberValue(meter.usagePercent) ??
    numberValue(meter.usedPercent);
  if (direct !== null) return clampPercent(direct);
  const used = numberValue(meter.used) ?? numberValue(meter.usedMicroCents);
  const limit = numberValue(meter.limit) ?? numberValue(meter.limitMicroCents);
  if (used !== null && limit !== null && limit > 0) return clampPercent((used / limit) * 100);
  return null;
};

/**
 * 官方 `GET /zen/go/v1/usage`：`{ usage: { rolling, weekly, monthly } }`，
 * 每项 `{ percent: 0–100, resetsAt | resetInSec }`。账号级接口，不需要 Workspace ID。
 */
export function parseOpenCodeApiUsage(text: string, now: number): WindowMap | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const usage = asRecord(asRecord(payload).usage);
  if (Object.keys(asRecord(usage.rolling)).length === 0) return null;
  const windows: WindowMap = {};
  for (const key of ["rolling", "weekly", "monthly"] as const) {
    const meter = asRecord(usage[key]);
    if (Object.keys(meter).length === 0) continue;
    const usagePercent = percentOf(meter);
    if (usagePercent === null) continue;
    windows[key] = { usagePercent, resetInSec: resetInSecOf(meter, now) };
  }
  return windows.rolling === undefined ? null : windows;
}

/**
 * 控制台 `GET /console/api/billing/status`：`balanceMicroCents` 是十进制字符串
 * （1e8 = $1），可带负号。缺失或非数字返回 null——不拿 `availableMicroCents`
 * 顶替余额，它是另一项信用额度。
 */
export function parseOpenCodeBalance(text: string): number | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const microCents = numberValue(asRecord(payload).balanceMicroCents);
  return microCents === null ? null : microCents / 100_000_000;
}

function buildLines(windows: WindowMap, updatedAt: number): MetricLine[] {
  const lines: MetricLine[] = [];
  for (const key of ["rolling", "weekly", "monthly"] as const) {
    const window = windows[key];
    const config = WINDOWS[key];
    if (!window || !config) continue;
    const line: MetricLine = {
      type: "progress",
      label: config.label,
      percentUsed: Math.max(0, window.usagePercent),
      windowPeriodMs: config.periodMs,
    };
    if (window.resetInSec !== null) {
      line.resetsAt = new Date(updatedAt + window.resetInSec * 1000).toISOString();
    }
    lines.push(line);
  }
  return lines;
}

function balanceLine(balanceUsd: number): MetricLine {
  return {
    type: "text",
    label: "Zen 余额",
    value: usdFormatter.format(balanceUsd),
    balance: true,
  };
}

/** 余额是可选数据：凭据没配、请求失败或字段缺失都返回 null，不影响额度快照 */
async function fetchBalance(
  instance: ProviderInstance,
  workspaceId: string,
): Promise<number | null> {
  const result = await invoke<HttpResult>("provider_request", {
    instanceId: instance.id,
    url: BILLING_STATUS_URL,
    method: "GET",
    auth: "cookie",
    headers: {
      Accept: "application/json",
      "x-org-id": workspaceId,
    },
  });
  if (result.status !== 200) return null;
  return parseOpenCodeBalance(result.bodyText);
}

function okSnapshot(
  instance: ProviderInstance,
  updatedAt: number,
  lines: MetricLine[],
): ProviderSnapshot {
  return {
    instanceId: instance.id,
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    status: "ok",
    updatedAt,
    lines,
  };
}

function errorSnapshot(
  instance: ProviderInstance,
  updatedAt: number,
  message: string,
  messageParams?: Record<string, string | number>,
): ProviderSnapshot {
  return {
    instanceId: instance.id,
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    status: "error",
    updatedAt,
    message,
    messageParams,
    lines: [],
  };
}

function needsConfigSnapshot(instance: ProviderInstance, updatedAt: number): ProviderSnapshot {
  return {
    instanceId: instance.id,
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    status: "needs_config",
    updatedAt,
    message: NEEDS_CONFIG_MESSAGE,
    lines: [],
  };
}

async function fetchUsage(instance: ProviderInstance): Promise<ProviderSnapshot> {
  const [status, credentials] = await Promise.all([
    invoke<InstanceCredentialStatus>("vault_credential_status", { instanceId: instance.id }),
    invoke<InstanceCredentials>("vault_credentials", { instanceId: instance.id }),
  ]);
  const updatedAt = Date.now();
  if (!status.apiKey) return needsConfigSnapshot(instance, updatedAt);

  const workspaceId = credentials.workspaceId?.trim() ?? "";
  const cookie = credentials.cookie?.trim() ?? "";
  // 余额凭据是选填的一对：两格都填、且 Cookie 真含控制台会话才查；
  // 旧版 auth Cookie 必然被 billing/status 拒绝，不发这次注定失败的请求
  const consoleCookie = normalizeOpenCodeAuthCookie(cookie);
  const balanceTask =
    workspaceId && consoleCookie && hasOpenCodeConsoleSession(consoleCookie)
      ? withTimeout(fetchBalance(instance, workspaceId), BALANCE_TIMEOUT_MS)
      : Promise.resolve(null);

  const official = await invoke<HttpResult>("provider_request", {
    instanceId: instance.id,
    url: API_USAGE_URL,
    method: "GET",
    auth: "bearer",
    headers: { Accept: "application/json" },
  });
  if (official.status === 401) {
    return errorSnapshot(instance, updatedAt, API_INVALID_MESSAGE);
  }
  if (official.status === 403) {
    return errorSnapshot(instance, updatedAt, API_NO_SUBSCRIPTION_MESSAGE);
  }
  if (official.status !== 200) {
    return errorSnapshot(instance, updatedAt, API_HTTP_MESSAGE, { status: official.status });
  }
  const windows = parseOpenCodeApiUsage(official.bodyText, updatedAt);
  if (!windows) return errorSnapshot(instance, updatedAt, API_PARSE_MESSAGE);

  const lines = buildLines(windows, updatedAt);
  const balance = await balanceTask;
  if (balance !== null) lines.push(balanceLine(balance));
  return okSnapshot(instance, updatedAt, lines);
}

export const opencodeGoProvider: ProviderModule = {
  id: "opencode-go",
  name: "OpenCode Go",
  description: "读取 OpenCode Go 订阅的 5 小时/周/月额度与 Zen 余额",
  fetch: fetchUsage,
};
