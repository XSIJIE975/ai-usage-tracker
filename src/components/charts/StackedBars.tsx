import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { TooltipComponent, GridComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { modelColorIndex, chartHexColor, getThemeColors } from "./palette";
import { cn } from "../../lib/utils";

echarts.use([BarChart, TooltipComponent, GridComponent, LegendComponent, CanvasRenderer]);

export interface StackedSeries {
  name: string;
  values: number[];
  /** 颜色索引（0..5 对应 chart-1..6），缺省按模型名全局映射 */
  color?: number;
}

const colorOf = (s: StackedSeries, fallback: number) => s.color ?? modelColorIndex(s.name) ?? fallback;

/**
 * 堆叠柱状图（ECharts 实现）：
 * y 轴自动刻度，底部图例，hover 显示明细；
 * 柱体与图例颜色严格一致。
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
  const colors = getThemeColors();

  const option = {
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: colors.surface,
      borderColor: colors.lineStrong,
      textStyle: {
        color: colors.fg,
        fontSize: 13,
      },
      axisPointer: {
        type: "shadow" as const,
      },
      formatter: (params: Array<{ seriesName: string; value: number; marker: string }>) => {
        const lines = params.map((p) => `${p.marker} ${p.seriesName}: ${tooltipFormat(p.value)}`);
        const total = params.reduce((sum, p) => sum + p.value, 0);
        lines.push(`合计: ${tooltipFormat(total)}`);
        return lines.join("<br/>");
      },
    },
    legend: {
      show: true,
      bottom: 0,
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      textStyle: {
        fontSize: 12,
        color: colors.fgMuted,
      },
    },
    grid: {
      left: 46,
      right: 8,
      top: 12,
      bottom: 36,
      containLabel: false,
    },
    xAxis: {
      type: "category" as const,
      data: labels,
      axisLine: {
        lineStyle: {
          color: colors.lineStrong,
        },
      },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 10,
        color: colors.fgMuted,
        interval: Math.max(0, Math.floor(labels.length / 10) - 1),
      },
    },
    yAxis: {
      type: "value" as const,
      splitNumber: 5,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: {
        lineStyle: {
          color: colors.line,
        },
      },
      axisLabel: {
        fontSize: 10,
        color: colors.fgMuted,
        formatter: (v: number) => yFormat(v),
      },
    },
    series: series.map((s, si) => ({
      name: s.name,
      type: "bar" as const,
      stack: "total",
      barMaxWidth: 64,
      itemStyle: {
        color: chartHexColor(colorOf(s, si)),
        borderRadius: si === series.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0],
      },
      emphasis: {
        focus: "series" as const,
      },
      data: s.values,
    })),
  };

  return (
    <figure className={cn("m-0", className)}>
      <div className="rounded-lg border border-line/60 bg-canvas/50 px-3 pt-3">
        <ReactEChartsCore
          echarts={echarts}
          option={option}
          style={{ width: "100%", height }}
          opts={{ renderer: "canvas" }}
          notMerge
        />
      </div>
    </figure>
  );
}
