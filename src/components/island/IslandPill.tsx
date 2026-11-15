import { useEffect, useState } from "react";
import { UsageRing } from "../glance/GlanceCards";
import type { GlanceInstance } from "../glance/data";
import { cn } from "../../lib/utils";
import type { Translate } from "../glance/data";

/**
 * 灵动岛收起态胶囊内容（ADR-0047）：时钟 + 全实例最紧额度环 + 告警红点。
 * 只渲染内容，胶囊外形（圆角/尺寸/边框）由外层 morph 容器负责——设置页的实时预览
 * 复用同一组件保证所见即所得。
 */
export function IslandPillContent({
  time,
  tightest,
  alertActive,
  translate,
  className,
}: {
  /** 时钟文案（HH:mm）；空串 = 尚未起表 */
  time: string;
  /** 全实例最紧读数；null = 无任何进度数据 */
  tightest: GlanceInstance | null;
  alertActive: boolean;
  translate: Translate;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center gap-2 px-3",
        className,
      )}
    >
      <span className="tnum min-w-8 text-[12px] font-semibold text-fg" aria-hidden>
        {time || "--:--"}
      </span>
      {tightest?.tightestPercent != null ? (
        <UsageRing
          percent={tightest.tightestPercent}
          alert={tightest.alertActive}
          label={
            tightest.tightestLabel
              ? `${tightest.label} · ${tightest.tightestLabel}`
              : tightest.label
          }
          size={24}
          fontSize={8.5}
          stroke={2}
        />
      ) : (
        <span
          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-line-strong"
          aria-label={translate("暂无数据")}
          title={translate("暂无数据")}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-fg-muted" />
        </span>
      )}
      {alertActive && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
          aria-label={translate("有额度告警")}
          title={translate("有额度告警")}
        />
      )}
    </div>
  );
}

/** 每秒走字的 24 小时制时钟；enabled 为假时不跑定时器（岛禁用/预览关闭时零开销） */
export function useIslandClock(enabled: boolean): string {
  const [time, setTime] = useState("");
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      setTime(`${hh}:${mm}`);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return time;
}
