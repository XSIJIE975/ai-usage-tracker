import type { MetricLine, ProviderSnapshot } from "../types/ipc";

/** 解析货币/数字字符串为数值（"¥1,234.56" / "$12.3" / "-3.2"）；无法解析返回 null */
export function parseMetricValue(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * 主指标对应的进度行：resetsAt 最远的一行（OpenCode：本月额度是重置周期最长的窗口；GLM：周配额）。
 * 按结构而非文案匹配（对 i18n 与供应商扩展稳健）。无进度行返回 null。
 */
export function primaryProgressLine(lines: MetricLine[]): MetricLine | null {
  const progressLines = lines.filter(
    (line) => line.type === "progress" && typeof line.percentUsed === "number",
  );
  if (progressLines.length === 0) return null;
  return progressLines.reduce((a, b) =>
    (a.resetsAt ?? "") >= (b.resetsAt ?? "") ? a : b,
  );
}

/** 账户余额所在的 text 行（第一个可解析数值的 text 行），供展示余额原文；无则 null */
export function firstBalanceLine(lines: MetricLine[]): MetricLine | null {
  for (const line of lines) {
    if (line.type !== "text" || typeof line.value !== "string") continue;
    if (parseMetricValue(line.value) === null) continue;
    return line;
  }
  return null;
}

/**
 * 从快照抽取主指标：
 * - 存在 progress 行时取主指标行（见 primaryProgressLine）的已用百分比
 * - 否则取第一个可解析数值的 text 行（DeepSeek：badge 之后第一个 text 就是账户余额）
 */
export function extractMetric(
  snapshot: ProviderSnapshot,
): { value: number; resetsAt?: string } | null {
  const primary = primaryProgressLine(snapshot.lines);
  if (primary && typeof primary.percentUsed === "number") {
    return { value: primary.percentUsed, resetsAt: primary.resetsAt };
  }
  const balance = extractBalanceValue(snapshot);
  return balance !== null ? { value: balance } : null;
}

/**
 * 从快照抽取账户余额数值。与主指标相互独立：
 * GLM 快照同时含 progress 行（配额）与 text 行（账户余额），主指标取配额百分比，
 * 余额告警规则用本函数取余额数值。
 */
export function extractBalanceValue(snapshot: ProviderSnapshot): number | null {
  const line = firstBalanceLine(snapshot.lines);
  return line && typeof line.value === "string" ? parseMetricValue(line.value) : null;
}
