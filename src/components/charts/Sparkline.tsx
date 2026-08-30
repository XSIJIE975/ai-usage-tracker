import { useMemo } from "react";
import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { getThemeColors } from "./palette";
import { useEffectiveTheme } from "../../lib/theme";
import { useResizeObserver } from "../../hooks/use-resize-observer";
import type { MetricPoint } from "../../stats/snapshot-history";

echarts.use([LineChart, GridComponent, CanvasRenderer]);

/**
 * 供应商卡片迷你趋势线：近 7 天主指标，无坐标轴、面积渐变、随明暗主题取色。
 * 与 StackedBars 相同的主题缓存纪律：getThemeColors() 必须按 theme 缓存，避免多余 setOption。
 */
export function Sparkline({
  points,
  color,
  height = 56,
}: {
  points: MetricPoint[];
  /** 线条颜色（hex），缺省用主题品牌色 */
  color?: string;
  height?: number;
}) {
  const theme = useEffectiveTheme();
  const colors = useMemo(() => getThemeColors(), [theme]);
  const [chartRef] = useResizeObserver<HTMLDivElement>();

  const option = useMemo(() => {
    const lineColor = color ?? colors.brand;
    return {
      animation: false,
      silent: true,
      grid: { left: 2, right: 2, top: 6, bottom: 2 },
      xAxis: {
        type: "category",
        show: false,
        boundaryGap: false,
        data: points.map((_, index) => index),
      },
      yAxis: { type: "value", show: false, scale: true },
      series: [
        {
          type: "line",
          data: points.map((point) => point.v),
          showSymbol: false,
          smooth: 0.3,
          lineStyle: { width: 1.5, color: lineColor },
          areaStyle: { color: lineColor, opacity: 0.12 },
        },
      ],
    };
  }, [points, colors, color]);

  return (
    <div ref={chartRef} style={{ height }} aria-hidden>
      <ReactEChartsCore
        echarts={echarts}
        option={option}
        style={{ height: "100%", width: "100%" }}
        notMerge
        lazyUpdate
      />
    </div>
  );
}
