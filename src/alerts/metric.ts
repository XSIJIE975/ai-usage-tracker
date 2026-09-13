import type { MetricLine, ProviderSnapshot } from "../types/ipc";

/** 解析货币/数字字符串为数值（"¥1,234.56" / "$12.3" / "-3.2"）；无法解析返回 null */
export function parseMetricValue(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * 主指标对应的进度行：重置周期最长的一行（OpenCode：本月额度；GLM：周配额）。
 * 按结构而非文案匹配（对 i18n 与供应商扩展稳健）。无进度行返回 null。
 *
 * 排序口径：有 resetsAt 的行用重置时刻；缺失时（GLM 滚动窗只在有消耗时下发
 * nextResetTime）不能用「空串=最近」参与比较——那会让周窗落选、阈值告警退化为盯
 * 5h 短窗的日常冲高——改用结构化周期 windowPeriodMs（ADR-0017）外推：周期越长
 * 离下一次重置越远。
 */
export function primaryProgressLine(lines: MetricLine[]): MetricLine | null {
  const progressLines = lines.filter(
    (line) => line.type === "progress" && typeof line.percentUsed === "number",
  );
  if (progressLines.length === 0) return null;
  const now = Date.now();
  const resetDistance = (line: MetricLine): number => {
    if (line.resetsAt) {
      const parsed = Date.parse(line.resetsAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    return now + (line.windowPeriodMs ?? 0);
  };
  return progressLines.reduce((a, b) => (resetDistance(a) >= resetDistance(b) ? a : b));
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
