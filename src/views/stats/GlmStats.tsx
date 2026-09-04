import { useMemo, useState } from "react";
import { Activity, CalendarRange, LoaderCircle, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { Segmented } from "../../components/ui/segmented";
import { Label } from "../../components/ui/label";
import { IconButton } from "../../components/ui/icon-button";
import { EmptyState } from "../../components/ui/empty-state";
import { StackedBars } from "../../components/charts/StackedBars";
import { Donut } from "../../components/charts/Donut";
import { fetchGlmUsage, type GlmUsageBundle } from "../../providers/glm-stats";
import { createUsageCache } from "../../stats/usage-cache";
import { useAppStore } from "../../store/useAppStore";
import { formatCompact, formatInt, cn } from "../../lib/utils";
import { StatsStateCard } from "./StatsStateCard";
import { useStatsFetch } from "./use-stats-fetch";
import { useAutoRefresh } from "./use-auto-refresh";
import { useGlobalRefresh } from "./use-global-refresh";
import { GlmOverviewCards } from "./glm/OverviewCards";
import { GlmModelUsageTable } from "./glm/ModelUsageTable";
import { GlmToolUsageTable } from "./glm/ToolUsageTable";
import {
  customRangeError,
  isoDate,
  resolveRangeMs,
  timeRangeOptions,
  type TimeRange,
} from "./time-range";
import { useT } from "../../i18n";
import type { ProviderInstance } from "../../types/ipc";
import {
  aggregateModelUsage,
  buildCallsSeries,
  buildModelSeries,
  dailyTotals,
  formatDayLabel,
} from "./glm/usage-aggregation";

const usageCache = createUsageCache();
const DAY_MS = 86_400_000;

type UsageMetric = "tokens" | "requests";

const metricOptions: { value: UsageMetric; label: string }[] = [
  { value: "tokens", label: "Token 消耗" },
  { value: "requests", label: "请求次数" },
];

/** 局部刷新遮罩：半透明覆盖 + 旋转加载图标，叠加在图表/卡片区域上 */
function RefreshOverlay() {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-canvas/40 backdrop-blur-[1px]">
      <LoaderCircle className="h-5 w-5 animate-spin text-brand" aria-hidden />
    </div>
  );
}

export function GlmStats({ instance }: { instance: ProviderInstance }) {
  const [range, setRange] = useState<TimeRange>("7d");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [customFrom, setCustomFrom] = useState(() =>
    isoDate(new Date(Date.now() - 6 * DAY_MS)),
  );
  const [customTo, setCustomTo] = useState(() => isoDate(new Date()));
  const [refreshTick, setRefreshTick] = useState(0);

  const rangeMs = useMemo(
    () => resolveRangeMs(range, customFrom, customTo),
    [range, customFrom, customTo],
  );
  const customError =
    range === "custom" ? customRangeError(customFrom, customTo) : null;
  const t = useT();
  // cache key 前缀 instanceId：同种类两个实例的统计互不串数据
  const cacheKey =
    rangeMs === null ? null : `${instance.id}:${rangeMs.startMs}:${rangeMs.endMs}`;
  const { state, isRefreshing } = useStatsFetch(
    usageCache,
    cacheKey,
    () =>
      rangeMs === null
        ? Promise.reject(new Error("时间范围无效"))
        : fetchGlmUsage(instance, rangeMs.startMs, rangeMs.endMs),
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

  const bundle: GlmUsageBundle | null =
    state.kind === "ready" ? state.data : null;
  const totals = useMemo(
    () => (bundle ? dailyTotals(bundle.models) : null),
    [bundle],
  );
  const aggregates = useMemo(
    () => (bundle ? aggregateModelUsage(bundle.models) : null),
    [bundle],
  );
  const chartSeries = useMemo(() => {
    if (!bundle || !totals) return [];
    return metric === "tokens"
      ? buildModelSeries(bundle.models, totals.days)
      : buildCallsSeries(totals.calls);
  }, [bundle, totals, metric]);
  const chartLabels = useMemo(
    () => (totals ? totals.days.map(formatDayLabel) : []),
    [totals],
  );

  const yFormat = formatCompact;
  const tooltipFormat = formatInt;
  const chartTitle = metric === "tokens" ? "Token 消耗趋势" : "请求次数趋势";
  const hasUsage =
    (aggregates?.totalTokens ?? 0) > 0 || (aggregates?.totalCalls ?? 0) > 0;
  const emptyUsageHint = (
    <EmptyState
      icon={<Activity className="h-5 w-5" />}
      title={t("所选时间范围内暂无用量数据")}
      description={t("调整时间范围，或在设置页确认智谱 Coding Plan API Key 有效。")}
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
              options={timeRangeOptions.map((option) => ({
                ...option,
                label: t(option.label),
              }))}
              value={range}
              onChange={setRange}
              aria-label="时间范围"
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
            options={metricOptions.map((option) => ({
              ...option,
              label: t(option.label),
            }))}
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
              description={customError}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (
    state.kind !== "ready" ||
    bundle === null ||
    aggregates === null ||
    totals === null
  ) {
    return <StatsStateCard state={state} onRetry={refresh} />;
  }

  return (
    <div className="space-y-4">
      {/* 筛选工具条 */}
      {filterToolbar}

      {/* 指标总览 */}
      <div className="relative">
        {busy && <RefreshOverlay />}
        <GlmOverviewCards aggregates={aggregates} />
      </div>

      {/* 图表区 */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="relative xl:col-span-3">
          {busy && <RefreshOverlay />}
          <CardHeader>
            <CardTitle>{t(chartTitle)}</CardTitle>
            <CardDescription>
              {metric === "tokens"
                ? t("按模型堆叠，悬停查看每日明细。")
                : t("全模型合计（接口不提供按模型的请求数）。")}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {hasUsage ? (
              <StackedBars
                labels={chartLabels}
                series={chartSeries}
                yFormat={yFormat}
                tooltipFormat={tooltipFormat}
              />
            ) : (
              emptyUsageHint
            )}
          </CardContent>
        </Card>

        <Card className="relative xl:col-span-2">
          {busy && <RefreshOverlay />}
          <CardHeader>
            <CardTitle>{t("模型 Token 占比")}</CardTitle>
            <CardDescription>{t("所选时间范围内的消耗构成。")}</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-[300px] items-center px-4 pb-4">
            {hasUsage ? (
              <Donut
                className="w-full"
                centerLabel={t("总 Token")}
                format={formatCompact}
                segments={aggregates.perModel.map((model) => ({
                  name: model.name,
                  value: model.tokens,
                }))}
              />
            ) : (
              <div className="w-full">{emptyUsageHint}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 模型明细表 */}
      <Card className="relative">
        {busy && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>{t("模型明细")}</CardTitle>
          <CardDescription>{t("各模型的 Token 消耗与占比。")}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasUsage ? (
            <GlmModelUsageTable models={aggregates.perModel} />
          ) : (
            emptyUsageHint
          )}
        </CardContent>
      </Card>

      {/* 工具用量表 */}
      <Card className="relative">
        {busy && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>{t("工具用量")}</CardTitle>
          <CardDescription>
            {t("联网搜索、网页阅读与 MCP 工具的调用统计。")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GlmToolUsageTable tools={bundle.tools} />
        </CardContent>
      </Card>
    </div>
  );
}
