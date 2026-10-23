import { LoaderCircle, TriangleAlert, Wallet } from "lucide-react";
import { cn, displayPercentInteger } from "../../lib/utils";
import { metricColor, statusDotColor, type GlanceInstance } from "./data";
import type { Translate } from "./data";
import { ProviderLogo } from "../brand/provider-logo";
import { SiteBadge } from "../SiteBadge";
import { GlanceLines, type ResetDisplay } from "./GlanceLines";
import type { Language } from "../../i18n";

/** 迷你卡片形态：每实例一张小卡，左侧主指标环 + 右侧名称与明细（字段全部固定展示） */
export function GlanceCards({
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
    <div className="space-y-2.5">
      {items.map((item, index) => (
        <GlanceCard
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

function GlanceCard({
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
  const balance = item.lines.find((line) => line.kind === "balance");

  return (
    <div
      className={cn(
        "panel-enter rounded-xl border bg-surface p-3",
        item.alertActive ? "border-warning/40" : "border-line",
      )}
      // 级联进场：形态切换/范围变化时卡片依次上浮淡入（首挂载才动画，数值更新不重放）
      style={{ animationDelay: `${Math.min(index * 24, 180)}ms` }}
    >
      {/* 环 + 标题占顶部一行，指标区在下方占满整卡宽度：卡片文字列因此从 ~220px
          变回 ~276px，重置不用折到第二行、明细值也不会被甩到下一行 */}
      <div className="flex items-center gap-3">
        {percent !== null ? (
          <UsageRing percent={percent} alert={item.alertActive} label={item.tightestLabel ?? undefined} />
        ) : balance ? (
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[3px] border-line-strong"
            title={balance.label}
            aria-hidden
          >
            <Wallet className="h-4 w-4 text-fg-muted" />
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
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <ProviderLogo providerId={item.providerId} className="h-4 w-4 shrink-0" />
          {/* 徽标紧跟 logo：放在标题与百分比之间会把长供应商名挤成截断 */}
          <SiteBadge providerId={item.providerId} site={item.site} translate={translate} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{item.label}</span>
          {item.alertActive && (
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={translate("有额度告警")} />
          )}
          {item.refreshing && (
            <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" />
          )}
        </div>
      </div>
      {item.lines.length > 0 ? (
        <div className="mt-2">
          <GlanceLines
            lines={item.lines}
            translate={translate}
            language={language}
            resetDisplay={resetDisplay}
            now={now}
          />
        </div>
      ) : (
        <div className="mt-1 truncate text-[11px] leading-4 text-fg-muted">
          <StatusText item={item} translate={translate} />
        </div>
      )}
    </div>
  );
}

/**
 * 主指标环：细轨道 + 进度弧（顶部起点顺时针），环心大数字。
 * 刻意维持单环（ADR-0017 实现修正）：速览卡片右侧明细行已逐窗列读数，嵌套环在此是
 * 纯重复；且环心数字住在内环孔里，双层孔径 ~14px 连三位数字都放不下（实测 "100" 被裁成
 * "0"），数字与各层档位色还会互相打架。多层环只属于没有文字兜底的托盘图标与设置页方案预览卡。
 */
function UsageRing({
  percent,
  alert,
  label,
  size = 44,
}: {
  percent: number;
  alert: boolean;
  label?: string;
  size?: number;
}) {
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(percent, 0));
  const color = metricColor(percent, alert);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={label}>
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
          {displayPercentInteger(percent)}
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
