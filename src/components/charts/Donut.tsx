import { useCallback, useMemo, useRef } from "react";
import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { PieChart } from "echarts/charts";
import { LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { modelColor, getThemeColors } from "./palette";
import { useEffectiveTheme } from "../../lib/theme";
import { useChartLegend } from "../../hooks/use-chart-legend";
import { ChartLegend } from "./ChartLegend";
import { cn } from "../../lib/utils";

echarts.use([PieChart, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface DonutSegment {
  name: string;
  value: number;
}

interface TooltipParam {
  name: string;
  value: number;
  percent: number;
  marker: string;
}

/**
 * 环形占比图（ECharts + 外部 React 图例）。
 *
 * 联动机制：
 * - 图例点击：直接过滤 data（仅保留 selected 集合内的扇区），被取消勾选的扇区从饼图中物理移除，
 *   与 ECharts 原生图例的筛选行为一致；React state 为唯一数据源。
 * - 图例悬停：仅更新 activeName（影响图例自身加粗 + tooltip 高亮），不 dispatchAction 改变图表。
 * - 图表交互：监听 ECharts 的 mouseover/mouseout，同步 activeName，让 tooltip 与图表原生 emphasis 高亮一致。
 * - tooltip：当前 active 扇区的名称与数值均使用该扇区自身颜色高亮；非 active 项整体变暗。
 * - 中心合计随显隐状态实时更新。
 *
 * ★ 架构铁律（与 StackedBars 同款）：hover 绝不能触发 setOption——
 *   1. getThemeColors() 每次调用返回新对象，必须用 useMemo([theme]) 缓存；
 *   2. option useMemo 依赖不含 legend.activeName，tooltip formatter 经 activeNameRef 运行时读取。
 *   任何 setOption(notMerge) 都会销毁重建图形元素，使 ECharts 丢失 mouseout、emphasis 残留。
 */
export function Donut({
  segments,
  centerLabel,
  format = (v) => String(v),
  size = 200,
  className,
}: {
  segments: DonutSegment[];
  centerLabel: string;
  format?: (value: number) => string;
  size?: number;
  className?: string;
}) {
  const theme = useEffectiveTheme();
  // 注意：getThemeColors() 每次调用都返回新对象，必须按 theme 缓存，否则 option 每次 render 重算。
  const colors = useMemo(() => getThemeColors(), [theme]);
  const chartComponentRef = useRef<ReactEChartsCore>(null);

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const positiveSegments = useMemo(() => segments.filter((seg) => seg.value > 0), [segments]);
  const allNames = useMemo(() => positiveSegments.map((s) => s.name), [positiveSegments]);
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

  const data = useMemo(
    () =>
      positiveSegments
        .filter((seg) => legend.selected.has(seg.name))
        .map((seg) => ({
          name: seg.name,
          value: seg.value,
          itemStyle: { color: modelColor(seg.name) },
        })),
    [positiveSegments, legend.selected]
  );

  const visibleTotal = useMemo(
    () => positiveSegments.filter((seg) => legend.selected.has(seg.name)).reduce((sum, s) => sum + s.value, 0),
    [positiveSegments, legend.selected]
  );

  // onEvents 只同步 React activeName；deps 只引用 useChartLegend 的稳定回调，避免 echarts-for-react
  // 在每次 setActive 后无谓 unbind/bind 事件。
  const handleChartMouseOver = useCallback(
    (e: { componentType: string; name?: string }) => {
      if (e.componentType === "series" && e.name) {
        legend.setActive(e.name);
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
        trigger: "item" as const,
        backgroundColor: colors.surface,
        borderColor: colors.lineStrong,
        borderWidth: 1,
        textStyle: {
          color: colors.fg,
          fontSize: 13,
        },
        formatter: (params: TooltipParam) => {
          // 运行时读取最新 activeName，避免 activeName 进入 option 依赖导致 hover 触发 setOption
          const activeName = activeNameRef.current;
          const isActive = params.name === activeName;
          const seriesColor = modelColor(params.name);
          const opacity = isActive ? 1 : 0.55;
          const fontWeight = isActive ? 700 : 400;
          const nameColor = isActive ? seriesColor : colors.fgSecondary;
          const valueColor = isActive ? seriesColor : colors.fgMuted;
          return (
            `<div style="display:flex;align-items:center;gap:8px;opacity:${opacity};font-weight:${fontWeight};font-size:13px;">` +
            `<span style="flex:none">${params.marker}</span>` +
            `<span style="flex:1 1 auto;color:${nameColor}">${params.name}</span>` +
            `<span style="flex:none;color:${valueColor};font-weight:${fontWeight}">${format(params.value)}（${params.percent.toFixed(1)}%）</span>` +
            `</div>`
          );
        },
      },
      legend: {
        show: false,
      },
      series: [
        {
          type: "pie" as const,
          radius: ["48%", "72%"],
          center: ["50%", "50%"],
          avoidLabelOverlap: false,
          padAngle: data.length > 1 ? 2 : 0,
          label: {
            show: true,
            position: "center" as const,
            formatter: () => `{total|${format(visibleTotal)}}\n{label|${centerLabel}}`,
            rich: {
              total: {
                fontSize: 16,
                fontWeight: 600,
                color: colors.fg,
                lineHeight: 24,
              },
              label: {
                fontSize: 12,
                color: colors.fgMuted,
                lineHeight: 18,
              },
            },
          },
          emphasis: {
            label: { show: true },
            scaleSize: 2,
          },
          data,
        },
      ],
    }),
    // 依赖刻意不含 legend.activeName：hover 不触发 option 重算 → 不触发 setOption → ECharts 状态机不受干扰
    [colors, centerLabel, data, format, visibleTotal]
  );

  const legendItems = useMemo(
    () =>
      positiveSegments.map((seg) => ({
        name: seg.name,
        color: modelColor(seg.name),
        share: total > 0 ? (seg.value / total) * 100 : 0,
      })),
    [positiveSegments, total]
  );

  return (
    <figure className={cn("m-0 flex flex-col items-center", className)}>
      <div className="w-full rounded-lg border border-line/60 bg-canvas/50">
        <ReactEChartsCore
          ref={chartComponentRef}
          key={theme}
          echarts={echarts}
          option={option}
          style={{ width: "100%", height: size }}
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
        className="justify-center"
      />
    </figure>
  );
}
