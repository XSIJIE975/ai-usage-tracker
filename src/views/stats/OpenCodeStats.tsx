import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { IconButton } from "../../components/ui/icon-button";
import { Button } from "../../components/ui/button";
import { Pagination } from "../../components/ui/pagination";
import { EmptyState } from "../../components/ui/empty-state";
import { StackedBars } from "../../components/charts/StackedBars";
import { fetchOpenCodeMonthlyCost } from "../../providers/opencode-stats";
import { createUsageCache } from "../../stats/usage-cache";
import { useAppStore } from "../../store/useAppStore";
import { formatInt, cn } from "../../lib/utils";
import { StatsStateCard } from "./StatsStateCard";
import { useStatsFetch } from "./use-stats-fetch";
import { UsageHistoryTable } from "./opencode/UsageHistoryTable";
import {
  buildCostSeries,
  collectCostDays,
  dedupeModels,
  formatCostDayLabel,
  sumCostUsd,
} from "./opencode/cost-series";
import { useHistoryPages } from "./opencode/use-history-pages";
import { useLanguage, useT } from "../../i18n";
import { useAutoRefresh } from "./use-auto-refresh";
import { useGlobalRefresh } from "./use-global-refresh";

const monthlyCache = createUsageCache();

const currentMonth = () => {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
};

/** 局部刷新遮罩 */
function RefreshOverlay() {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-canvas/40 backdrop-blur-[1px]">
      <LoaderCircle className="h-5 w-5 animate-spin text-brand" aria-hidden />
    </div>
  );
}

export function OpenCodeStats() {
  const instance = useAppStore((state) =>
    state.instances.find((item) => item.providerId === "opencode-go"),
  );
  const [month, setMonth] = useState(currentMonth);
  const [model, setModel] = useState("all");
  const [keyId, setKeyId] = useState("all");
  const [refreshTick, setRefreshTick] = useState(0);

  const cacheKey = instance ? `${instance.id}:${month.year}-${month.month}` : null;
  const refresh = () => {
    if (cacheKey !== null) monthlyCache.invalidate(cacheKey);
    setRefreshTick((tick) => tick + 1);
  };

  // 接入全局自动刷新
  useAutoRefresh(refresh, instance ?? null);
  // 接入顶栏手动全局刷新
  useGlobalRefresh(refresh, instance?.id ?? null);

  /** 全局刷新状态：顶栏「刷新」进行中（全局）或该实例单刷进行中 */
  const globalRefreshing = useAppStore(
    (state) => state.loading || (instance ? Boolean(state.refreshingInstances[instance.id]) : false),
  );

  const { state: monthly, isRefreshing } = useStatsFetch(
    monthlyCache,
    cacheKey,
    () =>
      instance
        ? fetchOpenCodeMonthlyCost(instance, month.year, month.month)
        : Promise.resolve({ status: "needs_config" as const, message: "" }),
    refreshTick,
  );
  const history = useHistoryPages(instance ?? null, refreshTick);
  const busy = isRefreshing || globalRefreshing;
  const t = useT();
  const language = useLanguage();

  const costs = monthly.kind === "ready" ? monthly.data.costs : [];
  const keys = monthly.kind === "ready" ? monthly.data.keys : [];

  const filteredCosts = useMemo(
    () => (keyId === "all" ? costs : costs.filter((point) => point.keyId === keyId)),
    [costs, keyId],
  );
  const models = useMemo(() => dedupeModels(costs), [costs]);
  const chartModels = useMemo(
    () => (model === "all" ? models : models.filter((name) => name === model)),
    [models, model],
  );
  const costDays = useMemo(() => collectCostDays(filteredCosts), [filteredCosts]);
  const series = useMemo(
    () => buildCostSeries(filteredCosts, costDays, chartModels),
    [filteredCosts, costDays, chartModels],
  );
  const monthTotal = useMemo(
    () => sumCostUsd(model === "all" ? filteredCosts : filteredCosts.filter((p) => p.model === model)),
    [filteredCosts, model],
  );

  const visibleRecords = useMemo(
    () =>
      history.records.filter(
        (record) => (model === "all" || record.model === model) && (keyId === "all" || record.keyId === keyId),
      ),
    [history.records, model, keyId],
  );

  const shiftMonth = (delta: number) => {
    setMonth((prev) => {
      const date = new Date(prev.year, prev.month - 1 + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() + 1 };
    });
  };

  const now = currentMonth();
  const isCurrent = month.year === now.year && month.month === now.month;
  const modelOptions = [
    { value: "all", label: "所有模型" },
    ...models.map((name) => ({ value: name, label: name })),
  ];
  const keyOptions = [
    { value: "all", label: "所有密钥" },
    ...keys.map((key) => ({ value: key.id, label: key.displayName })),
  ];

  if (monthly.kind !== "ready") {
    return <StatsStateCard state={monthly} onRetry={refresh} />;
  }

  return (
    <div className="space-y-4">
      {/* 成本图表 */}
      <Card className="relative">
        {busy && <RefreshOverlay />}
        <CardHeader>
          <CardTitle>{t("成本")}</CardTitle>
          <CardDescription>
            {t("按模型细分的使用成本，本月合计")} <span className="tnum font-medium text-fg">${monthTotal.toFixed(2)}</span>。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            {/* 月份翻页器 */}
            <div className="inline-flex items-center rounded-md border border-line bg-surface shadow-sm">
              <IconButton onClick={() => shiftMonth(-1)} aria-label={t("上一月")}
                title={t("上一月")}  className="rounded-r-none">
                <ChevronLeft className="h-4 w-4" />
              </IconButton>
              <span className="tnum min-w-24 border-x border-line px-3 py-1.5 text-center text-[13px] font-medium text-fg">
                {language === "en" ? `${month.year}-${String(month.month).padStart(2, "0")}` : `${month.year}年${month.month}月`}
              </span>
              <IconButton
                onClick={() => shiftMonth(1)}
                disabled={isCurrent}
                aria-label={t("下一月")}
                title={t("下一月")}
                
                className="rounded-l-none"
              >
                <ChevronRight className="h-4 w-4" />
              </IconButton>
            </div>
            <Select
              options={modelOptions.map((option) => ({ ...option, label: t(option.label) }))}
              value={model}
              onChange={setModel}
              aria-label="模型筛选"
            />
            <Select
              options={keyOptions.map((option) => ({ ...option, label: t(option.label) }))}
              value={keyId}
              onChange={setKeyId}
              aria-label="密钥筛选"
            />
            <IconButton
              onClick={refresh}
              disabled={busy}
              aria-label={busy ? t("刷新中") : t("刷新")}
              title={busy ? t("刷新中") : t("刷新")}
            >
              <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
            </IconButton>
          </div>

          <StackedBars
            labels={costDays.map(formatCostDayLabel)}
            series={series}
            yFormat={(v) => `$${formatInt(v)}`}
            tooltipFormat={(v) => `$${v.toFixed(2)}`}
            height={280}
          />
        </CardContent>
      </Card>

      {/* 使用历史 */}
      <Card className="relative">
        <CardHeader>
          <CardTitle>{t("使用历史")}</CardTitle>
          <CardDescription>{t("近期 API 使用情况和成本。")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {history.configNeeded ? (
            <EmptyState
              icon={<KeyRound className="h-5 w-5" />}
              title={history.errorMessage || t("缺少凭据配置")}
              description={t("请前往设置页配置 Workspace ID 和 Auth Cookie。")}
            />
          ) : (
            <>
              <div className="relative">
                {history.loading && <RefreshOverlay />}
                <UsageHistoryTable records={visibleRecords} maxHeight={420} page={history.currentPage} />
              </div>
              {history.errorMessage ? (
                <div className="flex items-center justify-center gap-2">
                  <span className="text-xs text-danger">{history.errorMessage}</span>
                  <Button variant="outline" size="sm" onClick={() => history.goToPage(history.currentPage)}>
                    {t("重试")}
                  </Button>
                </div>
              ) : visibleRecords.length === 0 && !history.loading ? (
                <p className="text-center text-xs text-fg-muted">{t("当前筛选条件下暂无使用记录。")}</p>
              ) : (
                <Pagination
                  currentPage={history.currentPage}
                  hasPrev={history.hasPrev}
                  hasNext={history.hasNext && visibleRecords.length > 0}
                  loading={history.loading}
                  onPageChange={history.goToPage}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
