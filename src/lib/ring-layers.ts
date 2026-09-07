/**
 * 托盘/速览多层用量环的层序选取（ADR-0017）。
 *
 * 两个易混口径（见 docs/glossary.md「重置周期 vs 重置时刻」）：
 * - 层序键 = **窗口周期时长**（periodMs，5 小时/周/月），外环 = 最短周期窗，
 *   位置不随用量波动互换，半径形成「周期嵌套」隐喻；
 * - ADR-0016 的 tooltip 行序与柱方案上→下用的是 **下一重置时刻**（resetsAt）近→远，
 *   与本模块无关，互不影响。
 */

/** 环最多表达三扇配额窗（与 Rust 端 RING_LAYERS_MAX 同口径） */
export const RING_LAYERS_MAX = 3;

/** 多层环几何（ADR-0017）：16px 基准的 (半径, 描边)，外→内，实现按 size/16 缩放；
    内环加粗是刻意的可辨性补偿：半径越小弧长越短，加粗补回视觉重量 */
const RING_LAYERS_TWO = [
  [6.67, 2.0],
  [3.67, 2.2],
] as const;
const RING_LAYERS_THREE = [
  [6.67, 1.5],
  [4.43, 1.8],
  [2.2, 2.0],
] as const;

/**
 * 多层环各层几何（layers ≥ 2；与托盘端 ring_layer_specs 多层分支同口径）。
 * 单层形态不在本函数内：各渲染面沿用自身现状单层基线（托盘/设置预览卡 = 15% 相对描边，
 * 速览迷你环 = 4px 细线），避免多层化回归改动单层观感。
 */
export function multiRingLayerSpecs(
  size: number,
  layers: number,
): Array<{ radius: number; stroke: number }> {
  const table = layers <= 2 ? RING_LAYERS_TWO : RING_LAYERS_THREE;
  const scale = size / 16;
  return table.map(([radius, stroke]) => ({ radius: radius * scale, stroke: stroke * scale }));
}

interface RingLayerWindow {
  percent: number;
  /** 结构化窗口周期（毫秒）；缺失 = 周期未知，排后段、靠稳定排序保持相对顺序 */
  periodMs?: number | null;
}

function compareWindowPeriod(a: RingLayerWindow, b: RingLayerWindow): number {
  const knownA = typeof a.periodMs === "number" && Number.isFinite(a.periodMs);
  const knownB = typeof b.periodMs === "number" && Number.isFinite(b.periodMs);
  if (knownA && knownB) return (a.periodMs as number) - (b.periodMs as number);
  if (knownA) return -1;
  if (knownB) return 1;
  return 0;
}

/**
 * 环层窗口选取：取已用%最高的前三扇（「最紧三扇入图」，与柱方案「参与计分不占位」哲学同构），
 * 层内按窗口周期短→长排环位（外环 = 最短周期窗）。周期缺失时该扇排后段，
 * 依赖稳定排序（ES2019+ Array#sort）保持快照相对顺序；禁止用本地化 label 文本匹配推断周期。
 * 返回数组即外→内的层序。
 */
export function ringLayers<T extends RingLayerWindow>(windows: T[]): T[] {
  const tightest = [...windows].sort((a, b) => b.percent - a.percent).slice(0, RING_LAYERS_MAX);
  return tightest.sort(compareWindowPeriod);
}
