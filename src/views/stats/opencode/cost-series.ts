import type { StackedSeries } from "../../../components/charts/StackedBars";
import type { OpenCodeDailyCostPoint } from "../../../providers/opencode-stats";

/** costs 中去重后的模型列表（保持首次出现顺序）。 */
export const dedupeModels = (costs: OpenCodeDailyCostPoint[]): string[] => [
  ...new Set(costs.map((point) => point.model).filter((model) => model !== "")),
];

/** 有数据的日期升序去重（原始 "YYYY-MM-DD"），作为图表 x 轴。 */
export const collectCostDays = (costs: OpenCodeDailyCostPoint[]): string[] =>
  [...new Set(costs.map((point) => point.date))].sort();

/** "YYYY-MM-DD" → "M月D日" */
export const formatCostDayLabel = (day: string): string => {
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日`;
};

/** 按模型对齐的堆叠序列：每个模型一条 series，值与 days 对齐。 */
export const buildCostSeries = (
  costs: OpenCodeDailyCostPoint[],
  days: string[],
  models: string[],
): StackedSeries[] => {
  const indexOfDay = new Map<string, number>(days.map((day, i) => [day, i]));
  const acc = new Map<string, number[]>(models.map((model) => [model, days.map(() => 0)]));
  for (const point of costs) {
    const values = acc.get(point.model);
    const at = indexOfDay.get(point.date);
    if (values === undefined || at === undefined) continue;
    values[at] += point.costUsd;
  }
  return models.map((model) => ({ name: model, values: acc.get(model) ?? days.map(() => 0) }));
};

export const sumCostUsd = (costs: OpenCodeDailyCostPoint[]): number =>
  costs.reduce((total, point) => total + point.costUsd, 0);
