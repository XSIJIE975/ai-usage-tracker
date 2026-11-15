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
        {/* 拖动把手：**只有中间那根指示条自己可拖**（约 40×16 的命中区），
            标题栏其余部分不响应拖动——否则「点标题」也会开始拖动，与打开主窗口等
            点击操作抢手势。悬停 0.3s 指示条由 2px 淡出条展开为 24px 实条。
            命中区比视觉条略大（40×16）以便瞄准，但仍限制在标题栏中部。 */}
        <div
          className="absolute left-1/2 top-1/2 flex h-4 w-10 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
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
          // 安全网：pointer capture 异常丢失（系统抢占/pointercancel 后续）时也必须
          // 调 end_island_drag，否则 Rust 侧 dragging 一直为真、展开被永久抑制。
          // 正常 pointerup 已先清掉 dragRef，这里再触发是幂等 no-op
          onLostPointerCapture={() => onDragEnd(false)}
        >
          <span
            className={cn(
              "h-[3px] rounded-full bg-fg-muted/40 transition-all duration-150",
              gripVisible ? "w-6 opacity-100" : "w-2 opacity-0",
            )}
          />
        </div>
        {/* 标题区不再是拖动区（拖动只归中间指示条）：恢复成「点击打开主窗口」，
            与左右按钮同层，避免手势定义含糊 */}
        <button
          type="button"
          onClick={onOpenMain}
          title={translate("打开主窗口")}
          className="relative z-10 flex min-w-0 items-center gap-2 rounded pr-2 text-left transition-colors hover:text-fg"
        >
          <BrandIcon size={18} className="rounded-[4px]" />
          <span className="truncate text-[12px] font-semibold text-fg">
            {translate("AI 用量助手")}
          </span>
        </button>
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
