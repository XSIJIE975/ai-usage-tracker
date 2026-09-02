import type { StackedSeries } from "../../../components/charts/StackedBars";
import type { GlmModelUsage } from "../../../providers/glm-stats";

/** 桶起点 → 本地自然日（"YYYY-MM-DD HH:mm" / "YYYY-MM-DD" 均取前 10 位） */
export const bucketDay = (bucket: string): string => bucket.slice(0, 10);

export interface DailyTotals {
  /** 稠密自然日序列（含无消耗日），作图表 x 轴 */
  days: string[];
  /** 各日全模型合计 Token */
  tokens: number[];
  /** 各日全模型合计请求次数 */
  calls: number[];
}

/** 逐桶数据按自然日归并：hourly/daily 粒度统一处理，跨日的 hourly 桶归入起始日 */
export function dailyTotals(usage: GlmModelUsage): DailyTotals {
  const days: string[] = [];
  const tokens: number[] = [];
  const calls: number[] = [];
  usage.buckets.forEach((bucket, index) => {
    const day = bucketDay(bucket);
    const last = days.length - 1;
    const bucketTokens = usage.tokens[index] ?? 0;
    const bucketCalls = usage.callCount[index] ?? 0;
    if (last >= 0 && days[last] === day) {
      tokens[last] += bucketTokens;
      calls[last] += bucketCalls;
    } else {
      days.push(day);
      tokens.push(bucketTokens);
      calls.push(bucketCalls);
    }
  });
  return { days, tokens, calls };
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

/** 模型 × 日 的 Token 堆叠序列（按合计降序），days 为 dailyTotals 的 x 轴 */
export function buildModelSeries(usage: GlmModelUsage, days: string[]): StackedSeries[] {
  const indexOfDay = new Map(days.map((day, index) => [day, index]));
  return usage.models
    .map((model) => {
      const values = days.map(() => 0);
      model.tokens.forEach((value, index) => {
        const at = indexOfDay.get(bucketDay(usage.buckets[index] ?? ""));
        if (at !== undefined) values[at] += value;
      });
      return { name: model.name, values };
    })
    .sort((a, b) => sum(b.values) - sum(a.values));
}

/** 请求次数序列：接口只给全模型合计，单序列展示 */
export function buildCallsSeries(calls: number[]): StackedSeries[] {
  return [{ name: "全部模型", values: [...calls] }];
}

export interface GlmModelAggregate {
  name: string;
  tokens: number;
  share: number;
}

export interface GlmUsageAggregates {
  perModel: GlmModelAggregate[];
  totalTokens: number;
  totalCalls: number;
  /** 范围内自然日数（稠密，含无消耗日；日均分母） */
  days: number;
}

export function aggregateModelUsage(usage: GlmModelUsage): GlmUsageAggregates {
  const totalTokens = usage.totals.tokens;
  return {
    perModel: usage.models.map((model) => ({
      name: model.name,
      tokens: model.totalTokens,
      share: totalTokens > 0 ? (model.totalTokens / totalTokens) * 100 : 0,
    })),
    totalTokens,
    totalCalls: usage.totals.calls,
    days: dailyTotals(usage).days.length,
  };
}

/** "YYYY-MM-DD" → "M月D日"（与 DeepSeek 统计的 x 轴一致） */
export const formatDayLabel = (day: string): string => {
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日`;
};
