import { useMemo } from "react";
import { useT } from "../../i18n";
import { useResizeObserver } from "../../hooks/use-resize-observer";
import { cn } from "../../lib/utils";

export interface ChartLegendItem {
  name: string;
  color: string;
  /** 可选的占比/数值后缀，仅在 Donut 中使用 */
  share?: number;
  /** 可选的数值后缀，用于展示原始数值 */
  value?: number;
}

/** 图例标签截断的下限：图例较多时每项至多这么宽（维持紧凑换行的既有样式） */
const LEGEND_LABEL_MIN_PX = 160;
/** 单个图例项的固定开销估算：色块 + 内边距 + 项间距 */
const LEGEND_ITEM_CHROME_PX = 40;

/**
 * 图例标签的截断预算：容器宽均摊到每项再扣固定开销，钳到不低于下限。
 * 写死 160px 会在图例很少时把明明放得下的长名截断（如「Max&Pro 高峰期平均
 * Decode 速度」只有两项也被截）——数量少时预算大、展示全名，数量多时预算
 * 回落到下限、维持现状。纯函数便于单测。
 */
export function legendLabelMaxWidth(containerWidth: number, itemCount: number): number {
  if (containerWidth <= 0 || itemCount <= 0) return LEGEND_LABEL_MIN_PX;
  return Math.max(LEGEND_LABEL_MIN_PX, containerWidth / itemCount - LEGEND_ITEM_CHROME_PX);
}

export interface ChartLegendProps {
  items: ChartLegendItem[];
  selected: Set<string>;
  activeName: string | null;
  onToggle: (name: string) => void;
  onMouseEnter?: (name: string) => void;
  onMouseLeave?: () => void;
  className?: string;
}

/**
 * 自定义图例组件（完全独立于 ECharts 内置图例）。
 *
 * 行为：
 * - 点击图例项切换对应系列的显隐状态。
 * - 已隐藏的项显示为置灰 + 删除线。
 * - 当前 active（最近一次被选中/悬停）的项加粗显示。
 * - 鼠标悬停图例项时触发 onMouseEnter，离开整个图例区域时触发 onMouseLeave，
 *   用于同步 tooltip/图例的高亮状态；图例 hover 本身不 dispatchAction 改变图表。
 * - 支持换行，不会遮挡图表绘图区。
 */
export function ChartLegend({ items, selected, activeName, onToggle, onMouseEnter, onMouseLeave, className }: ChartLegendProps) {
  const t = useT();
  const [legendRef, legendSize] = useResizeObserver<HTMLElement>();
  const labelMaxWidth = useMemo(
    () => legendLabelMaxWidth(legendSize.width, items.length),
    [legendSize.width, items.length],
  );
  if (items.length === 0) return null;

  return (
    <figcaption
      ref={legendRef}
      className={cn("mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-1", className)}
      onMouseLeave={() => onMouseLeave?.()}
    >
      {items.map((item) => {
        const isSelected = selected.has(item.name);
        const isActive = activeName === item.name;
        return (
          <button
            key={item.name}
            type="button"
            onClick={() => onToggle(item.name)}
            onMouseEnter={() => onMouseEnter?.(item.name)}
            className={cn(
              "group inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-colors hover:bg-surface-2",
              isSelected ? "text-fg" : "text-fg-muted line-through decoration-fg-muted/60",
              isActive && "font-semibold"
            )}
            aria-pressed={isSelected}
            title={t(isSelected ? "点击隐藏该系列" : "点击显示该系列")}
          >
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-[3px] transition-opacity",
                !isSelected && "opacity-40"
              )}
              style={{ backgroundColor: item.color }}
            />
            <span className="truncate" style={{ maxWidth: labelMaxWidth }} title={item.name}>
              {item.name}
            </span>
            {typeof item.share === "number" && (
              <span className={cn("tnum", isSelected ? "text-fg-muted" : "text-fg-muted/60")}>
                {item.share.toFixed(1)}%
              </span>
            )}
            {typeof item.value === "number" && (
              <span className={cn("tnum", isSelected ? "text-fg-muted" : "text-fg-muted/60")}>
                {item.value}
              </span>
            )}
          </button>
        );
      })}
    </figcaption>
  );
}
