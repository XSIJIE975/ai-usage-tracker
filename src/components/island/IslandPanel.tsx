import { useRef } from "react";
import { Gauge, LoaderCircle, Lock, RefreshCw } from "lucide-react";
import { BrandIcon } from "../BrandIcon";
import { ScrollFadeHint } from "../ScrollFadeHint";
import { IconButton } from "../ui/icon-button";
import { GlanceRows } from "../glance/GlanceRows";
import type { GlanceInstance } from "../glance/data";
import type { ResetDisplay } from "../glance/GlanceLines";
import { cn } from "../../lib/utils";
import type { Language } from "../../i18n";
import type { Translate } from "../glance/data";

/**
 * 灵动岛展开态面板内容（ADR-0047）：标题行 + 实例行列表（复用速览面板的行组件）。
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
  onOpenMain,
  onRefresh,
}: {
  items: GlanceInstance[];
  vaultUnlocked: boolean;
  refreshing: boolean;
  translate: Translate;
  language: Language;
  resetDisplay: ResetDisplay;
  now: number;
  onOpenMain: () => void;
  onRefresh: () => void;
}) {
  const mainRef = useRef<HTMLElement>(null);
  return (
    // 面板与速览窗口同款层次：surface 外壳（morph 容器）+ surface-2 标题栏 + canvas 内容区，
    // 行卡片（bg-surface）落在 canvas 上才立得住——surface 套 surface 会成「框中框」
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-surface-2/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <BrandIcon size={18} className="rounded-[4px]" />
          <span className="truncate text-[12px] font-semibold text-fg">
            {translate("AI 用量助手")}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
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
            <GlanceRows
              items={items}
              translate={translate}
              language={language}
              resetDisplay={resetDisplay}
              now={now}
            />
          )}
        </main>
        <ScrollFadeHint viewportRef={mainRef} />
      </div>
    </div>
  );
}
