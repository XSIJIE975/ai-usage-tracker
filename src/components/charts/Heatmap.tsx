import { useT } from "../../i18n";
import { cn } from "../../lib/utils";

/** 热力图的一格（服务端给的日值） */
export interface HeatmapDay {
  readonly date: string;
  readonly value: number;
}

interface HeatmapCell {
  readonly date: string;
  readonly value: number;
  readonly level: number;
}

/**
 * 档位色：0 档是「无消耗」的空格，其余档由浅到深。
 * 类名必须是静态字面量（Tailwind 不扫描动态拼接），所以按最大档数写死五档。
 */
const HEAT_CELL_CLASSES = ["bg-surface-2", "bg-brand/25", "bg-brand/45", "bg-brand/70", "bg-brand"];

/**
 * 日值 → 档位（0 = 无消耗，最大档 = levels 的个数）。
 * 阈值来自服务端（Qoder 的 credits-heatmap 直接下发官方算好的分位数），
 * 组件不自己发明分档规则；levels 缺失或全非正时所有有值的格子并成一档。
 */
export function heatLevel(value: number, levels: number[]): number {
  if (!(value > 0)) return 0;
  const thresholds = levels.filter((level) => Number.isFinite(level) && level > 0);
  if (thresholds.length === 0) return 1;
  let level = 1;
  for (const threshold of thresholds) {
    if (value > threshold) level += 1;
  }
  return Math.min(level, thresholds.length);
}

/** 日序号 → 星期行号（周日为首行，与常见热力图一致）；"YYYY-MM-DD" 按本地时区解析 */
const rowIndex = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return 0;
  return new Date(year, month - 1, day).getDay();
};

/**
 * 排成「列 = 周、行 = 周日~周六」的网格：首列按起始日的星期补空格，
 * 渲染时用 grid-flow-col + 7 行即可，不需要额外算列数。
 */
export function heatGrid(days: HeatmapDay[], levels: number[]): Array<HeatmapCell | null> {
  if (days.length === 0) return [];
  const cells = days.map((day) => ({
    date: day.date,
    value: day.value,
    level: heatLevel(day.value, levels),
  }));
  const lead = rowIndex(days[0].date);
  return [...Array.from({ length: lead }, () => null), ...cells];
}

export function Heatmap({
  days,
  levels,
  unit,
  className,
}: {
  days: HeatmapDay[];
  levels: number[];
  /** 数值单位后缀（tooltip 与图例用），如 "credits" */
  unit: string;
  className?: string;
}) {
  const t = useT();
  const grid = heatGrid(days, levels);
  const legendLevels = Math.max(1, levels.filter((level) => Number.isFinite(level) && level > 0).length);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="grid grid-flow-col grid-rows-7 gap-[3px] overflow-x-auto pb-1">
        {grid.map((cell, index) =>
          cell === null ? (
            <div key={`pad-${index}`} className="h-[10px] w-[10px]" aria-hidden />
          ) : (
            <div
              key={cell.date}
              className={cn("h-[10px] w-[10px] rounded-[2px]", HEAT_CELL_CLASSES[cell.level] ?? HEAT_CELL_CLASSES[HEAT_CELL_CLASSES.length - 1])}
              title={`${cell.date} · ${cell.value.toFixed(2)} ${unit}`}
            />
          ),
        )}
      </div>
      <div className="flex items-center justify-end gap-1 text-[11px] text-fg-muted">
        <span>{t("少")}</span>
        {Array.from({ length: legendLevels + 1 }, (_, level) => (
          <span
            key={level}
            className={cn("h-[10px] w-[10px] rounded-[2px]", HEAT_CELL_CLASSES[level] ?? HEAT_CELL_CLASSES[HEAT_CELL_CLASSES.length - 1])}
            aria-hidden
          />
        ))}
        <span>{t("多")}</span>
      </div>
    </div>
  );
}
