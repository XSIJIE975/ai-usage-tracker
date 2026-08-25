import { cn } from "../../lib/utils";

export interface ChartLegendItem {
  name: string;
  color: string;
  /** 可选的占比/数值后缀，仅在 Donut 中使用 */
  share?: number;
  /** 可选的数值后缀，用于展示原始数值 */
  value?: number;
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
  if (items.length === 0) return null;

  return (
    <figcaption
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
            title={isSelected ? "点击隐藏该系列" : "点击显示该系列"}
          >
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-[3px] transition-opacity",
                !isSelected && "opacity-40"
              )}
              style={{ backgroundColor: item.color }}
            />
            <span className="truncate max-w-[160px]" title={item.name}>
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
