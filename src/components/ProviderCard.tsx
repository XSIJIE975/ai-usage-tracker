import { useEffect, useState } from "react";
import type { ComponentPropsWithoutRef, ComponentType } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GripVertical,
  MoreHorizontal,
  Pencil,
  PieChart,
  Pin,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import type { MetricLine, ProviderInstance, ProviderSnapshot } from "../types/ipc";
import { formatClock, formatReset, formatResetAt } from "../lib/utils";
import { errorHintTitle } from "../lib/error-hint";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Progress } from "./ui/progress";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ErrorDetailsDialog } from "./ErrorDetailsDialog";
import { DeepSeekLogo, GlmLogo, OpenCodeLogo } from "./brand/provider-logo";
import { displayName } from "../lib/instance";
import { providerName } from "../providers";
import { useAppStore } from "../store/useAppStore";
import { applyParams, useLanguage, useT } from "../i18n";
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
  glm: { Logo: GlmLogo, bg: "bg-[#3859FF]/10" },
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

function StatusBadge({ snapshot }: { snapshot: ProviderSnapshot | null }) {
  const t = useT();
  if (!snapshot) {
    return null;
  }
  if (snapshot.status === "ok") {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" /> {t("正常")}
      </Badge>
    );
  }
  if (snapshot.status === "needs_config") {
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
  const language = useLanguage();
  const resetTimeDisplay = useAppStore((state) => state.settings.resetTimeDisplay);
  const label = applyParams(t(line.label), line.params);
  const valueText = line.value !== undefined ? t(line.value) : undefined;
  if (line.type === "progress") {
    const percent = line.percentUsed ?? (line.limit ? Math.round(((line.used ?? 0) / line.limit) * 100) : 0);
    const remaining =
      line.percentUsed === undefined ? undefined : Math.max(0, 100 - line.percentUsed);
    const resetTitle = line.resetsAt
      ? new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
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
            <button
              type="button"
              onClick={() => {
                const current = useAppStore.getState().settings;
                void useAppStore.getState().saveSettings({
                  ...current,
                  resetTimeDisplay: resetTimeDisplay === "absolute" ? "relative" : "absolute",
                });
              }}
              className="tnum rounded-sm transition-colors duration-fast hover:text-fg-secondary hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              title={`${t("点击切换重置时间显示")} · ${resetTitle ?? ""}`}
              aria-label={`${t("点击切换重置时间显示")}（${resetTitle ?? ""}）`}
              aria-pressed={resetTimeDisplay === "absolute"}
            >
              {resetTimeDisplay === "absolute"
                ? applyParams(t("{time} 重置"), { time: formatResetAt(line.resetsAt, language) })
                : formatReset(line.resetsAt, now, t)}
            </button>
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

export interface ProviderCardProps {
  instance: ProviderInstance;
  snapshot: ProviderSnapshot | null;
  compact?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  onTogglePin?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onOpenStats?: () => void;
  /** dnd 手柄的 listeners/attributes（由外层 Sortable 传入，仅主窗口网格） */
  handleProps?: ComponentPropsWithoutRef<"button">;
  dragging?: boolean;
}

export function ProviderCard({
  instance,
  snapshot,
  compact = false,
  refreshing = false,
  onRefresh,
  onTogglePin,
  onEdit,
  onDelete,
  onOpenStats,
  handleProps,
  dragging = false,
}: ProviderCardProps) {
  const now = useNow();
  const t = useT();
  const refreshIntervalMinutes = useAppStore((state) => state.settings.refreshIntervalMinutes);
  const [detailOpen, setDetailOpen] = useState(false);
  const kindName = providerName(instance.providerId);
  const title = displayName(instance, kindName);
  const hasNote = instance.note.trim().length > 0;
  const needsConfig = snapshot?.status === "needs_config";
  const statsDisabled = snapshot?.status !== "ok";

  return (
    <Card
      className={cn(
        "group/card transition-shadow duration-normal hover:shadow-pop",
        dragging && "opacity-40",
      )}
    >
      <CardHeader
        className={cn("flex-row items-center justify-between space-y-0", compact ? "p-4 pb-2" : "p-5 pb-3")}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {!compact && handleProps && (
            <button
              type="button"
              className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded-sm text-fg-muted opacity-0 transition-opacity duration-fast hover:text-fg-secondary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/card:opacity-100 aria-grabbed:cursor-grabbing active:cursor-grabbing"
              aria-label={t("拖动排序")}
              title={t("拖动排序")}
              {...handleProps}
            >
              <GripVertical className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
          <ProviderAvatar providerId={instance.providerId} name={kindName} />
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-1.5 truncate text-sm">
              <span className="truncate">{title}</span>
              {instance.pinned && !compact && (
                <Pin className="h-3 w-3 shrink-0 fill-brand text-brand" aria-label={t("已置顶")} />
              )}
            </CardTitle>
            {!compact ? (
              <p className="tnum mt-0.5 text-xs text-fg-muted">
                {hasNote && <span className="mr-1.5">{kindName}</span>}
                {snapshot
                  ? `${t("更新于")} ${formatClock(snapshot.updatedAt)}`
                  : t("等待刷新")}
              </p>
            ) : (
              <CompactUpdatedAt
                updatedAt={snapshot?.updatedAt ?? 0}
                now={now}
                intervalMinutes={refreshIntervalMinutes}
              />
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge snapshot={snapshot} />
          {onRefresh && (
            <IconButton
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label={refreshing ? t("刷新中") : t("刷新此供应商")}
              title={refreshing ? t("刷新中") : t("刷新此供应商")}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </IconButton>
          )}
          {!compact && (onTogglePin || onEdit || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" aria-label={t("更多操作")} title={t("更多操作")}>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onTogglePin && (
                  <DropdownMenuItem onSelect={() => onTogglePin()}>
                    <Pin className="h-3.5 w-3.5" />
                    {instance.pinned ? t("取消置顶") : t("置顶")}
                  </DropdownMenuItem>
                )}
                {onEdit && (
                  <DropdownMenuItem onSelect={() => onEdit()}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t("编辑配置")}
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => onDelete()}>
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("删除")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </CardHeader>
      <CardContent className={compact ? "px-4 pb-4" : "px-5 pb-5"}>
        {snapshot?.message ? (
          needsConfig ? (
            <div className="flex items-center justify-between gap-2 rounded-md bg-info-soft px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-xs leading-relaxed text-info-soft-fg">
                <Settings2 className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0">{applyParams(t(snapshot.message), snapshot.messageParams)}</span>
              </span>
              {!compact && onEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  className="shrink-0 rounded-sm text-xs font-medium text-info-soft-fg underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {t("去配置")}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 rounded-md bg-warning-soft px-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-xs text-warning-soft-fg">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    {t(errorHintTitle(snapshot.message, snapshot.messageParams))}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setDetailOpen(true)}
                  className="shrink-0 rounded-sm text-xs font-medium text-warning-soft-fg underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  aria-label={t("查看异常详情")}
                  title={t("查看异常详情")}
                >
                  {t("详情")}
                </button>
              </div>
              <ErrorDetailsDialog
                open={detailOpen}
                onOpenChange={setDetailOpen}
                title={`${title} · ${kindName}`}
                message={snapshot.message}
                messageParams={snapshot.messageParams}
              />
            </>
          )
        ) : null}
        <div className={cn("divide-y divide-line", snapshot?.message ? "mt-2" : "")}>
          {(snapshot?.lines ?? []).map((line, index) => (
            <MetricRow key={`${line.label}-${index}`} line={line} now={now} />
          ))}
        </div>
        {(!snapshot || snapshot.lines.length === 0) && !snapshot?.message ? (
          <p className="py-2 text-xs text-fg-muted">{t("暂无数据")}</p>
        ) : null}
        {!compact && onOpenStats && (
          <div className="mt-3 border-t border-line pt-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={statsDisabled}
              onClick={onOpenStats}
              title={statsDisabled ? t("获取数据后可查看统计") : t("查看统计")}
            >
              <PieChart className="h-3.5 w-3.5" /> {t("查看统计")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
