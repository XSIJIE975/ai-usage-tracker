import { LoaderCircle, TriangleAlert } from "lucide-react";
import { cn, formatReset } from "../../lib/utils";
import { metricColor, statusDotColor, type GlanceInstance } from "./data";
import type { Translate } from "./data";
import type { GlanceFieldFlags } from "./GlanceRows";
/** 迷你卡片形态：每实例一张小卡，左侧主指标环+大数字，右侧名称与明细 */
export function GlanceCards({
  items,
  fields,
  translate,
}: {
  items: GlanceInstance[];
  fields: GlanceFieldFlags;
  translate: Translate;
}) {
  return (
    <div className="space-y-2.5">
      {items.map((item, index) => (
        <GlanceCard
          key={item.id}
          item={item}
          index={index}
          fields={fields}
          translate={translate}
        />
      ))}
    </div>
  );
}

function GlanceCard({
  item,
  index,
  fields,
  translate,
}: {
  item: GlanceInstance;
  index: number;
  fields: GlanceFieldFlags;
  translate: Translate;
}) {
  const percent = item.primaryPercent;
  const detail = windowDetail(item, fields);
  const resetText =
    fields.showReset && item.primaryResetsAt
      ? formatReset(item.primaryResetsAt, Date.now(), translate)
      : null;

  return (
    <div
      className={cn(
        "panel-enter rounded-xl border bg-surface p-3",
        fields.showAlerts && item.alertActive ? "border-warning/40" : "border-line",
      )}
      // 级联进场：形态切换/范围变化时卡片依次上浮淡入（首挂载才动画，数值更新不重放）
      style={{ animationDelay: `${Math.min(index * 24, 180)}ms` }}
    >
      <div className="flex items-center gap-3">
        {percent !== null ? (
          <UsageRing percent={percent} alert={fields.showAlerts && item.alertActive} />
        ) : item.balanceText ? (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[3px] border-line-strong">
            <span className="text-[15px] font-semibold text-fg-muted">¥</span>
          </div>
        ) : (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[3px] border-dashed border-line-strong">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: statusDotColor(item.status) }}
              aria-hidden
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{item.label}</span>
            {fields.showAlerts && item.alertActive && (
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={translate("有额度告警")} />
            )}
            {item.refreshing && (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" />
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] leading-4 text-fg-muted">
            {percent !== null
              ? detail || item.primaryLabel || translate("暂无数据")
              : item.balanceText ?? <StatusText item={item} translate={translate} />}
          </div>
        </div>
      </div>
      {(resetText || (fields.showBalance && percent !== null && item.balanceText)) && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-fg-muted">
          <span className="tnum min-w-0 truncate">
            {fields.showBalance && percent !== null && item.balanceText
              ? `${translate("账户余额")} ${item.balanceText}`
              : ""}
          </span>
          {resetText && <span className="tnum shrink-0">{resetText}</span>}
        </div>
      )}
    </div>
  );
}

function windowDetail(item: GlanceInstance, fields: GlanceFieldFlags): string {
  const windows = fields.showWindows
    ? item.windows
    : item.windows.filter((window) => window.primary);
  return windows.map((window) => `${window.label} ${Math.round(window.percent)}%`).join(" · ");
}

/** 主指标环：细轨道 + 进度弧（顶部起点顺时针），环心大数字 */
function UsageRing({ percent, alert, size = 44 }: { percent: number; alert: boolean; size?: number }) {
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(percent, 0));
  const color = metricColor(percent, alert);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={stroke}
        />
        <circle
          className="panel-meter-ring"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="tnum text-[13px] font-semibold leading-none" style={{ color }}>
          {Math.round(percent)}
        </span>
      </div>
    </div>
  );
}

function StatusText({ item, translate }: { item: GlanceInstance; translate: Translate }) {
  if (item.status === "error") {
    return <span className="text-danger">{translate("异常")}</span>;
  }
  if (item.status === "needs_config") {
    return <span>{translate("待配置")}</span>;
  }
  return <span>{translate("暂无数据")}</span>;
}
