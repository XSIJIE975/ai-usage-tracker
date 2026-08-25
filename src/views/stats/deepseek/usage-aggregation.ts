import type { StackedSeries } from "../../../components/charts/StackedBars";
import type { DeepSeekDailyRow } from "../../../providers/deepseek-stats";

export type UsageMetric = "tokens" | "requests" | "cost";

export interface ModelUsage {
  model: string;
  /** 输入 Token = 缓存命中 + 缓存未命中 */
  inputTokens: number;
  cacheHitTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  costCny: number;
}

export interface UsageAggregates {
  perModel: ModelUsage[];
  totalTokens: number;
  totalRequests: number;
  totalCostCny: number;
  /** 有数据的天数（日均分母） */
  days: number;
}

const rowInputTokens = (row: DeepSeekDailyRow): number => row.cacheHitTokens + row.cacheMissTokens;

/** 按 (模型 → 指标) 汇总；perModel 按合计 Token 降序。 */
export const aggregateUsage = (rows: DeepSeekDailyRow[]): UsageAggregates => {
  const byModel = new Map<string, ModelUsage>();
  let totalTokens = 0;
  let totalRequests = 0;
  let totalCostCny = 0;
  const activeDays = new Set<string>();

  for (const row of rows) {
    const input = rowInputTokens(row);
    const entry = byModel.get(row.model) ?? {
      model: row.model,
      inputTokens: 0,
      cacheHitTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
      costCny: 0,
    };
    entry.inputTokens += input;
    entry.cacheHitTokens += row.cacheHitTokens;
    entry.outputTokens += row.outputTokens;
    entry.totalTokens += input + row.outputTokens;
    entry.requests += row.requests;
    entry.costCny += row.costCny;
    byModel.set(row.model, entry);

    totalTokens += input + row.outputTokens;
    totalRequests += row.requests;
    totalCostCny += row.costCny;
    activeDays.add(row.day);
  }

  const perModel = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return { perModel, totalTokens, totalRequests, totalCostCny, days: activeDays.size };
};

/** "YYYY-MM-DD" → "M月D日" */
export const formatDayLabel = (day: string): string => {
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日`;
};

/** 行内出现过的日期升序去重，作为图表 x 轴。 */
export const collectDayLabels = (rows: DeepSeekDailyRow[]): string[] =>
  [...new Set(rows.map((row) => row.day))].sort();

const metricValue = (row: DeepSeekDailyRow, metric: UsageMetric): number => {
  if (metric === "requests") return row.requests;
  if (metric === "cost") return row.costCny;
  return rowInputTokens(row) + row.outputTokens;
};

/** 日 × 模型 堆叠序列：每个模型一条 series，值与 labels 对齐；按合计降序。 */
export const buildStackedSeries = (
  rows: DeepSeekDailyRow[],
  labels: string[],
  metric: UsageMetric,
): StackedSeries[] => {
  const indexOfDay = new Map<string, number>(labels.map((day, i) => [day, i]));
  const acc = new Map<string, number[]>();
  for (const row of rows) {
    const at = indexOfDay.get(row.day);
    if (at === undefined) continue;
    const values = acc.get(row.model) ?? labels.map(() => 0);
    values[at] += metricValue(row, metric);
    acc.set(row.model, values);
  }
  return [...acc.entries()]
    .map(([name, values]) => ({ name, values }))
    .sort((a, b) => sum(b.values) - sum(a.values));
};

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
