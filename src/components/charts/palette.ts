/**
 * 图表色板（全局唯一取色入口）。
 *
 * 颜色策略：
 * 1. 所有颜色均源自 CSS 变量 --chart-1..16，禁止硬编码 hex。
 * 2. 模型颜色由模型名通过稳定哈希映射到 16 色色板，保证：
 *    - 同一模型名在任何图表、任何时刻颜色一致
 *    - 同一图表内常见模型数（≤16）颜色不重复
 * 3. 主题切换时缓存按主题失效并重新读取 CSS 变量。
 */

import { getEffectiveTheme } from "../../lib/theme";

export const CHART_COLOR_COUNT = 16;

// ─── 静态 Tailwind 工具类数组（仅用于 React 色块，禁止动态拼接） ─────────

export const CHART_FILLS = Array.from(
  { length: CHART_COLOR_COUNT },
  (_, i) => `fill-chart-${i + 1}`,
) as `fill-chart-${number}`[];

export const CHART_BGS = Array.from(
  { length: CHART_COLOR_COUNT },
  (_, i) => `bg-chart-${i + 1}`,
) as `bg-chart-${number}`[];

export const CHART_STROKES = Array.from(
  { length: CHART_COLOR_COUNT },
  (_, i) => `stroke-chart-${i + 1}`,
) as `stroke-chart-${number}`[];

// ─── 主题检测与 CSS 变量读取 ───────────────────────────────

function readCssVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function readChartBaseColors(): string[] {
  const colors: string[] = [];
  for (let i = 1; i <= CHART_COLOR_COUNT; i++) {
    const v = readCssVar(`--chart-${i}`);
    if (v) colors.push(v);
  }
  return colors;
}

function readHashParams(): { s: number; l: number } {
  const s = parseFloat(readCssVar("--chart-hash-s")) || 68;
  const l = parseFloat(readCssVar("--chart-hash-l")) || 52;
  return { s, l };
}

// ─── 哈希取色 ─────────────────────────────────────────────

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** 为模型名生成稳定的色板索引（0..15）。 */
export function modelColorIndex(modelName: string): number {
  return djb2Hash(modelName) % CHART_COLOR_COUNT;
}

/**
 * 基于模型名 + 主题参数生成 HSL 颜色字符串（兜底用）。
 * 仅在 CSS 变量未就绪时使用。
 */
function generateHslColor(modelName: string, s: number, l: number): string {
  const hash = djb2Hash(modelName);
  const hue = (hash * 137.508) % 360;
  return `hsl(${hue}, ${s}%, ${l}%)`;
}

// ─── 全局缓存（按主题失效） ────────────────────────────────

const modelColorCache = new Map<string, string>();
let cachedTheme: "light" | "dark" | null = null;

function ensureCacheFresh(): "light" | "dark" {
  const theme = getEffectiveTheme();
  if (theme !== cachedTheme) {
    cachedTheme = theme;
    modelColorCache.clear();
  }
  return theme;
}

// ─── 公开 API ──────────────────────────────────────────────

/**
 * 取模型的唯一颜色（全局缓存，跨图表一致）。
 * 颜色源自 CSS 变量 --chart-1..16，主题切换时自动更新。
 */
export function modelColor(modelName: string): string {
  ensureCacheFresh();

  let cached = modelColorCache.get(modelName);
  if (cached) return cached;

  const baseColors = readChartBaseColors();
  if (baseColors.length > 0) {
    cached = baseColors[modelColorIndex(modelName) % baseColors.length];
  } else {
    const { s, l } = readHashParams();
    cached = generateHslColor(modelName, s, l);
  }

  modelColorCache.set(modelName, cached);
  return cached;
}

/**
 * 取模型对应的 Tailwind 色块类名（fill-chart-N / bg-chart-N）。
 * 仅用于 React 渲染的小色块，颜色与 ECharts 中 modelColor() 保持一致。
 */
export function modelFillClass(modelName: string): `fill-chart-${number}` {
  return CHART_FILLS[modelColorIndex(modelName)];
}

export function modelBgClass(modelName: string): `bg-chart-${number}` {
  return CHART_BGS[modelColorIndex(modelName)];
}

// ─── 主题语义色（图表辅助元素：轴线、网格、文字等） ─────────

export function getThemeColors() {
  ensureCacheFresh();
  return {
    fg: readCssVar("--fg") || "#191c26",
    fgMuted: readCssVar("--fg-muted") || "#8b93a5",
    fgSecondary: readCssVar("--fg-secondary") || "#4d5566",
    line: readCssVar("--line") || "#e6e8f0",
    lineStrong: readCssVar("--line-strong") || "#d5d9e4",
    surface: readCssVar("--surface") || "#ffffff",
    surface2: readCssVar("--surface-2") || "#f1f2f8",
    canvas: readCssVar("--canvas") || "#f5f6fa",
    brand: readCssVar("--brand") || "#5a48e2",
    brandSoft: readCssVar("--brand-soft") || "#eef0ff",
    success: readCssVar("--success") || "#16a34a",
    warning: readCssVar("--warning") || "#d97706",
    danger: readCssVar("--danger") || "#dc2626",
  };
}

// ─── 兼容导出（静态 hex 作为 SSR/未加载样式时的兜底） ───────────

export const CHART_HEX_LIGHT = [
  "#6366f1", "#14b8a6", "#f59e0b", "#ef4444",
  "#0ea5e9", "#84cc16", "#8b5cf6", "#f97316",
  "#06b6d4", "#ec4899", "#eab308", "#a855f7",
  "#10b981", "#3b82f6", "#f43f5e", "#22c55e",
];

export const CHART_HEX_DARK = [
  "#8183f8", "#2dd4bf", "#fbbf24", "#fb7185",
  "#38bdf8", "#a3e635", "#a78bfa", "#fb923c",
  "#67e8f9", "#f472b6", "#facc15", "#d8b4fe",
  "#34d399", "#60a5fa", "#fda4af", "#4ade80",
];

export function chartHexColor(index: number): string {
  const baseColors = readChartBaseColors();
  if (baseColors.length > 0) {
    return baseColors[index % baseColors.length];
  }
  const theme = getEffectiveTheme();
  const palette = theme === "dark" ? CHART_HEX_DARK : CHART_HEX_LIGHT;
  return palette[index % palette.length];
}
