import type { ProviderSnapshot } from "../types/ipc";

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
