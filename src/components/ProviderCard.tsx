import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import type { MetricLine, ProviderSnapshot } from "../types/ipc";
import { formatClock, formatReset } from "../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Progress } from "./ui/progress";
import { cn } from "../lib/utils";

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
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
      <div className="space-y-1.5 py-2">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-slate-600">{line.label}</span>
          <span className="tabular-nums text-slate-900">
            {line.percentUsed !== undefined
              ? `已用 ${line.percentUsed.toFixed(1)}% · 剩余 ${remaining?.toFixed(1)}%`
              : `${line.suffix}${(line.used ?? 0).toFixed(2)} / ${line.suffix}${(line.limit ?? 0).toFixed(2)}`}
          </span>
        </div>
        <Progress
          value={percent}
          barClassName={cn(percent >= 90 && "bg-red-500", percent >= 70 && percent < 90 && "bg-amber-500")}
        />
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>{line.percentUsed !== undefined ? `剩余 ${remaining?.toFixed(1)}%` : `已用 ${percent}%`}</span>
          {line.resetsAt ? (
            <span className="text-slate-500" title={resetTitle}>
              {formatReset(line.resetsAt, now)}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-slate-600">{line.label}</span>
      <span
        className={cn(
          "font-medium tabular-nums",
          line.color ? "" : "text-slate-900",
        )}
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
  const isOk = snapshot.status === "ok";
  const needsConfig = snapshot.status === "needs_config";
  const now = useNow();

  return (
    <Card className={cn(compact && "rounded-lg")}>
      <CardHeader className={cn("flex-row items-start justify-between space-y-0", compact ? "p-4 pb-2" : "p-5 pb-3")}>
        <div>
          <CardTitle>{snapshot.providerName}</CardTitle>
          {!compact && (
            <p className="mt-1 text-xs text-slate-400">
              更新于 {formatClock(snapshot.updatedAt)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isOk ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label={refreshing ? "刷新中" : "刷新此 Provider"}
              title={refreshing ? "刷新中" : "刷新此 Provider"}
              className={cn(
                "inline-flex items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50",
                compact ? "h-6 w-6" : "h-7 w-7",
              )}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className={compact ? "px-4 pb-4" : "px-5 pb-5"}>
        {snapshot.message ? (
          <p className={cn("rounded-md px-3 py-2 text-xs", needsConfig ? "bg-slate-50 text-slate-500" : "bg-amber-50 text-amber-700")}>
            {snapshot.message}
          </p>
        ) : null}
        <div className={cn("divide-y divide-slate-100", snapshot.message ? "mt-2" : "")}>
          {snapshot.lines.map((line, index) => (
            <MetricRow key={`${line.label}-${index}`} line={line} now={now} />
          ))}
        </div>
        {snapshot.lines.length === 0 && !snapshot.message ? (
          <p className="py-2 text-xs text-slate-400">暂无数据</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
