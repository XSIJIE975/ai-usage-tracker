import { useMemo, useState } from "react";
import { Activity, CalendarRange, LoaderCircle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Select } from "../../../components/ui/select";
import { Segmented } from "../../../components/ui/segmented";
import { Label } from "../../../components/ui/label";
import { IconButton } from "../../../components/ui/icon-button";
import { EmptyState } from "../../../components/ui/empty-state";
import { StackedBars } from "../../../components/charts/StackedBars";
import { aggregateWorkbuddyUsage, fetchWorkbuddyUsage } from "../../../providers/workbuddy-stats";
import { createUsageCache } from "../../../stats/usage-cache";
import { useAppStore } from "../../../store/useAppStore";
import { formatCompact, formatInt, cn } from "../../../lib/utils";
import { StatsStateCard } from "../StatsStateCard";
import { useStatsFetch } from "../use-stats-fetch";
import { useAutoRefresh } from "../use-auto-refresh";
import { useGlobalRefresh } from "../use-global-refresh";
import { customRangeError, isoDate, isoDateDaysAgo, resolveRangeMs, statsRangePolicy, timeRangeOptions, type TimeRange } from "../time-range";
import { formatDayLabel } from "../deepseek/usage-aggregation";
import { renderTemplate, useLanguage, useT } from "../../../i18n";
import type { ProviderInstance } from "../../../types/ipc";
import { WorkbuddyOverviewCards } from "./WorkbuddyOverviewCards";
import { WorkbuddyModelTable } from "./WorkbuddyModelTable";
import { WorkbuddyPurposeDonut } from "./WorkbuddyPurposeDonut";
import { WorkbuddyUsageTable } from "./WorkbuddyUsageTable";

type WorkbuddyMetric = "credits" | "requests";

const usageCache = createUsageCache();

const metricOptions: { value: WorkbuddyMetric; label: string }[] = [
  { value: "credits", label: "积分消耗" },
  { value: "requests", label: "请求次数" },
];

/** 格式化器必须是模块层稳定引用：内联箭头函数每次渲染都是新身份，会穿透 StackedBars 的
 *  option useMemo 导致每次渲染 setOption 重建图表（违背「hover 不 setOption」铁律） */
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

export function WorkbuddyStats({ instance }: { instance: ProviderInstance }) {
  const policy = statsRangePolicy(instance.providerId);
  const [range, setRange] = useState<TimeRange>(policy.defaultRange);
  const [metric, setMetric] = useState<WorkbuddyMetric>("credits");
  const [customFrom, setCustomFrom] = useState(() => isoDateDaysAgo(6));
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
  // cache key 前缀 instanceId：同种类两个实例的统计互不串数据
  const cacheKey =
    rangeMs === null ? null : `${instance.id}:${rangeMs.startMs}:${rangeMs.endMs}`;
  const { state, isRefreshing } = useStatsFetch(
    usageCache,
    cacheKey,
    () =>
      rangeMs === null
        ? Promise.reject(new Error("时间范围无效"))
        : fetchWorkbuddyUsage(instance, rangeMs.startMs, rangeMs.endMs),
    refreshTick,
  );

  const refresh = () => {
    if (cacheKey !== null) usageCache.invalidate(cacheKey);
    setRefreshTick((tick) => tick + 1);
  };

  // 接入全局自动刷新
  useAutoRefresh(refresh, instance);
  // 接入顶栏手动全局刷新
  useGlobalRefresh(refresh, instance.id);

  /** 全局刷新状态：顶栏「刷新」进行中（全局）或该实例单刷进行中 */
  const globalRefreshing = useAppStore(
    (state) => state.loading || Boolean(state.refreshingInstances[instance.id]),
  );
  const busy = isRefreshing || globalRefreshing;

  const bundle = state.kind === "ready" ? state.data : null;
  const aggregates = useMemo(
    () => (bundle && rangeMs ? aggregateWorkbuddyUsage(bundle.rows, rangeMs.startMs, rangeMs.endMs) : null),
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
  const chartTitle = metric === "credits" ? "积分消耗趋势" : "请求次数趋势";
  const hasUsage = (aggregates?.totalRequests ?? 0) > 0;
  const emptyUsageHint = (
    <EmptyState
      icon={<Activity className="h-5 w-5" />}
      title={t("所选时间范围内暂无用量数据")}
      description={t("调整时间范围，或确认 WorkBuddy 登录凭据有效。")}
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

  return (
    <div className="space-y-4">
      {/* 筛选工具条 */}
      {filterToolbar}

      {/* 指标总览 */}
      <div className="relative">
        {busy && <RefreshOverlay />}
        <WorkbuddyOverviewCards aggregates={aggregates} />
      </div>

      {/* 图表区：每日趋势 + 用途分布 */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="relative xl:col-span-3">
          {busy && <RefreshOverlay />}
          <CardHeader>
            <CardTitle>{t(chartTitle)}</CardTitle>
            <CardDescription>{t("按模型堆叠，悬停查看每日明细。")}</CardDescription>
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
            <CardDescription>{t("按积分消耗占比展示请求用途。")}</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-[300px] items-center px-4 pb-4">
            {hasUsage ? (
              <WorkbuddyPurposeDonut aggregates={aggregates} />
            ) : (
              <div className="w-full">{emptyUsageHint}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 模型维度表 */}
      <Card className="relative">
        {busy && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>{t("模型明细")}</CardTitle>
          <CardDescription>{t("各模型的请求次数与积分消耗。")}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasUsage ? <WorkbuddyModelTable aggregates={aggregates} /> : emptyUsageHint}
        </CardContent>
      </Card>

      {/* 消耗明细 */}
      <Card className="relative">
        {busy && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>{t("消耗明细")}</CardTitle>
          <CardDescription>{t("逐条请求的积分消耗；摘要为官网截断版原文。")}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasUsage ? <WorkbuddyUsageTable rows={bundle.rows} /> : emptyUsageHint}
        </CardContent>
      </Card>
    </div>
  );
}
