/**
 * 图表色板（全局唯一取色入口）。
 *
 * 1. 静态类名映射：Tailwind 只能扫描源码中出现的完整类名，
 *    动态拼接（如 `fill-chart-${i}`）不会被生成 —— 因此必须用这里的静态数组。
 * 2. 全局模型 → 颜色注册表：保证同一模型在所有图表中颜色一致；
 *    未知模型按名称哈希兜底，同一张图内仍能保持区分度。
 * 3. HEX 色值：供 ECharts 等第三方图表库使用。
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

/** 浅色主题 hex 色值（与 CSS 变量 --chart-1..6 对应） */
export const CHART_HEX_LIGHT = [
  "#6a63f0",
  "#0d9488",
  "#d97706",
  "#e11d48",
  "#0284c7",
  "#65a30d",
];

/** 深色主题 hex 色值（与 CSS 变量 --chart-1..6 对应） */
export const CHART_HEX_DARK = [
  "#8183f8",
  "#2dd4bf",
  "#fbbf24",
  "#fb7185",
  "#38bdf8",
  "#a3e635",
];

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

/** 取指定索引的 hex 色值（自动检测深浅主题） */
export function chartHexColor(index: number): string {
  const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const palette = isDark ? CHART_HEX_DARK : CHART_HEX_LIGHT;
  return palette[index % palette.length];
}

/** 获取当前主题的语义色值 */
export function getThemeColors() {
  const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return {
    fg: isDark ? "#e9ebf2" : "#1a1d2e",
    fgMuted: isDark ? "#697183" : "#697183",
    line: isDark ? "#262b38" : "#e2e4ea",
    lineStrong: isDark ? "#363d4e" : "#c8cad4",
    surface: isDark ? "#171a23" : "#ffffff",
  };
}
