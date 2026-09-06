import { LoaderCircle, TriangleAlert } from "lucide-react";
import { cn, formatReset } from "../../lib/utils";
import { metricColor, statusDotColor, type GlanceInstance } from "./data";
import type { Translate } from "./data";

export interface GlanceFieldFlags {
  showAlerts: boolean;
  showBalance: boolean;
  showReset: boolean;
  showWindows: boolean;
}

/** 紧凑行列表形态：每实例一块，名称+百分比 / 细进度条+重置倒计时 / 可选字段行 */
export function GlanceRows({
  items,
  fields,
  translate,
}: {
  items: GlanceInstance[];
  fields: GlanceFieldFlags;
  translate: Translate;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <GlanceRow
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

function GlanceRow({
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
  const color = metricColor(percent, item.alertActive);
  const secondaryWindows = fields.showWindows
    ? item.windows.filter((window) => !window.primary)
    : [];
  const metaParts: string[] = [];
  if (secondaryWindows.length > 0) {
    metaParts.push(
      secondaryWindows.map((window) => `${window.label} ${Math.round(window.percent)}%`).join(" · "),
    );
  } else if (item.primaryLabel) {
    metaParts.push(item.primaryLabel);
  }
  const resetText =
    fields.showReset && item.primaryResetsAt
      ? formatReset(item.primaryResetsAt, Date.now(), translate)
      : null;

  return (
    <div
      className={cn(
        "panel-enter rounded-lg border bg-surface px-3 py-2",
        fields.showAlerts && item.alertActive ? "border-warning/40" : "border-line",
      )}
      // 级联进场：形态切换/范围变化时实例块依次上浮淡入（首挂载才动画，数值更新不重放）
      style={{ animationDelay: `${Math.min(index * 24, 180)}ms` }}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: statusDotColor(item.status) }}
          aria-hidden
        />
        {fields.showAlerts && item.alertActive && (
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={translate("有额度告警")} />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{item.label}</span>
        {item.refreshing ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" />
        ) : percent !== null ? (
          <span className="tnum shrink-0 text-[13px] font-semibold" style={{ color }}>
            {Math.round(percent)}%
          </span>
        ) : item.balanceText ? (
          <span className="tnum shrink-0 text-[13px] font-semibold text-fg">{item.balanceText}</span>
        ) : (
          <StatusText item={item} translate={translate} />
        )}
      </div>

      {percent !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="panel-meter-bar h-full rounded-full"
            style={{ width: `${Math.min(100, Math.max(percent, 1.5))}%`, background: color }}
          />
        </div>
      )}

      {(metaParts.length > 0 || resetText) && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] leading-4 text-fg-muted">
          <span className="min-w-0 truncate">{metaParts.join(" · ")}</span>
          {resetText && <span className="tnum shrink-0">{resetText}</span>}
        </div>
      )}

      {fields.showBalance && percent !== null && item.balanceText && (
        <div className="tnum mt-0.5 text-[11px] text-fg-secondary">
          {translate("账户余额")} {item.balanceText}
        </div>
      )}
    </div>
  );
}

function StatusText({ item, translate }: { item: GlanceInstance; translate: Translate }) {
  if (item.status === "error") {
    return <span className="shrink-0 text-[12px] text-danger">{translate("异常")}</span>;
  }
  if (item.status === "needs_config") {
    return <span className="shrink-0 text-[12px] text-fg-muted">{translate("待配置")}</span>;
  }
  return <span className="shrink-0 text-[12px] text-fg-muted">{translate("暂无数据")}</span>;
}
