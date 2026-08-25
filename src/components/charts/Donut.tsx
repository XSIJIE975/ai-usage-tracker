import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { PieChart } from "echarts/charts";
import { TooltipComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { modelColorIndex, chartHexColor } from "./palette";
import { cn } from "../../lib/utils";

echarts.use([PieChart, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface DonutSegment {
  name: string;
  value: number;
  /** 颜色索引（0..5 对应 chart-1..6），缺省按模型名全局映射 */
  color?: number;
}

const colorOf = (s: DonutSegment, fallback: number) => s.color ?? modelColorIndex(s.name) ?? fallback;

/**
 * 环形占比图（ECharts 实现）：
 * 中心显示合计，右侧图例带数值与百分比；扇区与图例颜色严格一致。
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

  const option = {
    tooltip: {
      trigger: "item" as const,
      formatter: (params: { name: string; value: number; percent: number }) =>
        `${params.name}: ${format(params.value)}（${params.percent.toFixed(1)}%）`,
    },
    legend: {
      show: false,
    },
    series: [
      {
        type: "pie" as const,
        radius: ["52%", "78%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: false,
        padAngle: segments.length > 1 ? 1 : 0,
        itemStyle: {
          borderRadius: 0,
        },
        label: {
          show: true,
          position: "center" as const,
          formatter: () => `{total|${format(total)}}\n{label|${centerLabel}}`,
          rich: {
            total: {
              fontSize: 16,
              fontWeight: 600,
              color: "var(--color-fg)",
              lineHeight: 24,
            },
            label: {
              fontSize: 12,
              color: "var(--color-fg-muted)",
              lineHeight: 18,
            },
          },
        },
        emphasis: {
          label: {
            show: true,
          },
          scaleSize: 2,
        },
        data: segments.map((seg, i) => ({
          name: seg.name,
          value: seg.value,
          itemStyle: {
            color: chartHexColor(colorOf(seg, i)),
          },
        })),
      },
    ],
  };

  return (
    <div className={cn("flex items-center gap-5", className)}>
      <div className="shrink-0" style={{ width: size, height: size }}>
        <ReactEChartsCore
          echarts={echarts}
          option={option}
          style={{ width: size, height: size }}
          opts={{ renderer: "canvas" }}
          notMerge
        />
      </div>

      <ul className="min-w-0 flex-1 space-y-2">
        {segments.map((seg, i) => {
          const ratio = total > 0 ? (seg.value / total) * 100 : 0;
          return (
            <li key={seg.name} className="flex items-center gap-2 text-[13px]">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                style={{ backgroundColor: chartHexColor(colorOf(seg, i)) }}
              />
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
