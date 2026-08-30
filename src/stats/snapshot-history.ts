import { invoke } from "@tauri-apps/api/core";
import type { ProviderSnapshot, StoredSnapshot } from "../types/ipc";

export interface MetricPoint {
  /** 快照时间（毫秒时间戳） */
  t: number;
  /** 主指标数值：DeepSeek=余额、OpenCode Go=本月已用百分比 */
  v: number;
}

export interface ProviderHistory {
  points: MetricPoint[];
  /** 主指标行的重置时间（OpenCode 本月额度有；DeepSeek 无） */
  resetsAt?: string;
}

export const HISTORY_DAYS = 7;

/** 解析货币/数字字符串为数值（"¥1,234.56" / "$12.3" / "-3.2"）；无法解析返回 null */
export function parseMetricValue(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * 从快照抽取主指标，按结构而非文案匹配（对 i18n 与供应商扩展稳健）：
 * - 存在 progress 行时取 resetsAt 最远的一行（OpenCode：本月额度是重置周期最长的窗口）
 * - 否则取第一个可解析数值的 text 行（DeepSeek：badge 之后第一个 text 就是账户余额）
 */
export function extractMetric(
  snapshot: ProviderSnapshot,
): { value: number; resetsAt?: string } | null {
  const progressLines = snapshot.lines.filter(
    (line) => line.type === "progress" && typeof line.percentUsed === "number",
  );
  if (progressLines.length > 0) {
    const primary = progressLines.reduce((a, b) =>
      (a.resetsAt ?? "") >= (b.resetsAt ?? "") ? a : b,
    );
    if (typeof primary.percentUsed === "number") {
      return { value: primary.percentUsed, resetsAt: primary.resetsAt };
    }
  }
  for (const line of snapshot.lines) {
    if (line.type !== "text" || typeof line.value !== "string") continue;
    const value = parseMetricValue(line.value);
    if (value !== null) return { value };
  }
  return null;
}

/** 按小时降采样：同一小时保留最后一个点，输出按时间升序 */
export function downsampleByHour(points: MetricPoint[]): MetricPoint[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const buckets = new Map<number, MetricPoint>();
  for (const point of sorted) {
    buckets.set(Math.floor(point.t / 3_600_000), point);
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/** 拉取供应商近 N 天快照并转为主指标序列（升序、按小时降采样） */
export async function loadProviderHistory(
  providerId: string,
  days = HISTORY_DAYS,
): Promise<ProviderHistory> {
  const sinceMs = Date.now() - days * 86_400_000;
  const rows = await invoke<StoredSnapshot[]>("list_snapshots", {
    providerId,
    sinceMs,
    limit: 2000,
  });
  const points: MetricPoint[] = [];
  let resetsAt: string | undefined;
  for (const row of rows) {
    const payload = row.payload as ProviderSnapshot | null;
    if (!payload || payload.status !== "ok") continue;
    const metric = extractMetric(payload);
    if (!metric) continue;
    points.push({ t: row.captured_at, v: metric.value });
    if (metric.resetsAt) resetsAt = metric.resetsAt;
  }
  return { points: downsampleByHour(points), resetsAt };
}
