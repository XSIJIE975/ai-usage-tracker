import { useMemo, useState } from "react";
import { Activity, CalendarRange, KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { Segmented } from "../../components/ui/segmented";
import { Label } from "../../components/ui/label";
import { IconButton } from "../../components/ui/icon-button";
import { EmptyState } from "../../components/ui/empty-state";
import { StackedBars } from "../../components/charts/StackedBars";
import { Donut } from "../../components/charts/Donut";
import { fetchDeepSeekUsage } from "../../providers/deepseek-stats";
import { createUsageCache } from "../../stats/usage-cache";
import { formatCompact, formatInt, cn } from "../../lib/utils";
import { StatsStateCard } from "./StatsStateCard";
import { useStatsFetch } from "./use-stats-fetch";
import { useAutoRefresh } from "./use-auto-refresh";
import { OverviewCards } from "./deepseek/OverviewCards";
import { ModelUsageTable } from "./deepseek/ModelUsageTable";
import { isoDate, resolveRangeMs, timeRangeOptions, type TimeRange } from "./deepseek/time-range";
import {
  aggregateUsage,
  buildStackedSeries,
  collectDayLabels,
  formatDayLabel,
  type UsageMetric,
} from "./deepseek/usage-aggregation";

const usageCache = createUsageCache();
const DAY_MS = 86_400_000;

const metricOptions: { value: UsageMetric; label: string }[] = [
  { value: "tokens", label: "Token 消耗" },
  { value: "requests", label: "请求次数" },
  { value: "cost", label: "费用" },
];

/** 局部刷新遮罩：半透明覆盖 + 旋转加载图标，叠加在图表/卡片区域上 */
function RefreshOverlay() {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-canvas/40 backdrop-blur-[1px]">
      <LoaderCircle className="h-5 w-5 animate-spin text-brand" aria-hidden />
    </div>
  );
}

export function DeepSeekStats() {
  const [range, setRange] = useState<TimeRange>("7d");
  const [apiKeyId, setApiKeyId] = useState("all");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [customFrom, setCustomFrom] = useState(() => isoDate(new Date(Date.now() - 6 * DAY_MS)));
  const [customTo, setCustomTo] = useState(() => isoDate(new Date()));
  const [refreshTick, setRefreshTick] = useState(0);

  const rangeMs = useMemo(() => resolveRangeMs(range, customFrom, customTo), [range, customFrom, customTo]);
  const { state, isRefreshing } = useStatsFetch(
    usageCache,
    rangeMs === null ? null : `${rangeMs.startMs}:${rangeMs.endMs}`,
    () =>
      rangeMs === null
        ? Promise.reject(new Error("时间范围无效"))
        : fetchDeepSeekUsage(rangeMs.startMs, rangeMs.endMs),
    refreshTick,
  );

  const refresh = () => {
    if (rangeMs !== null) usageCache.invalidate(`${rangeMs.startMs}:${rangeMs.endMs}`);
    setRefreshTick((tick) => tick + 1);
  };

  // 接入全局自动刷新
  useAutoRefresh(refresh);

  const bundle = state.kind === "ready" ? state.data : null;
  const filteredRows = useMemo(() => {
    if (bundle === null) return [];
    return apiKeyId === "all" ? bundle.rows : bundle.rows.filter((row) => row.keyId === apiKeyId);
  }, [bundle, apiKeyId]);

  const aggregates = useMemo(() => aggregateUsage(filteredRows), [filteredRows]);
  const dayLabels = useMemo(() => collectDayLabels(filteredRows), [filteredRows]);
  const chartSeries = useMemo(
    () => buildStackedSeries(filteredRows, dayLabels, metric),
    [filteredRows, dayLabels, metric],
  );
  const chartLabels = useMemo(() => dayLabels.map(formatDayLabel), [dayLabels]);

  const keyOptions = useMemo(
    () => [
      { value: "all", label: "全部密钥" },
      ...(bundle?.apiKeys ?? []).map((key) => ({ value: key.id, label: key.name })),
    ],
    [bundle],
  );

  const yFormat = metric === "cost" ? (value: number) => `¥${formatCompact(value)}` : formatCompact;
  const tooltipFormat = metric === "cost" ? (value: number) => `¥${value.toFixed(2)}` : formatInt;
  const chartTitle =
    metric === "tokens" ? "Token 消耗趋势" : metric === "requests" ? "请求次数趋势" : "费用趋势";
  const hasUsage = aggregates.totalTokens > 0 || aggregates.totalRequests > 0;
  const emptyUsageHint = (
    <EmptyState
      icon={<Activity className="h-5 w-5" />}
      title="所选时间范围内暂无用量数据"
      description="调整时间范围，或在设置页确认 DeepSeek UserToken 有效。"
    />
  );

  if (state.kind !== "ready") {
    return <StatsStateCard state={state} onRetry={refresh} />;
  }

  return (
    <div className="space-y-4">
      {/* 筛选工具条 */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              <CalendarRange className="h-3.5 w-3.5" /> 时间范围
            </Label>
            <div className="flex items-center gap-2">
              <Select options={timeRangeOptions} value={range} onChange={setRange} aria-label="时间范围" />
              {range === "custom" && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.currentTarget.value)}
                    className="h-9 rounded-md border border-line bg-surface px-2 text-[13px] text-fg shadow-sm focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-focus-ring"
                    aria-label="开始日期"
                  />
                  <span className="text-fg-muted">–</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.currentTarget.value)}
                    className="h-9 rounded-md border border-line bg-surface px-2 text-[13px] text-fg shadow-sm focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-focus-ring"
                    aria-label="结束日期"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              <KeyRound className="h-3.5 w-3.5" /> API 密钥
            </Label>
            <Select options={keyOptions} value={apiKeyId} onChange={setApiKeyId} aria-label="API 密钥" />
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">统计指标</Label>
            <Segmented value={metric} onChange={setMetric} options={metricOptions} />
          </div>

          <IconButton onClick={refresh} aria-label="刷新" title="刷新" className="mb-0.5">
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          </IconButton>
        </div>
      </Card>

      {/* 指标总览 */}
      <div className="relative">
        {isRefreshing && <RefreshOverlay />}
        <OverviewCards aggregates={aggregates} currency={bundle?.currency ?? "CNY"} />
      </div>

      {/* 图表区 */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="relative xl:col-span-3">
          {isRefreshing && <RefreshOverlay />}
          <CardHeader>
            <CardTitle>{chartTitle}</CardTitle>
            <CardDescription>按模型堆叠，悬停查看每日明细。</CardDescription>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {hasUsage ? (
              <StackedBars labels={chartLabels} series={chartSeries} yFormat={yFormat} tooltipFormat={tooltipFormat} />
            ) : (
              emptyUsageHint
            )}
          </CardContent>
        </Card>

        <Card className="relative xl:col-span-2">
          {isRefreshing && <RefreshOverlay />}
          <CardHeader>
            <CardTitle>模型 Token 占比</CardTitle>
            <CardDescription>所选时间范围内的消耗构成。</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-[300px] items-center px-4 pb-4">
            {hasUsage ? (
              <Donut
                className="w-full"
                centerLabel="总 Token"
                format={formatCompact}
                segments={aggregates.perModel.map((model) => ({ name: model.model, value: model.totalTokens }))}
              />
            ) : (
              <div className="w-full">{emptyUsageHint}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 模型明细表 */}
      <Card className="relative">
        {isRefreshing && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>模型明细</CardTitle>
          <CardDescription>各模型的 token 消耗、缓存命中与费用。</CardDescription>
        </CardHeader>
        <CardContent>
          {hasUsage ? (
            <ModelUsageTable models={aggregates.perModel} totalTokens={aggregates.totalTokens} />
          ) : (
            emptyUsageHint
          )}
        </CardContent>
      </Card>
    </div>
  );
}
