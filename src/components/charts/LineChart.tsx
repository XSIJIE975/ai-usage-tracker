import { useCallback, useMemo, useRef } from "react";
import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { TooltipComponent, GridComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { chartHexColor, getThemeColors } from "./palette";
import { useEffectiveTheme } from "../../lib/theme";
import { useResizeObserver } from "../../hooks/use-resize-observer";
import { useChartLegend } from "../../hooks/use-chart-legend";
import { ChartLegend } from "./ChartLegend";
import { cn } from "../../lib/utils";

echarts.use([LineChart, TooltipComponent, GridComponent, DataZoomComponent, CanvasRenderer]);

export interface LineSeries {
  name: string;
  values: number[];
}

interface TooltipParam {
  seriesName: string;
  value: number;
  marker: string;
  name: string;
}

/**
 * 折线图（ECharts + 外部 React 图例），与 StackedBars 同一套联动机制：
 * 图例过滤/悬停加粗、tooltip active 系列置顶高亮。
 * 系列颜色按序号取自全局色板（chartHexColor），与模型名哈希无关，适合固定 few 条指标线。
 * ★ 同样的架构铁律：hover 绝不触发 setOption，详见 StackedBars 顶部注释。
 */
export function LineChartView({
  labels,
  series,
  yFormat = (v) => String(v),
  tooltipFormat = (v) => String(v),
  height = 240,
  className,
}: {
  labels: string[];
  series: LineSeries[];
  yFormat?: (value: number) => string;
  tooltipFormat?: (value: number) => string;
  height?: number;
  className?: string;
}) {
  const theme = useEffectiveTheme();
  const colors = useMemo(() => getThemeColors(), [theme]);
  const [chartRef] = useResizeObserver<HTMLDivElement>();

  const allNames = useMemo(() => series.map((s) => s.name), [series]);
  const legend = useChartLegend(allNames);
  const activeNameRef = useRef<string | null>(null);
  activeNameRef.current = legend.activeName;

  const handleLegendToggle = useCallback((name: string) => legend.toggle(name), [legend]);
  const handleLegendEnter = useCallback((name: string) => legend.setActive(name), [legend]);
  const handleLegendLeave = useCallback(() => legend.setActive(null), [legend.setActive]);

  const visibleSeries = useMemo(
    () => series.filter((s) => legend.selected.has(s.name)),
    [series, legend.selected],
  );

  const legendItems = useMemo(
    () => series.map((s, i) => ({ name: s.name, color: chartHexColor(i) })),
    [series],
  );

  const handleChartMouseOver = useCallback(
    (e: { componentType: string; seriesName?: string }) => {
      if (e.componentType === "series" && e.seriesName) legend.setActive(e.seriesName);
    },
    [legend.setActive],
  );
  const handleChartMouseOut = useCallback(() => legend.setActive(null), [legend.setActive]);
  const onEvents = useMemo(
    () => ({ mouseover: handleChartMouseOver, mouseout: handleChartMouseOut }),
    [handleChartMouseOver, handleChartMouseOut],
  );

  const option = useMemo(
    () => ({
      tooltip: {
        trigger: "axis" as const,
        backgroundColor: colors.surface,
        borderColor: colors.lineStrong,
        borderWidth: 1,
        extraCssText: "border-radius:8px;box-shadow:" + (readShadowPop() || ""),
        textStyle: { color: colors.fg, fontSize: 13 },
        axisPointer: { type: "line" as const, lineStyle: { color: colors.lineStrong } },
        formatter: (params: TooltipParam[]) => {
          if (!params.length) return "";
          const activeName = activeNameRef.current;
          const sorted = [...params].sort((a, b) => {
            if (a.seriesName === activeName) return -1;
            if (b.seriesName === activeName) return 1;
            return b.value - a.value;
          });
          const lines = [
            `<div style="font-weight:600;margin-bottom:6px;color:${colors.fg}">${params[0].name}</div>`,
          ];
          for (const p of sorted) {
            const isActive = p.seriesName === activeName;
            const seriesColor = chartHexColor(series.findIndex((s) => s.name === p.seriesName));
            const opacity = isActive ? 1 : 0.55;
            const fontWeight = isActive ? 700 : 400;
            const nameColor = isActive ? seriesColor : colors.fgSecondary;
            const valueColor = isActive ? seriesColor : colors.fgMuted;
            lines.push(
              `<div style="display:flex;align-items:center;gap:8px;opacity:${opacity};font-weight:${fontWeight};font-size:13px;">` +
                `<span style="flex:none">${p.marker}</span>` +
                `<span style="flex:1 1 auto;color:${nameColor}">${p.seriesName}</span>` +
                `<span style="flex:none;color:${valueColor};font-weight:${fontWeight}">${tooltipFormat(p.value)}</span>` +
                `</div>`,
            );
          }
          return lines.join("");
        },
      },
      legend: { show: false },
      grid: { left: 46, right: 12, top: 12, bottom: 8, containLabel: false },
      dataZoom: [{ type: "inside" as const, xAxisIndex: 0, start: 0, end: 100, zoomLock: false }],
      xAxis: {
        type: "category" as const,
        data: labels,
        boundaryGap: false,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      yAxis: {
        type: "value" as const,
        splitNumber: 5,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: colors.line } },
        axisLabel: { fontSize: 10, color: colors.fgMuted, formatter: (v: number) => yFormat(v) },
      },
      series: visibleSeries.map((s, si) => ({
        name: s.name,
        type: "line" as const,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color: chartHexColor(si) },
        itemStyle: { color: chartHexColor(si) },
        emphasis: { focus: "series" as const },
        data: s.values,
      })),
    }),
    // 依赖刻意不含 legend.activeName：hover 不触发 setOption
    [colors, labels, visibleSeries, yFormat, tooltipFormat, series],
  );

  return (
    <figure className={cn("m-0", className)}>
      <div ref={chartRef} className="rounded-lg border border-line/60 bg-canvas/50 px-3 pt-3">
        <ReactEChartsCore
          key={theme}
          echarts={echarts}
          option={option}
          style={{ width: "100%", height }}
          opts={{ renderer: "canvas" }}
          onEvents={onEvents}
          notMerge
        />
      </div>

      <ChartLegend
        items={legendItems}
        selected={legend.selected}
        activeName={legend.activeName}
        onToggle={handleLegendToggle}
        onMouseEnter={handleLegendEnter}
        onMouseLeave={handleLegendLeave}
      />
    </figure>
  );
}

function readShadowPop(): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue("--shadow-pop").trim();
}
