import { cn } from "../../lib/utils";

export interface DonutSegment {
  name: string;
  value: number;
}

const CHART_CLASS_COUNT = 6;
const chartStroke = (i: number) => `stroke-chart-${(i % CHART_CLASS_COUNT) + 1}`;
const chartBg = (i: number) => `bg-chart-${(i % CHART_CLASS_COUNT) + 1}`;

/**
 * 环形占比图规范（docs/DESIGN.md#图表）：
 * 中心显示合计，右侧图例带数值与百分比。
 */
export function Donut({
  segments,
  centerLabel,
  format = (v) => String(v),
  size = 168,
  className,
}: {
  segments: DonutSegment[];
  centerLabel: string;
  format?: (value: number) => string;
  size?: number;
  className?: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const strokeW = 22;
  const r = (size - strokeW) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const gapRatio = segments.length > 1 ? 0.012 : 0;

  let offsetRatio = 0.25; // 从 12 点方向开始

  return (
    <div className={cn("flex items-center gap-5", className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label="占比环形图">
          <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth={strokeW} className="stroke-surface-2" />
          {segments.map((seg, i) => {
            const ratio = total > 0 ? seg.value / total : 0;
            const shown = Math.max(ratio - gapRatio, 0);
            const dash = `${shown * circumference} ${circumference}`;
            const rotation = offsetRatio * 360;
            offsetRatio += ratio;
            return (
              <circle
                key={seg.name}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                strokeWidth={strokeW}
                strokeDasharray={dash}
                transform={`rotate(${rotation} ${cx} ${cy})`}
                className={cn(chartStroke(i), "transition-opacity duration-fast hover:opacity-80")}
              >
                <title>{`${seg.name}: ${format(seg.value)}（${(ratio * 100).toFixed(1)}%）`}</title>
              </circle>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum text-lg font-semibold text-fg">{format(total)}</span>
          <span className="text-xs text-fg-muted">{centerLabel}</span>
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-2">
        {segments.map((seg, i) => {
          const ratio = total > 0 ? (seg.value / total) * 100 : 0;
          return (
            <li key={seg.name} className="flex items-center gap-2 text-[13px]">
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-[3px]", chartBg(i))} />
              <span className="min-w-0 flex-1 truncate text-fg-secondary">{seg.name}</span>
              <span className="tnum text-fg-muted">{ratio.toFixed(1)}%</span>
              <span className="tnum w-16 text-right font-medium text-fg">{format(seg.value)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
