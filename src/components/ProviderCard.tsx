import { useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Settings2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { MetricLine, ProviderSnapshot } from "../types/ipc";
import { formatClock, formatReset } from "../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Progress } from "./ui/progress";
import { Badge } from "./ui/badge";
import { IconButton } from "./ui/icon-button";
import { Sparkline } from "./charts/Sparkline";
import { DeepSeekLogo, OpenCodeLogo } from "./brand/provider-logo";
import { loadProviderHistory, type ProviderHistory } from "../stats/snapshot-history";
import { analyzeBurnRate } from "../stats/burn-rate";
import { describeBurnRate } from "../stats/burn-rate-format";
import { useAppStore } from "../store/useAppStore";
import { useLanguage, useT } from "../i18n";
import { cn } from "../lib/utils";

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/** 已知供应商使用官方标识，未识别的退回首字母头像 */
const BRAND_LOGOS: Record<
  string,
  { Logo: ComponentType<{ className?: string }>; bg: string }
> = {
  deepseek: { Logo: DeepSeekLogo, bg: "bg-[#5786FE]/10" },
  "opencode-go": { Logo: OpenCodeLogo, bg: "bg-fg/10" },
};

function ProviderAvatar({ providerId, name }: { providerId: string; name: string }) {
  const brand = BRAND_LOGOS[providerId];
  if (brand) {
    const { Logo, bg } = brand;
    return (
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", bg)} aria-hidden>
        <Logo className="h-5 w-5" />
      </span>
    );
  }
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-sm font-bold text-fg-secondary"
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

function statusBadge(status: ProviderSnapshot["status"]) {
  const t = useT();
  if (status === "ok") {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" /> {t("正常")}
      </Badge>
    );
  }
  if (status === "needs_config") {
    return (
      <Badge variant="neutral">
        <Settings2 className="h-3 w-3" /> {t("待配置")}
      </Badge>
    );
  }
  return (
    <Badge variant="warning">
      <AlertTriangle className="h-3 w-3" /> {t("异常")}
    </Badge>
  );
}

function MetricRow({ line, now }: { line: MetricLine; now: number }) {
  const t = useT();
  const label = t(line.label);
  const valueText = line.value !== undefined ? t(line.value) : undefined;
  if (line.type === "progress") {
    const percent = line.percentUsed ?? (line.limit ? Math.round(((line.used ?? 0) / line.limit) * 100) : 0);
    const remaining =
      line.percentUsed === undefined ? undefined : Math.max(0, 100 - line.percentUsed);
    const resetTitle = line.resetsAt
      ? new Intl.DateTimeFormat("zh-CN", {
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(line.resetsAt))
      : undefined;
    return (
      <div className="space-y-1.5 py-2.5">
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-fg-secondary">{label}</span>
          <span className="tnum font-medium text-fg">
            {line.percentUsed !== undefined
              ? `${t("已用")} ${line.percentUsed.toFixed(1)}%`
              : `${line.suffix ?? ""}${(line.used ?? 0).toFixed(2)} / ${line.suffix ?? ""}${(line.limit ?? 0).toFixed(2)}`}
          </span>
        </div>
        <Progress
          value={percent}
          barClassName={cn(percent >= 90 && "bg-danger", percent >= 70 && percent < 90 && "bg-warning")}
        />
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <span className="tnum">
            {line.percentUsed !== undefined ? `${t("剩余")} ${remaining?.toFixed(1)}%` : `${t("已用")} ${percent}%`}
          </span>
          {line.resetsAt ? (
            <span title={resetTitle}>{formatReset(line.resetsAt, now, t)}</span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[13px]">
      <span className="text-fg-secondary">{label}</span>
      <span
        className={cn("tnum font-medium", !line.color && "text-fg")}
        style={line.color ? { color: line.color } : undefined}
      >
        {valueText}
      </span>
    </div>
  );
}

/** 拉取供应商快照历史；每次快照更新（新数据落库）后自动重新加载 */
function useProviderHistory(providerId: string, updatedAt: number): ProviderHistory | null {
  const [history, setHistory] = useState<ProviderHistory | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadProviderHistory(providerId)
      .then((result) => {
        if (!cancelled) setHistory(result);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, updatedAt]);

  return history;
}

/** 紧凑模式的数据更新时间：相对形式 + 过期警示（超过刷新间隔 1.5 倍未更新） */
function CompactUpdatedAt({
  updatedAt,
  now,
  intervalMinutes,
}: {
  updatedAt: number;
  now: number;
  intervalMinutes: number;
}) {
  const t = useT();
  if (updatedAt <= 0) {
    return <p className="mt-0.5 text-[11px] text-fg-muted">{t("未更新")}</p>;
  }
  const delta = Math.max(0, now - updatedAt);
  const stale = intervalMinutes > 0 && delta > intervalMinutes * 60_000 * 1.5;
  const text =
    delta < 60_000
      ? t("刚刚")
      : delta < 3_600_000
        ? `${Math.floor(delta / 60_000)} ${t("分钟前")}`
        : formatClock(updatedAt);
  return (
    <p
      className={cn("tnum mt-0.5 text-[11px]", stale ? "text-warning" : "text-fg-muted")}
      title={`${t("更新于")} ${formatClock(updatedAt)}`}
    >
      {t("更新于")} {text}
    </p>
  );
}

export function ProviderCard({
  snapshot,
  compact = false,
  refreshing = false,
  onRefresh,
}: {
  snapshot: ProviderSnapshot;
  compact?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const needsConfig = snapshot.status === "needs_config";
  const now = useNow();
  const t = useT();
  const language = useLanguage();
  const refreshIntervalMinutes = useAppStore((state) => state.settings.refreshIntervalMinutes);
  const history = useProviderHistory(snapshot.providerId, snapshot.updatedAt);

  // 有重置时间的指标（额度窗口）按"用满"预测，否则按"耗尽"预测（余额）
  const fillMode = Boolean(history?.resetsAt);
  const burn = useMemo(() => {
    if (!history || history.points.length < 2 || snapshot.status !== "ok") return null;
    return analyzeBurnRate(
      history.points,
      fillMode ? { mode: "fill", resetsAt: history.resetsAt } : { mode: "deplete" },
    );
  }, [history, fillMode, snapshot.status]);
  const burnText = useMemo(
    () =>
      burn
        ? describeBurnRate(burn, {
            locale: language,
            mode: fillMode ? "fill" : "deplete",
          })
        : null,
    [burn, fillMode, language],
  );
  const trend = history && history.points.length >= 2 ? history : null;
  const sparkColor = snapshot.providerId === "deepseek" ? "#5786FE" : undefined;

  return (
    <Card className="transition-shadow duration-normal hover:shadow-pop">
      <CardHeader
        className={cn("flex-row items-center justify-between space-y-0", compact ? "p-4 pb-2" : "p-5 pb-3")}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderAvatar providerId={snapshot.providerId} name={snapshot.providerName} />
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{snapshot.providerName}</CardTitle>
            {!compact ? (
              <p className="tnum mt-0.5 text-xs text-fg-muted">
                {t("更新于")} {formatClock(snapshot.updatedAt)}
              </p>
            ) : (
              <CompactUpdatedAt
                updatedAt={snapshot.updatedAt}
                now={now}
                intervalMinutes={refreshIntervalMinutes}
              />
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {statusBadge(snapshot.status)}
          {onRefresh && (
            <IconButton
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label={refreshing ? "刷新中" : "刷新此 Provider"}
              title={refreshing ? "刷新中" : "刷新此 Provider"}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </IconButton>
          )}
        </div>
      </CardHeader>
      <CardContent className={compact ? "px-4 pb-4" : "px-5 pb-5"}>
        {snapshot.message ? (
          <p
            className={cn(
              "rounded-md px-3 py-2 text-xs leading-relaxed",
              needsConfig ? "bg-info-soft text-info-soft-fg" : "bg-warning-soft text-warning-soft-fg",
            )}
          >
            {snapshot.message}
          </p>
        ) : null}
        <div className={cn("divide-y divide-line", snapshot.message ? "mt-2" : "")}>
          {snapshot.lines.map((line, index) => (
            <MetricRow key={`${line.label}-${index}`} line={line} now={now} />
          ))}
        </div>
        {snapshot.status === "ok" && (burnText || trend) ? (
          <div className="mt-2 space-y-2">
            {burnText ? (
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-fg-muted">
                {fillMode ? (
                  <TrendingUp className="mt-0.5 h-3 w-3 shrink-0" />
                ) : (
                  <TrendingDown className="mt-0.5 h-3 w-3 shrink-0" />
                )}
                {burnText}
              </p>
            ) : null}
            {trend ? (
              <Sparkline points={trend.points} color={sparkColor} height={compact ? 44 : 56} />
            ) : null}
          </div>
        ) : null}
        {snapshot.lines.length === 0 && !snapshot.message ? (
          <p className="py-2 text-xs text-fg-muted">{t("暂无数据")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
