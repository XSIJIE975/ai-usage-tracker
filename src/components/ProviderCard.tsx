import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, Settings2 } from "lucide-react";
import type { MetricLine, ProviderSnapshot } from "../types/ipc";
import { formatClock, formatReset } from "../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Progress } from "./ui/progress";
import { Badge } from "./ui/badge";
import { IconButton } from "./ui/icon-button";
import { DeepSeekLogo, OpenCodeLogo } from "./brand/provider-logo";
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
  if (status === "ok") {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" /> 正常
      </Badge>
    );
  }
  if (status === "needs_config") {
    return (
      <Badge variant="neutral">
        <Settings2 className="h-3 w-3" /> 待配置
      </Badge>
    );
  }
  return (
    <Badge variant="warning">
      <AlertTriangle className="h-3 w-3" /> 异常
    </Badge>
  );
}

function MetricRow({ line, now }: { line: MetricLine; now: number }) {
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
          <span className="text-fg-secondary">{line.label}</span>
          <span className="tnum font-medium text-fg">
            {line.percentUsed !== undefined
              ? `已用 ${line.percentUsed.toFixed(1)}%`
              : `${line.suffix}${(line.used ?? 0).toFixed(2)} / ${line.suffix}${(line.limit ?? 0).toFixed(2)}`}
          </span>
        </div>
        <Progress
          value={percent}
          barClassName={cn(percent >= 90 && "bg-danger", percent >= 70 && percent < 90 && "bg-warning")}
        />
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <span className="tnum">
            {line.percentUsed !== undefined ? `剩余 ${remaining?.toFixed(1)}%` : `已用 ${percent}%`}
          </span>
          {line.resetsAt ? (
            <span title={resetTitle}>{formatReset(line.resetsAt, now)}</span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[13px]">
      <span className="text-fg-secondary">{line.label}</span>
      <span
        className={cn("tnum font-medium", !line.color && "text-fg")}
        style={line.color ? { color: line.color } : undefined}
      >
        {line.value}
      </span>
    </div>
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

  return (
    <Card className="transition-shadow duration-normal hover:shadow-pop">
      <CardHeader
        className={cn("flex-row items-center justify-between space-y-0", compact ? "p-4 pb-2" : "p-5 pb-3")}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderAvatar providerId={snapshot.providerId} name={snapshot.providerName} />
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{snapshot.providerName}</CardTitle>
            {!compact && (
              <p className="tnum mt-0.5 text-xs text-fg-muted">更新于 {formatClock(snapshot.updatedAt)}</p>
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
        {snapshot.lines.length === 0 && !snapshot.message ? (
          <p className="py-2 text-xs text-fg-muted">暂无数据</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
