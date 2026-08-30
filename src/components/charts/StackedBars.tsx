import { useCallback, useMemo, useRef } from "react";
import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { TooltipComponent, GridComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { modelColor, getThemeColors } from "./palette";
import { useEffectiveTheme } from "../../lib/theme";
import { useResizeObserver } from "../../hooks/use-resize-observer";
import { useChartLegend } from "../../hooks/use-chart-legend";
import { ChartLegend } from "./ChartLegend";
import { cn } from "../../lib/utils";

echarts.use([BarChart, TooltipComponent, GridComponent, DataZoomComponent, CanvasRenderer]);

export interface StackedSeries {
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
 * 堆叠柱状图（ECharts + 外部 React 图例）。
 *
 * 联动机制：
 * - 图例点击：直接过滤 series（仅保留 selected 集合内的系列），被取消勾选的系列从图表中物理移除，
 *   与 ECharts 原生图例的筛选行为一致；React state 为唯一数据源。
 * - 图例悬停：仅更新 activeName（影响图例自身加粗 + tooltip 高亮），不 dispatchAction 改变图表。
 * - 图表交互：监听 ECharts 的 mouseover/mouseout，同步 activeName，让 tooltip 与图表原生 emphasis 高亮一致。
 * - tooltip：当前 active 系列置顶，名称与数值均使用该系列自身颜色高亮；非 active 项整体变暗。
 *
 * ★ 架构铁律：hover（mouseover/mouseout/setActive）绝不能触发 setOption！
 *   ECharts 的 emphasis.focus='series' 状态机依赖"鼠标停留在同一图形元素上"的指针；
 *   任何一次 setOption（notMerge）都会销毁重建图形元素，使鼠标下方的旧元素消失、
 *   mouseout 永远不派发，造成 downplay 残留（鼠标移开后柱子仍变暗）与"刷新后图表不重绘"。
 *   因此：
 *   1. getThemeColors() 每次调用返回新对象，必须用 useMemo([theme]) 缓存 colors，
 *      否则 option 每次 render 都重算 → 每次 render 都 setOption（历史上的致命 bug）。
 *   2. option 的 useMemo 依赖中绝不能包含 legend.activeName（hover 态）；
 *      tooltip formatter 通过 activeNameRef 在运行时读取最新 activeName（formatter 是
 *      tooltip 显示时才被调用，闭包读 ref 永远拿最新值）。
 *   最终效果：数据/图例显隐/主题变化才 setOption；hover 仅更新 React state 与 ref，
 *   ECharts 自主管理 emphasis 与 mouseout，与官方示例行为一致。
 */
export function StackedBars({
  labels,
  series,
  yFormat = (v) => String(v),
  tooltipFormat = (v) => String(v),
  height = 240,
  className,
}: {
  labels: string[];
  series: StackedSeries[];
  yFormat?: (value: number) => string;
  tooltipFormat?: (value: number) => string;
  height?: number;
  className?: string;
}) {
  const theme = useEffectiveTheme();
  // 注意：getThemeColors() 每次调用都返回新对象，必须按 theme 缓存，否则 option 每次 render 重算。
  const colors = useMemo(() => getThemeColors(), [theme]);
  const [chartRef] = useResizeObserver<HTMLDivElement>();
  const chartComponentRef = useRef<ReactEChartsCore>(null);

  const allNames = useMemo(() => series.map((s) => s.name), [series]);
  const legend = useChartLegend(allNames);

  // tooltip formatter 运行时读取的 activeName（见顶部架构铁律第 2 条）
  const activeNameRef = useRef<string | null>(null);
  activeNameRef.current = legend.activeName;

  const handleLegendToggle = useCallback(
    (name: string) => {
      legend.toggle(name);
    },
    [legend]
  );

  const handleLegendEnter = useCallback(
    (name: string) => {
      legend.setActive(name);
    },
    [legend]
  );

  const handleLegendLeave = useCallback(() => {
    legend.setActive(null);
  }, [legend]);

  const visibleSeries = useMemo(
    () => series.filter((s) => legend.selected.has(s.name)),
    [series, legend.selected]
  );

  const legendItems = useMemo(
    () => series.map((s) => ({ name: s.name, color: modelColor(s.name) })),
    [series]
  );

  // onEvents 只同步 React activeName（图例加粗 + tooltip 高亮），不影响 ECharts 自身 emphasis 管理。
  // deps 只引用 useChartLegend 暴露的稳定回调（setActive 是 useCallback([])）——绝不能放 legend 整体，
  // 否则 echarts-for-react 会在每次 setActive 后无谓 unbind/bind 事件。
  const handleChartMouseOver = useCallback(
    (e: { componentType: string; seriesName?: string }) => {
      if (e.componentType === "series" && e.seriesName) {
        legend.setActive(e.seriesName);
      }
    },
    [legend.setActive]
  );

  const handleChartMouseOut = useCallback(() => {
    legend.setActive(null);
  }, [legend.setActive]);

  const onEvents = useMemo(
    () => ({ mouseover: handleChartMouseOver, mouseout: handleChartMouseOut }),
    [handleChartMouseOver, handleChartMouseOut]
  );

  const option = useMemo(
    () => ({
      tooltip: {
        trigger: "axis" as const,
        backgroundColor: colors.surface,
        borderColor: colors.lineStrong,
        borderWidth: 1,
        extraCssText: "border-radius:8px;box-shadow:" + (readShadowPop() || ""),
        textStyle: {
          color: colors.fg,
          fontSize: 13,
        },
        axisPointer: {
          type: "shadow" as const,
        },
        formatter: (params: TooltipParam[]) => {
          if (!params.length) return "";
          // 运行时读取最新 activeName，避免 activeName 进入 option 依赖导致 hover 触发 setOption
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
            const seriesColor = modelColor(p.seriesName);
            const opacity = isActive ? 1 : 0.55;
            const fontWeight = isActive ? 700 : 400;
            const nameColor = isActive ? seriesColor : colors.fgSecondary;
            const valueColor = isActive ? seriesColor : colors.fgMuted;
            lines.push(
              `<div style="display:flex;align-items:center;gap:8px;opacity:${opacity};font-weight:${fontWeight};font-size:13px;">` +
                `<span style="flex:none">${p.marker}</span>` +
                `<span style="flex:1 1 auto;color:${nameColor}">${p.seriesName}</span>` +
                `<span style="flex:none;color:${valueColor};font-weight:${fontWeight}">${tooltipFormat(p.value)}</span>` +
                `</div>`
            );
          }
          const total = params.reduce((sum, p) => sum + p.value, 0);
          lines.push(
            `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${colors.line};display:flex;justify-content:space-between;color:${colors.fgMuted};font-size:13px;">` +
              `<span>合计</span>` +
              `<b style="color:${colors.fg}">${tooltipFormat(total)}</b>` +
              `</div>`
          );
          return lines.join("");
        },
      },
      legend: {
        show: false,
      },
      grid: {
        left: 46,
        right: 12,
        top: 12,
        bottom: 8,
        containLabel: false,
      },
      dataZoom: [
        {
          type: "inside" as const,
          xAxisIndex: 0,
          start: 0,
          end: 100,
          zoomLock: false,
        },
      ],
      xAxis: {
        type: "category" as const,
        data: labels,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
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
      series: visibleSeries.map((s, si) => ({
        name: s.name,
        type: "bar" as const,
        stack: "total",
        barMaxWidth: 28,
        barGap: "20%",
        itemStyle: {
          color: modelColor(s.name),
          borderRadius: si === series.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0],
        },
        emphasis: {
          focus: "series" as const,
        },
        data: s.values,
      })),
    }),
    // 依赖刻意不含 legend.activeName：hover 不触发 option 重算 → 不触发 setOption → ECharts 状态机不受干扰
    [colors, labels, visibleSeries, yFormat, tooltipFormat]
  );

  return (
    <figure className={cn("m-0", className)}>
      <div ref={chartRef} className="rounded-lg border border-line/60 bg-canvas/50 px-3 pt-3">
        <ReactEChartsCore
          ref={chartComponentRef}
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
