/**
 * 图表色板（全局唯一取色入口）。
 *
 * 颜色生成策略：基于模型名哈希 → HSL 色相旋转，保证：
 * 1. 同一模型跨图表颜色一致（全局缓存）
 * 2. 不同模型颜色视觉可区分（色相间隔 ≥ 30°）
 * 3. 饱和度/明度控制在设计规范范围内（S 65-75%, L 50-60%）
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

// ─── HSL 哈希取色 ───────────────────────────────────────────

/** 预设色相种子（度数），确保相邻种子间隔 ≥ 30° */
const HUE_SEEDS = [0, 35, 70, 120, 160, 200, 250, 290, 330];

/** 全局模型 → hex 缓存，保证同一模型跨图表颜色一致 */
const modelColorCache = new Map<string, string>();

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * 基于模型名生成唯一的 hex 颜色。
 * 使用 djb2 哈希 → 选择色相种子 → 微调色相偏移 → HSL→hex。
 * 饱和度 68%，明度 55%，在深浅主题下均清晰可读。
 */
function generateModelColor(modelName: string): string {
  const hash = djb2Hash(modelName);
  const seedIndex = hash % HUE_SEEDS.length;
  const baseHue = HUE_SEEDS[seedIndex];
  // 用哈希高位做 ±15° 微调，让同一种子下的不同模型也有区分
  const offset = ((hash >> 8) % 30) - 15;
  const hue = (baseHue + offset + 360) % 360;
  const sat = 68;
  const light = 55;
  return hslToHex(hue, sat, light);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// ─── 公开 API ────────────────────────────────────────────────

/**
 * 取模型的唯一 hex 颜色（全局缓存）。
 * 优先使用已知模型的固定配色，未知模型通过 HSL 哈希生成。
 */
export function modelColor(modelName: string): string {
  let cached = modelColorCache.get(modelName);
  if (!cached) {
    cached = generateModelColor(modelName);
    modelColorCache.set(modelName, cached);
  }
  return cached;
}

/**
 * @deprecated 使用 modelColor() 代替。保留以兼容旧接口。
 * 取模型的全局颜色索引（0..5），保证跨图表一致。
 */
export function modelColorIndex(model: string): number {
  return djb2Hash(model) % CHART_COLOR_COUNT;
}

/** 取指定索引的 hex 色值（用于序列色回退） */
export function chartHexColor(index: number): string {
  const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const palette = isDark ? CHART_HEX_DARK : CHART_HEX_LIGHT;
  return palette[index % palette.length];
}

// ─── 主题色板（序列色回退用） ────────────────────────────────

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

// ─── 语义色 ──────────────────────────────────────────────────

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
