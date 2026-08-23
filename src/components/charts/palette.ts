/**
 * 图表色板（全局唯一取色入口）。
 *
 * 1. 静态类名映射：Tailwind 只能扫描源码中出现的完整类名，
 *    动态拼接（如 `fill-chart-${i}`）不会被生成 —— 因此必须用这里的静态数组。
 * 2. 全局模型 → 颜色注册表：保证同一模型在所有图表中颜色一致；
 *    未知模型按名称哈希兜底，同一张图内仍能保持区分度。
 */

export const CHART_FILLS = [
  "fill-chart-1",
  "fill-chart-2",
  "fill-chart-3",
  "fill-chart-4",
  "fill-chart-5",
  "fill-chart-6",
] as const;

export const CHART_BGS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-chart-6",
] as const;

export const CHART_STROKES = [
  "stroke-chart-1",
  "stroke-chart-2",
  "stroke-chart-3",
  "stroke-chart-4",
  "stroke-chart-5",
  "stroke-chart-6",
] as const;

export const CHART_COLOR_COUNT = CHART_FILLS.length;

/** 已知模型的固定配色（索引 0..5 对应 chart-1..6） */
const MODEL_COLOR_INDEX: Record<string, number> = {
  // DeepSeek 官方
  "deepseek-chat": 0,
  "deepseek-reasoner": 1,
  "deepseek-v4-flash": 2,
  // OpenCode Go
  "deepseek-v4-flash (go)": 0,
  "glm-5.2 (go)": 1,
  "gpt-5.6-luna (go)": 2,
  "hy3 (go)": 3,
  "mimo-v2.5 (go)": 4,
  "muse-spark-1.2 (go)": 5,
};

function hashIndex(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % CHART_COLOR_COUNT;
}

/** 取模型的全局颜色索引（0..5），保证跨图表一致 */
export function modelColorIndex(model: string): number {
  return MODEL_COLOR_INDEX[model] ?? hashIndex(model);
}
