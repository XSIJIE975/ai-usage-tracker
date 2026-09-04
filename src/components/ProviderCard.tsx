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
import { formatClock, formatInt, formatReset, formatResetAt } from "../lib/utils";
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

/** 额度行展示模式：percent 百分比进度（默认）/ amount 原始数值（翻卡背面，仅行内带 used/limit 时生效） */
export type MetricDisplay = "percent" | "amount";

function MetricRow({
  line,
  now,
  display,
}: {
  line: MetricLine;
  now: number;
  display: MetricDisplay;
}) {
  const t = useT();
  const language = useLanguage();
  const resetTimeDisplay = useAppStore((state) => state.settings.resetTimeDisplay);
  const label = applyParams(t(line.label), line.params);
  const valueText = line.value !== undefined ? t(line.value) : undefined;
  if (line.type === "progress") {
    const percent = line.percentUsed ?? (line.limit ? Math.round(((line.used ?? 0) / line.limit) * 100) : 0);
    const remaining =
      line.percentUsed === undefined ? undefined : Math.max(0, 100 - line.percentUsed);
    const used = line.used;
    const limit = line.limit;
    const showAmount = display === "amount" && used !== undefined && limit !== undefined;
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
            {showAmount
              ? `${t("已用")} ${formatInt(used)} / ${formatInt(limit)}`
              : line.percentUsed !== undefined
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
            {showAmount
              ? `${t("剩余")} ${formatInt(Math.max(0, limit - used))}`
              : line.percentUsed !== undefined
                ? `${t("剩余")} ${remaining?.toFixed(1)}%`
                : `${t("已用")} ${percent}%`}
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

/** 卡片主体（header + content）：翻卡正反两面复用同一结构，保证两面同构等高 */
interface CardBodyProps {
  display: MetricDisplay;
  instance: ProviderInstance;
  snapshot: ProviderSnapshot | null;
  compact: boolean;
  refreshing: boolean;
  /** 该面可翻（由卡片能否翻面决定，驱动 header 右侧为翻面按钮让位） */
  canFlip: boolean;
  now: number;
  onOpenDetail: () => void;
  onRefresh?: () => void;
  onTogglePin?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onOpenStats?: () => void;
  handleProps?: ComponentPropsWithoutRef<"button">;
  /** 翻面容器的 face 类（flip-face-front / flip-face-back）；非翻卡卡片为空 */
  faceClassName?: string;
  /** 该面是否当前朝向用户（隐藏面移出可访问树） */
  faceVisible: boolean;
}

function CardBody({
  display,
  instance,
  snapshot,
  compact,
  refreshing,
  canFlip,
  now,
  onOpenDetail,
  onRefresh,
  onTogglePin,
  onEdit,
  onDelete,
  onOpenStats,
  handleProps,
  faceClassName,
  faceVisible,
}: CardBodyProps) {
  const t = useT();
  const refreshIntervalMinutes = useAppStore((state) => state.settings.refreshIntervalMinutes);
  const kindName = providerName(instance.providerId);
  const title = displayName(instance, kindName);
  const hasNote = instance.note.trim().length > 0;
  const needsConfig = snapshot?.status === "needs_config";
  const statsDisabled = snapshot?.status !== "ok";

  return (
    <div className={faceClassName} aria-hidden={!faceVisible}>
      <CardHeader
        className={cn(
          "flex-row items-center justify-between space-y-0",
          compact ? "p-4 pb-2" : "p-5 pb-3",
          // 右上角翻面按钮占位：header 右侧按钮组让出按钮宽度（参考稿 header padding-right: 36px）
          canFlip && "pr-10",
        )}
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
            <div className="flex items-center justify-between gap-2 rounded-md bg-warning-soft px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-xs text-warning-soft-fg">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0">
                  {t(errorHintTitle(snapshot.message, snapshot.messageParams))}
                </span>
              </span>
              <button
                type="button"
                onClick={onOpenDetail}
                className="shrink-0 rounded-sm text-xs font-medium text-warning-soft-fg underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                aria-label={t("查看异常详情")}
                title={t("查看异常详情")}
              >
                {t("详情")}
              </button>
            </div>
          )
        ) : null}
        <div className={cn("divide-y divide-line", snapshot?.message ? "mt-2" : "")}>
          {(snapshot?.lines ?? []).map((line, index) => (
            <MetricRow key={`${line.label}-${index}`} line={line} now={now} display={display} />
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
    </div>
  );
}

/** 翻面图标：顺时针循环箭头（按参考稿内联 feather 风格原始路径，保证还原度） */
function FlipIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

/**
 * 右上角翻面按钮：作为 .flip-inner 的独立图层放进翻卡 3D 上下文，
 * 随所属面刚性翻转（翻转中不分层、不闪切）。正反两面各挂一枚，
 * backface-visibility 保证只有朝向用户的一面可见、可点。
 * 背面那枚贴在图层局部【左侧】并预转 180°：经整卡 180° 旋转后
 * 恰好出现在用户视角的右上角、且内容不镜像。
 */
function FlipCorner({
  back = false,
  faceActive,
  pressed,
  onToggle,
}: {
  /** 是否背面（数值面）按钮：贴局部左侧 + 预转 180° */
  back?: boolean;
  /** 所属面当前是否朝向用户（隐藏面退出 Tab 序与可访问树） */
  faceActive: boolean;
  /** 翻面状态（aria-pressed） */
  pressed: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={faceActive ? 0 : -1}
      aria-hidden={!faceActive}
      aria-pressed={pressed}
      aria-label={t("切换数值/百分比展示")}
      title={t("切换数值/百分比展示")}
      className={cn("flip-toggle", back && "flip-toggle-back")}
    >
      <FlipIcon className="flip-toggle-icon" />
    </button>
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
  /** 翻面朝向（受控）。主窗口网格传入，使拖拽浮起副本与占位卡共享朝向；缺省时内部自持 */
  flipped?: boolean;
  /** 翻面切换回调（受控时配套传入）；缺省时点击按钮切换内部状态 */
  onToggleFlip?: () => void;
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
  flipped: flippedProp,
  onToggleFlip,
}: ProviderCardProps) {
  const now = useNow();
  const [detailOpen, setDetailOpen] = useState(false);
  // 翻面朝向：受控（主窗口网格，拖拽浮起副本与占位卡共享）或内部自持（快速面板）。
  // 每卡片独立，不进全局设置，卡片之间、主/快窗口之间互不联动
  const [localFlipped, setLocalFlipped] = useState(false);
  const flipped = flippedProp ?? localFlipped;
  const toggleFlip = () => (onToggleFlip ? onToggleFlip() : setLocalFlipped((value) => !value));
  const kindName = providerName(instance.providerId);
  const title = displayName(instance, kindName);
  const needsConfig = snapshot?.status === "needs_config";
  // 仅当存在「百分比与原始数值俱全」的进度行时提供翻卡（当前即 GLM 配额行，
  // OpenCode 行只有百分比、DeepSeek 无进度行，天然不出现按钮）
  const canFlip = (snapshot?.lines ?? []).some(
    (line) =>
      line.type === "progress" &&
      line.percentUsed !== undefined &&
      line.used !== undefined &&
      line.limit !== undefined,
  );

  const bodyProps = {
    instance,
    snapshot,
    compact,
    refreshing,
    now,
    onOpenDetail: () => setDetailOpen(true),
    onRefresh,
    onTogglePin,
    onEdit,
    onDelete,
    onOpenStats,
    handleProps,
  };

  return (
    <div className={cn("relative", dragging && "opacity-40")}>
      <Card
        className={cn(
          "group/card hover:shadow-pop",
          // 翻转卡片的 box-shadow 过渡由 .flip-card 统一声明，避免与 transform 过渡互相覆盖。
          // 注意不能在这里加 opacity：opacity<1 会强制 preserve-3d 变 flat，
          // 拖拽占位的翻转卡会退化成整卡平面镜像（backface-visibility 同时失效）
          canFlip ? "flip-card" : "transition-shadow duration-normal",
          flipped && "flip-card-flipped",
        )}
      >
        {canFlip ? (
          // 正反两面 grid 同格叠放（取最大高度），翻转不动布局。
          // 两面内容固定：正面恒百分比、背面（自带 rotateY(180)，翻后朝向用户）恒数值。
          // 翻面按钮同为 .flip-inner 图层，随整卡在同一个 3D 上下文里刚性同步翻转
          <div className="flip-inner">
            <CardBody
              display="percent"
              faceClassName="flip-face flip-face-front"
              faceVisible={!flipped}
              canFlip
              {...bodyProps}
            />
            <CardBody
              display="amount"
              faceClassName="flip-face flip-face-back"
              faceVisible={flipped}
              canFlip
              {...bodyProps}
            />
            <FlipCorner faceActive={!flipped} pressed={flipped} onToggle={toggleFlip} />
            <FlipCorner back faceActive={flipped} pressed={flipped} onToggle={toggleFlip} />
          </div>
        ) : (
          <CardBody display="percent" faceVisible canFlip={false} {...bodyProps} />
        )}
      </Card>
      {/* 详情弹窗 portal 到 body，放卡片外避免在翻面上下文里随两面重复挂载 */}
      {snapshot?.message && !needsConfig && (
        <ErrorDetailsDialog
          open={detailOpen}
          onOpenChange={setDetailOpen}
          title={`${title} · ${kindName}`}
          message={snapshot.message}
          messageParams={snapshot.messageParams}
        />
      )}
    </div>
  );
}
