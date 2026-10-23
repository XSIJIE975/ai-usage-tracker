import { LoaderCircle, TriangleAlert, Wallet } from "lucide-react";
import { cn, displayPercentInteger, formatResetDisplay } from "../../lib/utils";
import { metricColor, type GlanceInstance } from "./data";
import type { Translate } from "./data";
import { ProviderLogo } from "../brand/provider-logo";
import { SiteBadge } from "../SiteBadge";
import { GlanceLines, type ResetDisplay } from "./GlanceLines";
import type { Language } from "../../i18n";

/** 紧凑行列表形态：名称 + 最紧窗大号读数 / 该窗标签与重置 / 细进度条 / 其余窗口与说明行 */
export function GlanceRows({
  items,
  translate,
  language,
  resetDisplay,
  now,
}: {
  items: GlanceInstance[];
  translate: Translate;
  language: Language;
  resetDisplay: ResetDisplay;
  now: number;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <GlanceRow
          key={item.id}
          item={item}
          index={index}
          translate={translate}
          language={language}
          resetDisplay={resetDisplay}
          now={now}
        />
      ))}
    </div>
  );
}

function GlanceRow({
  item,
  index,
  translate,
  language,
  resetDisplay,
  now,
}: {
  item: GlanceInstance;
  index: number;
  translate: Translate;
  language: Language;
  resetDisplay: ResetDisplay;
  now: number;
}) {
  const percent = item.tightestPercent;
  const color = metricColor(percent, item.alertActive);
  const balance = item.lines.find((line) => line.kind === "balance");
  const hasStatus = item.lines.some((line) => line.kind === "status");
  // 大号读数已经是这扇最紧窗的百分比，它的标签/重置紧贴读数，不在下面重复一行；
  // 其余窗口与余额/明细/状态行照常逐行展示
  const otherLines = item.lines.filter((line) => !(line.kind === "window" && line.tightest));
  const resetText = formatResetDisplay(item.tightestResetsAt, {
    now,
    language,
    translate,
    display: resetDisplay,
  });
  const alternateReset = formatResetDisplay(item.tightestResetsAt, {
    now,
    language,
    translate,
    display: resetDisplay === "absolute" ? "relative" : "absolute",
  });

  return (
    <div
      className={cn(
        "panel-enter rounded-lg border bg-surface px-3 py-2",
        item.alertActive ? "border-warning/40" : "border-line",
      )}
      // 级联进场：形态切换/范围变化时实例块依次上浮淡入（首挂载才动画，数值更新不重放）
      style={{ animationDelay: `${Math.min(index * 24, 180)}ms` }}
    >
      <div className="flex items-center gap-2">
        <ProviderLogo providerId={item.providerId} className="h-4 w-4 shrink-0" />
        {/* 徽标紧跟 logo：放在标题与百分比之间会把长供应商名挤成截断 */}
        <SiteBadge providerId={item.providerId} site={item.site} translate={translate} />
        {item.alertActive && (
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={translate("有额度告警")} />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg" title={item.label}>
          {item.label}
        </span>
        {item.refreshing ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" />
        ) : percent !== null ? (
          <span className="flex shrink-0 items-baseline gap-1">
            <span className="text-[10px] text-fg-muted">{translate("已用")}</span>
            <span className="tnum text-[13px] font-semibold" style={{ color }}>
              {displayPercentInteger(percent)}%
            </span>
          </span>
        ) : balance ? (
          <Wallet className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-label={balance.label} />
        ) : hasStatus ? null : (
          <StatusText item={item} translate={translate} />
        )}
      </div>

      {percent !== null && item.tightestLabel ? (
        <div className="mt-1 flex items-baseline gap-2 text-[11px] leading-4 text-fg-muted">
          <span className="min-w-0 flex-1 truncate" title={item.tightestLabel}>
            {item.tightestLabel}
          </span>
          {resetText ? (
            <span
              className="tnum shrink-0 text-right text-[10px] text-fg-muted"
              title={alternateReset ?? undefined}
            >
              {resetText}
            </span>
          ) : null}
        </div>
      ) : null}

      {percent !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="panel-meter-bar h-full rounded-full"
            style={{ width: `${Math.min(100, Math.max(percent, 1.5))}%`, background: color }}
          />
        </div>
      )}

      {otherLines.length > 0 && (
        <div className="mt-1">
          <GlanceLines
            lines={otherLines}
            translate={translate}
            language={language}
            resetDisplay={resetDisplay}
            now={now}
          />
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
