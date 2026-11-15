import { useRef, useState } from "react";
import { Gauge, LayoutGrid, List, LoaderCircle, Lock, RefreshCw } from "lucide-react";
import { BrandIcon } from "../BrandIcon";
import { ScrollFadeHint } from "../ScrollFadeHint";
import { IconButton } from "../ui/icon-button";
import { Segmented } from "../ui/segmented";
import { GlanceCards } from "../glance/GlanceCards";
import { GlanceRows } from "../glance/GlanceRows";
import type { GlanceInstance } from "../glance/data";
import type { ResetDisplay } from "../glance/GlanceLines";
import { cn } from "../../lib/utils";
import type { Language } from "../../i18n";
import type { Translate } from "../glance/data";

/**
 * 灵动岛展开态面板内容（ADR-0047）：标题行 + 实例列表。
 * 形态与速览面板同款两种（list 行列表 / cards 迷你卡片），复用同一套展示组件。
 * 固定尺寸（PANEL_W × PANEL_H），实例多时内部滚动；与胶囊内容同住在 morph 容器里，
 * 由外层按展开进度交叉淡入。
 */
export function IslandPanelContent({
  items,
  vaultUnlocked,
  refreshing,
  translate,
  language,
  resetDisplay,
  now,
  layout,
  onLayoutChange,
  onOpenMain,
  onRefresh,
  onDragStart,
  onDragEnd,
}: {
  items: GlanceInstance[];
  vaultUnlocked: boolean;
  refreshing: boolean;
  translate: Translate;
  language: Language;
  resetDisplay: ResetDisplay;
  now: number;
  /** 面板形态（设置项 islandLayout） */
  layout: "list" | "cards";
  onLayoutChange: (layout: "list" | "cards") => void;
  onOpenMain: () => void;
  onRefresh: () => void;
  /** 顶部拖动把手：按下拿起、松开落位（拖动位移由 Rust 侧按光标屏幕坐标换算） */
  onDragStart: (event: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: (persist: boolean) => void;
}) {
  const mainRef = useRef<HTMLElement>(null);
  // 悬停 0.3s 后才浮现把手指示条（对齐岛仔：划过不打扰，停留才露出）
  const [gripVisible, setGripVisible] = useState(false);
  const gripTimerRef = useRef<number | null>(null);

  function enterGrip() {
    if (gripTimerRef.current != null) window.clearTimeout(gripTimerRef.current);
    gripTimerRef.current = window.setTimeout(() => setGripVisible(true), 300);
  }

  function leaveGrip() {
    if (gripTimerRef.current != null) window.clearTimeout(gripTimerRef.current);
    gripTimerRef.current = null;
    setGripVisible(false);
  }

  return (
    // 面板与速览窗口同款层次：surface 外壳（morph 容器）+ surface-2 标题栏 + canvas 内容区，
    // 行卡片（bg-surface）落在 canvas 上才立得住——surface 套 surface 会成「框中框」
    <div className="flex h-full flex-col">
      <header className="relative flex h-9 shrink-0 items-center justify-between border-b border-line bg-surface-2/60 px-3">
        {/* 拖动把手区（岛仔式）：标题栏整块可拖，悬停 0.3s 浮现一根小横条 + 底色，
            与左右两侧按钮互不重叠——按钮 z-index 更高且自己消费 pointer 事件 */}
        <div
          className="absolute inset-x-10 inset-y-0 flex cursor-grab touch-none items-center justify-center active:cursor-grabbing"
          role="separator"
          aria-label={translate("拖动调整位置")}
          title={translate("按住拖动位置")}
          onMouseEnter={enterGrip}
          onMouseLeave={leaveGrip}
          onPointerDown={onDragStart}
          onPointerUp={() => {
            onDragEnd(true);
            leaveGrip();
          }}
          onPointerCancel={() => onDragEnd(false)}
        >
          <span
            className={cn(
              "h-[3px] rounded-full bg-fg-muted/40 transition-all duration-150",
              gripVisible ? "w-6 opacity-100" : "w-2 opacity-0",
            )}
          />
        </div>
        <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2">
          <BrandIcon size={18} className="rounded-[4px]" />
          <span className="truncate text-[12px] font-semibold text-fg">
            {translate("AI 用量助手")}
          </span>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-0.5">
          <Segmented
            size="sm"
            value={layout}
            onChange={onLayoutChange}
            options={[
              { value: "list", label: "", icon: <List className="h-3.5 w-3.5" /> },
              { value: "cards", label: "", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
            ]}
          />
          <IconButton
            onClick={onRefresh}
            disabled={refreshing}
            title={translate("刷新")}
            aria-label={translate("刷新")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </IconButton>
          <IconButton onClick={onOpenMain} title={translate("打开主窗口")} aria-label={translate("打开主窗口")}>
            <Gauge className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-canvas">
        <main ref={mainRef} className="no-scrollbar h-full overflow-y-auto p-2">
          {!vaultUnlocked ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
              <Lock className="h-5 w-5" />
              <span className="text-[12px]">{translate("凭据库不可用")}</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
              <LoaderCircle className="h-5 w-5" />
              <span className="text-[12px]">{translate("还没有用量数据")}</span>
            </div>
          ) : (
            layout === "cards" ? (
            <GlanceCards
              items={items}
              translate={translate}
              language={language}
              resetDisplay={resetDisplay}
              now={now}
            />
            ) : (
            <GlanceRows
              items={items}
              translate={translate}
              language={language}
              resetDisplay={resetDisplay}
              now={now}
            />
            )
          )}
        </main>
        <ScrollFadeHint viewportRef={mainRef} />
      </div>
    </div>
  );
}
