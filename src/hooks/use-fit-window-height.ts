import { useEffect, type RefObject } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

const PANEL_WIDTH = 380;
const MIN_HEIGHT = 240;
const DEBOUNCE_MS = 120;
/** 与当前高度差小于该值不调整：刷新引起的卡片高度微变不让窗口抖动 */
const HEIGHT_EPSILON = 8;
/** 桥接「顶栏按下 → 拖动开始」的静默窗：mousedown 进入系统拖动后 DOM 可能收不到 mouseup */
const DRAG_HOLD_MS = 400;
/** 窗口移动（含拖动全程）后的静默期：拖动中改尺寸会打断系统拖动循环 */
const MOVE_QUIET_MS = 300;

/**
 * 快速面板高度自适应：观测 main 内内容包裹层的「自然高度」（不受视口钳制），
 * setSize(380, clamp(顶栏+状态条+内边距+内容高, 240, 工作区×80%))。
 * 内容超过上限时窗口封顶、main 内部滚动。跨显示器移动后按新 DPI 重算上限。
 */
export function useFitWindowHeight(
  rootRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const panel = getCurrentWindow();
    let disposed = false;
    let unlistenMove: UnlistenFn | undefined;
    let timer: number | undefined;
    let lastApplied = -1;
    let holdUntil = 0;
    let lastMoveAt = 0;

    const apply = async () => {
      timer = undefined;
      const now = Date.now();
      if (now < holdUntil || now - lastMoveAt < MOVE_QUIET_MS) return;
      const root = rootRef.current;
      const content = contentRef.current;
      if (!root || !content) return;
      const main = content.closest("main");
      if (!main) return;
      const mainStyle = getComputedStyle(main);
      const padV = parseFloat(mainStyle.paddingTop) + parseFloat(mainStyle.paddingBottom);
      // root(h-screen) 与 main(flex-1) 的高度差 = 顶栏 + 状态条
      const chrome = root.clientHeight - main.clientHeight;
      const contentHeight = Math.round(content.getBoundingClientRect().height);
      const desired = Math.round(chrome + padV + contentHeight);
      const monitor = await currentMonitor();
      if (!monitor) return;
      // workArea 为物理像素，setSize 用逻辑尺寸，需按缩放比换算
      const maxLogical = Math.floor(
        (monitor.workArea.size.height / (monitor.scaleFactor || 1)) * 0.8,
      );
      const next = Math.max(MIN_HEIGHT, Math.min(maxLogical, desired));
      if (lastApplied >= 0 && Math.abs(next - lastApplied) <= HEIGHT_EPSILON) return;
      lastApplied = next;
      await panel.setSize(new LogicalSize(PANEL_WIDTH, next)).catch(() => undefined);
    };

    const schedule = (delay = DEBOUNCE_MS) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void apply(), delay);
    };

    const observer = new ResizeObserver(() => schedule());
    if (contentRef.current) observer.observe(contentRef.current);

    const onHeaderMouseDown = (event: MouseEvent) => {
      if (
        event.button === 0 &&
        event.target instanceof Element &&
        event.target.closest("[data-quick-header]")
      ) {
        holdUntil = Date.now() + DRAG_HOLD_MS;
      }
    };
    const onMouseUp = () => {
      holdUntil = 0;
    };
    document.addEventListener("mousedown", onHeaderMouseDown);
    document.addEventListener("mouseup", onMouseUp);

    void panel
      .onMoved(() => {
        lastMoveAt = Date.now();
        schedule(MOVE_QUIET_MS + DEBOUNCE_MS);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenMove = unlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(timer);
      unlistenMove?.();
      document.removeEventListener("mousedown", onHeaderMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [rootRef, contentRef]);
}
