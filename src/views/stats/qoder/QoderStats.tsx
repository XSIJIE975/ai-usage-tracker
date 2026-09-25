import { useMemo, useState } from "react";
import { Activity, CalendarRange, LoaderCircle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Select } from "../../../components/ui/select";
import { Segmented } from "../../../components/ui/segmented";
import { Label } from "../../../components/ui/label";
import { IconButton } from "../../../components/ui/icon-button";
import { EmptyState } from "../../../components/ui/empty-state";
import { StackedBars } from "../../../components/charts/StackedBars";
import { Heatmap } from "../../../components/charts/Heatmap";
import { aggregateQoderUsage, fetchQoderHeatmap, fetchQoderUsage } from "../../../providers/qoder-stats";
import { createUsageCache } from "../../../stats/usage-cache";
import { useAppStore } from "../../../store/useAppStore";
import { cn, formatCompact, formatInt } from "../../../lib/utils";
import { StatsStateCard } from "../StatsStateCard";
import { useStatsFetch } from "../use-stats-fetch";
import { useAutoRefresh } from "../use-auto-refresh";
import { useGlobalRefresh } from "../use-global-refresh";
import { customRangeError, isoDate, isoDateDaysAgo, resolveRangeMs, statsRangePolicy, timeRangeOptions, type TimeRange } from "../time-range";
import { formatDayLabel } from "../deepseek/usage-aggregation";
import { renderTemplate, useLanguage, useT } from "../../../i18n";
import type { ProviderInstance } from "../../../types/ipc";
import { QoderOverviewCards } from "./QoderOverviewCards";
import { QoderOperationDonut } from "./QoderOperationDonut";
import { QoderModelTable } from "./QoderModelTable";
import { QoderUsageTable } from "./QoderUsageTable";

type QoderMetric = "credits" | "requests";

const usageCache = createUsageCache();
/** 热力图与明细是两份独立数据（前者固定近一年，后者随档位走），分开缓存 */
const heatmapCache = createUsageCache();

const metricOptions: { value: QoderMetric; label: string }[] = [
  { value: "credits", label: "积分消耗" },
  { value: "requests", label: "记录条数" },
];

/** 格式化器必须是模块层稳定引用：内联箭头函数每次渲染都是新身份，会穿透 StackedBars 的
 *  option useMemo 导致每次渲染 setOption 重建图表（与 WorkBuddy 统计同一铁律） */
const formatCreditsCompact = (value: number) => formatCompact(Number(value.toFixed(2)));
const formatCreditsPrecise = (value: number) => value.toFixed(2);
const formatCountPrecise = (value: number) => formatInt(value);

/** 局部刷新遮罩：半透明覆盖 + 旋转加载图标，叠加在图表/卡片区域上 */
function RefreshOverlay() {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-canvas/40 backdrop-blur-[1px]">
      <LoaderCircle className="h-5 w-5 animate-spin text-brand" aria-hidden />
    </div>
  );
}

export function QoderStats({ instance }: { instance: ProviderInstance }) {
  const policy = statsRangePolicy(instance.providerId);
  const [range, setRange] = useState<TimeRange>(policy.defaultRange);
  const [metric, setMetric] = useState<QoderMetric>("credits");
  const [customFrom, setCustomFrom] = useState(() => isoDateDaysAgo(29));
  const [customTo, setCustomTo] = useState(() => isoDate(new Date()));
  const [refreshTick, setRefreshTick] = useState(0);

  const rangeMs = useMemo(
    () => resolveRangeMs(instance.providerId, range, customFrom, customTo),
    [instance.providerId, range, customFrom, customTo],
  );
  const customError =
    range === "custom" ? customRangeError(instance.providerId, customFrom, customTo) : null;
  const t = useT();
  const language = useLanguage();
  const cacheKey = rangeMs === null ? null : `${instance.id}:${rangeMs.startMs}:${rangeMs.endMs}`;
  const { state, isRefreshing } = useStatsFetch(
    usageCache,
    cacheKey,
    () =>
      rangeMs === null
        ? Promise.reject(new Error("时间范围无效"))
        : fetchQoderUsage(instance, rangeMs.startMs, rangeMs.endMs),
    refreshTick,
  );
  // 近一年分布与档位无关，只随刷新重取
  const heatmap = useStatsFetch(
    heatmapCache,
    `heatmap:${instance.id}`,
    () => fetchQoderHeatmap(instance),
    refreshTick,
  );

  const refresh = () => {
    if (cacheKey !== null) usageCache.invalidate(cacheKey);
    heatmapCache.invalidate(`heatmap:${instance.id}`);
    setRefreshTick((tick) => tick + 1);
  };

  useAutoRefresh(refresh, instance);
  useGlobalRefresh(refresh, instance.id);

  const globalRefreshing = useAppStore(
    (state) => state.loading || Boolean(state.refreshingInstances[instance.id]),
  );
  const busy = isRefreshing || globalRefreshing;

  const bundle = state.kind === "ready" ? state.data : null;
  const aggregates = useMemo(
    () => (bundle && rangeMs ? aggregateQoderUsage(bundle.rows, rangeMs.startMs, rangeMs.endMs) : null),
    [bundle, rangeMs],
  );
  const dayLabels = useMemo(
    () => (aggregates ? aggregates.dayLabels.map((day) => formatDayLabel(day, language)) : []),
    [aggregates, language],
  );
  const chartSeries = useMemo(() => {
    if (!aggregates) return [];
    return metric === "credits" ? aggregates.dailyCreditsSeries : aggregates.dailyRequestsSeries;
  }, [aggregates, metric]);

  const yFormat = metric === "credits" ? formatCreditsCompact : formatCountPrecise;
  const tooltipFormat = metric === "credits" ? formatCreditsPrecise : formatCountPrecise;
  const chartTitle = metric === "credits" ? "积分消耗趋势" : "记录条数趋势";
  const hasUsage = (aggregates?.totalRequests ?? 0) > 0;
  const emptyUsageHint = (
    <EmptyState
      icon={<Activity className="h-5 w-5" />}
      title={t("所选时间范围内暂无用量数据")}
      description={t("调整时间范围，或确认 Qoder 登录凭据有效。")}
    />
  );

  const filterToolbar = (
    <Card className="p-4">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1">
            <CalendarRange className="h-3.5 w-3.5" /> {t("时间范围")}
          </Label>
          <div className="flex items-center gap-2">
            <Select
              options={timeRangeOptions.map((option) => ({ ...option, label: t(option.label) }))}
              value={range}
              onChange={setRange}
              aria-label={t("时间范围")}
            />
            {range === "custom" && (
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || isoDate(new Date())}
                  onChange={(e) => setCustomFrom(e.currentTarget.value)}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-[13px] text-fg shadow-sm focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-focus-ring"
                  aria-label={t("开始日期")}
                />
                <span className="text-fg-muted">–</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  max={isoDate(new Date())}
                  onChange={(e) => setCustomTo(e.currentTarget.value)}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-[13px] text-fg shadow-sm focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-focus-ring"
                  aria-label={t("结束日期")}
                />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="flex items-center gap-1">{t("统计指标")}</Label>
          <Segmented
            value={metric}
            onChange={setMetric}
            options={metricOptions.map((option) => ({ ...option, label: t(option.label) }))}
          />
        </div>

        <IconButton
          onClick={refresh}
          disabled={busy}
          aria-label={busy ? t("刷新中") : t("刷新")}
          title={busy ? t("刷新中") : t("刷新")}
          className="mb-0.5"
        >
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
        </IconButton>
      </div>
    </Card>
  );

  // 自定义范围无效：保留筛选工具条以便直接修正日期，给出具体原因，不发请求
  if (customError) {
    return (
      <div className="space-y-4">
        {filterToolbar}
        <Card>
          <CardContent>
            <EmptyState
              icon={<CalendarRange className="h-5 w-5" />}
              title={t("时间范围无效")}
              description={renderTemplate(customError, { days: policy.maxCustomDays, note: policy.limitNote }, t)}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.kind !== "ready" || !aggregates || !bundle) {
    return <StatsStateCard state={state} onRetry={refresh} />;
  }

  const heatmapData = heatmap.state.kind === "ready" ? heatmap.state.data : null;

  return (
    <div className="space-y-4">
      {filterToolbar}

      {/* 近一年每日消耗分布（固定 366 天，与上面的档位选择器无关，同官网口径） */}
      <Card className="relative">
        {heatmap.isRefreshing && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>{t("近一年每日 Credits 消耗分布")}</CardTitle>
          <CardDescription>
            {heatmapData
              ? `${t("全年合计")} ${heatmapData.total.toFixed(2)} ${heatmapData.unit} · ${t("分档阈值由官网下发")}`
              : t("消耗分布取数中或暂不可用，不影响下方明细统计。")}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {heatmapData && heatmapData.items.length > 0 ? (
            <Heatmap days={heatmapData.items} levels={heatmapData.levels} unit={heatmapData.unit} />
          ) : (
            <EmptyState
              icon={<CalendarRange className="h-5 w-5" />}
              title={t("暂无消耗分布数据")}
              description={t("近一年没有可统计的消耗记录，或身份接口暂不可用。")}
            />
          )}
        </CardContent>
      </Card>

      <div className="relative">
        {busy && <RefreshOverlay />}
        <QoderOverviewCards aggregates={aggregates} />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="relative xl:col-span-3">
          {busy && <RefreshOverlay />}
          <CardHeader>
            <CardTitle>{t(chartTitle)}</CardTitle>
            <CardDescription>{t("按用途堆叠，悬停查看每日明细。")}</CardDescription>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {hasUsage ? (
              <StackedBars labels={dayLabels} series={chartSeries} yFormat={yFormat} tooltipFormat={tooltipFormat} />
            ) : (
              emptyUsageHint
            )}
          </CardContent>
        </Card>

        <Card className="relative xl:col-span-2">
          {busy && <RefreshOverlay />}
          <CardHeader>
            <CardTitle>{t("用途分布")}</CardTitle>
            <CardDescription>{t("按积分消耗占比展示用途。")}</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-[300px] items-center px-4 pb-4">
            {hasUsage ? (
              <QoderOperationDonut aggregates={aggregates} />
            ) : (
              <div className="w-full">{emptyUsageHint}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="relative">
        {busy && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>{t("模型明细")}</CardTitle>
          <CardDescription>{t("各模型的记录条数与积分消耗。")}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasUsage ? <QoderModelTable aggregates={aggregates} /> : emptyUsageHint}
        </CardContent>
      </Card>

      <Card className="relative">
        {busy && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>{t("消耗明细")}</CardTitle>
          <CardDescription>{t("逐条记录的积分消耗；金额是官网给的美元原价，未计费记录显示为「—」。")}</CardDescription>
        </CardHeader>
        <CardContent>{hasUsage ? <QoderUsageTable rows={bundle.rows} /> : emptyUsageHint}</CardContent>
      </Card>
    </div>
  );
}
