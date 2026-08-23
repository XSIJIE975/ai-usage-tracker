import { cn } from "../../lib/utils";

export interface StackedSeries {
  name: string;
  values: number[];
}

/** 图表序列取色规范：按 chart-1..6 循环，不另造颜色 */
export const CHART_CLASS_COUNT = 6;

const chartFill = (i: number) => `fill-chart-${(i % CHART_CLASS_COUNT) + 1}`;
const chartBg = (i: number) => `bg-chart-${(i % CHART_CLASS_COUNT) + 1}`;

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}

/** 顶部圆角矩形路径（用于堆叠柱最顶端一段） */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M ${x} ${y + h} L ${x} ${y + rr} Q ${x} ${y} ${x + rr} ${y} L ${x + w - rr} ${y} Q ${x + w} ${y} ${x + w} ${y + rr} L ${x + w} ${y + h} Z`;
}

/**
 * 堆叠柱状图规范（docs/DESIGN.md#图表）：
 * 纯 SVG 实现，y 轴 5 档网格线，图例在下方，hover 显示明细。
 */
export function StackedBars({
  labels,
  series,
  yFormat = (v) => String(v),
  tooltipFormat = (v) => String(v),
  height = 260,
  className,
}: {
  labels: string[];
  series: StackedSeries[];
  yFormat?: (value: number) => string;
  tooltipFormat?: (value: number) => string;
  height?: number;
  className?: string;
}) {
  const W = 720;
  const H = height;
  const margin = { top: 12, right: 8, bottom: 26, left: 46 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;
  const n = labels.length;

  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = niceCeil(Math.max(...totals, 0) * 1.05);
  const ticks = Array.from({ length: 5 }, (_, i) => (max / 5) * (i + 1));

  const band = plotW / Math.max(n, 1);
  const barW = Math.min(band * (n > 20 ? 0.72 : 0.56), 64);
  const labelEvery = Math.max(1, Math.ceil(n / 10));

  return (
    <figure className={cn("m-0", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="堆叠柱状图">
        {/* 网格线与 y 轴刻度 */}
        {ticks.map((tick) => {
          const y = margin.top + plotH - (tick / max) * plotH;
          return (
            <g key={tick}>
              <line x1={margin.left} x2={W - margin.right} y1={y} y2={y} className="stroke-line" strokeWidth={1} />
              <text x={margin.left - 8} y={y + 3.5} textAnchor="end" className="fill-fg-muted text-[10px]">
                {yFormat(tick)}
              </text>
            </g>
          );
        })}
        {/* 基线 */}
        <line
          x1={margin.left}
          x2={W - margin.right}
          y1={margin.top + plotH}
          y2={margin.top + plotH}
          className="stroke-line-strong"
          strokeWidth={1}
        />
        <text x={margin.left - 8} y={margin.top + plotH + 3.5} textAnchor="end" className="fill-fg-muted text-[10px]">
          {yFormat(0)}
        </text>

        {/* 柱体 */}
        {labels.map((label, i) => {
          const x = margin.left + band * i + (band - barW) / 2;
          let acc = 0;
          const segments = series.map((s, si) => ({ si, value: s.values[i] ?? 0 })).filter((seg) => seg.value > 0);
          const topSi = segments.length > 0 ? segments[segments.length - 1].si : -1;
          const tooltipLines = series
            .map((s) => `${s.name}: ${tooltipFormat(s.values[i] ?? 0)}`)
            .concat(`合计: ${tooltipFormat(totals[i])}`);
          return (
            <g key={label}>
              {series.map((s, si) => {
                const value = s.values[i] ?? 0;
                if (value <= 0) return null;
                const h = Math.max((value / max) * plotH, 1);
                const y = margin.top + plotH - ((acc + value) / max) * plotH;
                acc += value;
                return (
                  <path
                    key={s.name}
                    d={topRoundedRect(x, y, barW, h, si === topSi ? 3 : 0)}
                    className={cn(chartFill(si), "transition-opacity duration-fast hover:opacity-80")}
                  />
                );
              })}
              {/* hover 命中区域 + 明细提示 */}
              <rect x={margin.left + band * i} y={margin.top} width={band} height={plotH} fill="transparent">
                <title>{`${label}\n${tooltipLines.join("\n")}`}</title>
              </rect>
              {i % labelEvery === 0 ? (
                <text
                  x={margin.left + band * i + band / 2}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-fg-muted text-[10px]"
                >
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* 图例 */}
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1">
        {series.map((s, si) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <span className={cn("h-2.5 w-2.5 rounded-[3px]", chartBg(si))} />
            {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
