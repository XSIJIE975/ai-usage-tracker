import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { IconButton } from "../../components/ui/icon-button";
import { Segmented } from "../../components/ui/segmented";
import { StatCard } from "../../components/ui/stat-card";
import { StackedBars } from "../../components/charts/StackedBars";
import {
  fetchOpenCodeLogs,
  fetchOpenCodeOverview,
  type OpenCodeLogsPage,
  type OpenCodeRequestLog,
  type OpenCodeStatsRange,
} from "../../providers/opencode-stats";
import { createUsageCache } from "../../stats/usage-cache";
import { useAppStore } from "../../store/useAppStore";
import { cn, formatCompact, formatInt } from "../../lib/utils";
import { applyParams, useLanguage, useT } from "../../i18n";
import { StatsStateCard, type StatsAsyncState } from "./StatsStateCard";
import { useStatsFetch } from "./use-stats-fetch";
import { useAutoRefresh } from "./use-auto-refresh";
import { useGlobalRefresh } from "./use-global-refresh";
import { ModelUsageTable } from "./opencode/ModelUsageTable";
import { RequestLogTable } from "./opencode/RequestLogTable";
import type { ProviderInstance } from "../../types/ipc";

const overviewCache = createUsageCache();

const RANGE_OPTIONS: { value: OpenCodeStatsRange; label: string }[] = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
];

const formatUsd = (value: number) => `$${value.toFixed(2)}`;
const formatUsdPrecise = (value: number) => `$${value.toFixed(4)}`;

/** 日桶是 YYYY-MM-DD；24h 小时桶是 ISO 时刻 */
const formatBucketLabel = (date: string, language: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return date;
    return language === "en"
      ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parsed)
      : `${parsed.getMonth() + 1}/${parsed.getDate()}`;
  }
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${String(parsed.getHours()).padStart(2, "0")}:00`;
};

type LogsError = { message: string; params?: Record<string, string | number> };

export function OpenCodeStats({ instance }: { instance: ProviderInstance }) {
  const [range, setRange] = useState<OpenCodeStatsRange>("30d");
  const [tab, setTab] = useState<"overview" | "logs">("overview");
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [refreshTick, setRefreshTick] = useState(0);

  const t = useT();
  const language = useLanguage();
  const cacheKey = `${instance.id}:${range}`;
  const refresh = () => {
    overviewCache.invalidate(cacheKey);
    setRefreshTick((tick) => tick + 1);
  };

  useAutoRefresh(refresh, instance);
  useGlobalRefresh(refresh, instance.id);

  const globalRefreshing = useAppStore(
    (state) => state.loading || Boolean(state.refreshingInstances[instance.id]),
  );

  const { state: overview, isRefreshing } = useStatsFetch(
    overviewCache,
    cacheKey,
    () => fetchOpenCodeOverview(instance, range),
    refreshTick,
  );

  // 请求日志：游标翻页，首屏走三态卡片；同区间刷新保留表格，切区间才清空
  const [logsState, setLogsState] = useState<StatsAsyncState<OpenCodeLogsPage>>({ kind: "loading" });
  const [logs, setLogs] = useState<OpenCodeRequestLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [logsLoadingMore, setLogsLoadingMore] = useState(false);
  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [logsMoreError, setLogsMoreError] = useState<LogsError | null>(null);
  const [logsRefreshError, setLogsRefreshError] = useState<LogsError | null>(null);
  const logsRequestRef = useRef(0);
  // 实例或区间变化都算换数据源：旧列表不能留在新标签下
  const logsKey = `${instance.id}:${range}`;
  const logsKeyRef = useRef<string | null>(null);
  const logsReadyRef = useRef(false);
  // 已用过的游标：防止 c1→c2→c1 这类两节点环无限“加载更多”
  const seenCursorsRef = useRef<Set<string>>(new Set());

  // 绘制前清空：等 useEffect 里再清会让旧区间数据先闪一帧。
  // 同时递增 requestId，作废仍在飞行中的旧 key 请求（否则它回来后会重新灌入旧数据）。
  useLayoutEffect(() => {
    if (logsKeyRef.current === logsKey) return;
    logsKeyRef.current = logsKey;
    logsRequestRef.current += 1;
    logsReadyRef.current = false;
    seenCursorsRef.current = new Set();
    setLogs([]);
    setNextCursor(null);
    setLogsState({ kind: "loading" });
    setLogsLoadingMore(false);
    setLogsRefreshing(false);
    setLogsMoreError(null);
    setLogsRefreshError(null);
  }, [logsKey]);

  const loadLogs = useCallback(
    async (cursor?: string, append = false) => {
      const requestId = ++logsRequestRef.current;
      if (append && cursor) seenCursorsRef.current.add(cursor);
      if (!append) seenCursorsRef.current = new Set();

      if (append) {
        setLogsLoadingMore(true);
        setLogsMoreError(null);
      } else if (logsReadyRef.current) {
        // 同区间刷新：保留已有表格与滚动位置，只转圈
        setLogsRefreshing(true);
        setLogsMoreError(null);
        setLogsRefreshError(null);
      } else {
        setLogsState({ kind: "loading" });
        setLogsMoreError(null);
        setLogsRefreshError(null);
      }

      try {
        const result = await fetchOpenCodeLogs(instance, range, cursor);
        if (requestId !== logsRequestRef.current) return;
        if (result.status !== "ok") {
          if (append) {
            setLogsMoreError({ message: result.message, params: result.params });
          } else if (logsReadyRef.current) {
            setLogsRefreshError({ message: result.message, params: result.params });
          } else {
            setLogsState(
              result.status === "needs_config"
                ? { kind: "needs_config", message: result.message, params: result.params }
                : { kind: "error", message: result.message, params: result.params },
            );
          }
          return;
        }
        const page = result.data;
        logsReadyRef.current = true;
        if (append) {
          setLogs((prev) => {
            const seen = new Set(prev.map((log) => log.id));
            const merged = [...prev];
            for (const item of page.items) {
              if (item.id && seen.has(item.id)) continue;
              seen.add(item.id);
              merged.push(item);
            }
            return merged;
          });
        } else {
          setLogs(page.items);
          // 首屏数据（含 retentionDays）保留到本轮区间结束；追加页不覆盖它
          setLogsState({ kind: "ready", data: page });
        }
        const candidate = page.nextCursor;
        const next =
          candidate && !seenCursorsRef.current.has(candidate) ? candidate : null;
        if (next) seenCursorsRef.current.add(next);
        setNextCursor(next);
        setLogsMoreError(null);
        setLogsRefreshError(null);
      } catch (error) {
        if (requestId !== logsRequestRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        if (append) setLogsMoreError({ message });
        else if (logsReadyRef.current) setLogsRefreshError({ message });
        else setLogsState({ kind: "error", message });
      } finally {
        if (requestId === logsRequestRef.current) {
          setLogsLoadingMore(false);
          setLogsRefreshing(false);
        }
      }
    },
    [instance, range],
  );

  useEffect(() => {
    if (tab !== "logs") return;
    void loadLogs();
  }, [tab, loadLogs, refreshTick]);

  const overviewData = overview.kind === "ready" ? overview.data : null;
  const summary = overviewData?.summary;
  const daily = overviewData?.daily ?? [];
  const models = overviewData?.models ?? [];
  const retentionDays = logsState.kind === "ready" ? logsState.data.retentionDays : 0;

  const dailyLabels = useMemo(
    () => daily.map((item) => formatBucketLabel(item.date, language)),
    [daily, language],
  );
  const dailyValues = useMemo(
    () => daily.map((item) => (metric === "cost" ? item.costUsd : item.tokens)),
    [daily, metric],
  );
  const dailySeries = useMemo(
    () => [{ name: metric === "cost" ? t("成本") : t("Tokens"), values: dailyValues }],
    [metric, dailyValues, t],
  );

  const busy = isRefreshing || globalRefreshing || logsRefreshing;
  const tabOptions = [
    { value: "overview" as const, label: t("概览") },
    { value: "logs" as const, label: t("请求日志") },
  ];
  const rangeOptions = RANGE_OPTIONS.map((option) => ({ ...option, label: t(option.label) }));
  const metricOptions = [
    { value: "cost" as const, label: t("成本") },
    { value: "tokens" as const, label: t("Tokens") },
  ];

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Segmented options={tabOptions} value={tab} onChange={setTab} />
      <div className="flex items-center gap-2">
        <Segmented size="sm" options={rangeOptions} value={range} onChange={setRange} />
        <IconButton
          onClick={refresh}
          disabled={busy}
          aria-label={busy ? t("刷新中") : t("刷新")}
          title={busy ? t("刷新中") : t("刷新")}
        >
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
        </IconButton>
      </div>
    </div>
  );

  if (tab === "overview" && overview.kind !== "ready") {
    return (
      <div className="space-y-4">
        {header}
        <StatsStateCard state={overview} onRetry={refresh} />
      </div>
    );
  }

  if (tab === "logs" && logsState.kind !== "ready") {
    return (
      <div className="space-y-4">
        {header}
        <StatsStateCard state={logsState} onRetry={() => void loadLogs()} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      {tab === "overview" ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label={t("成本")} value={formatUsd(summary?.costUsd ?? 0)} />
            <StatCard label={t("请求次数")} value={formatInt(summary?.requests ?? 0)} />
            <StatCard label={t("Tokens")} value={formatCompact(summary?.totalTokens ?? 0)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t("每日用量")}</CardTitle>
              <CardDescription>{t("所选区间的按日成本与 Token。")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-4 pb-4">
              <Segmented size="sm" options={metricOptions} value={metric} onChange={setMetric} />
              {daily.length === 0 ? (
                <p className="py-8 text-center text-xs text-fg-muted">{t("所选区间暂无数据。")}</p>
              ) : (
                <StackedBars
                  labels={dailyLabels}
                  series={dailySeries}
                  yFormat={metric === "cost" ? formatUsd : formatCompact}
                  tooltipFormat={metric === "cost" ? formatUsdPrecise : formatInt}
                  height={240}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("按模型用量")}</CardTitle>
              <CardDescription>{t("所选区间的模型明细。")}</CardDescription>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {models.length === 0 ? (
                <p className="py-8 text-center text-xs text-fg-muted">{t("所选区间暂无模型用量。")}</p>
              ) : (
                <ModelUsageTable models={models} />
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t("请求日志")}</CardTitle>
            <CardDescription>
              {t("所选区间的请求明细。")}
              {retentionDays > 0
                ? ` · ${applyParams(t("控制台仅保留最近 {days} 天日志"), { days: retentionDays })}`
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4">
            {logsRefreshError ? (
              <p className="text-center text-xs text-danger">
                {applyParams(t(logsRefreshError.message), logsRefreshError.params)}
              </p>
            ) : null}
            {logs.length === 0 ? (
              <p className="py-8 text-center text-xs text-fg-muted">{t("所选区间没有请求记录。")}</p>
            ) : (
              <RequestLogTable logs={logs} />
            )}
            {logsMoreError ? (
              <p className="text-center text-xs text-danger">
                {applyParams(t(logsMoreError.message), logsMoreError.params)}
              </p>
            ) : null}
            {nextCursor ? (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadLogs(nextCursor, true)}
                  disabled={logsLoadingMore}
                >
                  {logsLoadingMore ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : null}
                  {t("加载更多")}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
