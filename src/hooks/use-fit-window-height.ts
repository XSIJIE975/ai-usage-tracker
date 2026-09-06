import { useEffect, type RefObject } from "react";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow, type Monitor } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

const DEFAULT_MIN_HEIGHT = 240;
const DEBOUNCE_MS = 120;
/** 与当前高度差小于该值不调整：刷新引起的卡片高度微变不让窗口抖动 */
const HEIGHT_EPSILON = 8;
/** 桥接「顶栏按下 → 拖动开始」的静默窗：mousedown 进入系统拖动后 DOM 可能收不到 mouseup */
const DRAG_HOLD_MS = 400;
/** 窗口移动（含拖动全程）后的静默期：拖动中改尺寸会打断系统拖动循环 */
const MOVE_QUIET_MS = 300;
/** 高度补间时长：OS 窗口尺寸本身无动画，瞬时跳变是面板顿挫感的主要来源 */
const TWEEN_MS = 220;

export interface FitWindowHeightOptions {
  /** 高度下限（逻辑像素），默认 240 */
  minHeight?: number;
  /** 底边锚定：高度变化后平移窗口顶边，保持底边贴住托盘（速览面板由托盘向上弹出时用） */
  keepBottom?: boolean;
}

/**
 * 面板高度自适应：观测 main 内内容包裹层的「自然高度」（不受视口钳制），
 * 把窗口高度补间到 clamp(顶栏+状态条+内边距+内容高, minHeight, 工作区×80%)。
 * 内容超过上限时窗口封顶、main 内部滚动。跨显示器移动后按新 DPI 重算上限。
 */
export function useFitWindowHeight(
  rootRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  options?: FitWindowHeightOptions,
) {
  const minHeight = options?.minHeight ?? DEFAULT_MIN_HEIGHT;
  const keepBottom = options?.keepBottom ?? false;

  useEffect(() => {
    const panel = getCurrentWindow();
    let disposed = false;
    let unlistenMove: UnlistenFn | undefined;
    let timer: number | undefined;
    let lastApplied = -1;
    let holdUntil = 0;
    let lastMoveAt = 0;
    let animToken = 0;
    let rafId: number | undefined;

    /** 高度补间：宽度不变，内层物理高度缓动到目标值；keepBottom 时底边保持不动。
        新目标到来时 token 失配即中止旧补间，从当前实际高度续走，不会来回跳。
        隐藏窗口中 rAF 暂停，重新显示后 t 超时一帧内落到终值，不会停在半途 */
    const animateHeight = async (targetLogical: number, monitor: Monitor) => {
      const token = ++animToken;
      const scale = await panel.scaleFactor().catch(() => 1);
      const [inner, outer, position] = await Promise.all([
        panel.innerSize().catch(() => null),
        panel.outerSize().catch(() => null),
        panel.outerPosition().catch(() => null),
      ]);
      if (disposed || token !== animToken || !inner || !outer || !position) return;
      const targetInner = Math.round(targetLogical * scale);
      const startInner = inner.height;
      const delta = targetInner - startInner;
      if (delta === 0) return;
      const frameChrome = outer.height - inner.height;
      const x = position.x;
      const bottom = position.y + outer.height;
      const minY = monitor.workArea.position.y;
      const start = performance.now();
      const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
      const step = (now: number) => {
        if (token !== animToken) return;
        const t = Math.min(1, (now - start) / TWEEN_MS);
        const height = Math.round(startInner + delta * easeOut(t));
        void panel.setSize(new PhysicalSize(inner.width, height)).catch(() => undefined);
        if (keepBottom) {
          const y = Math.max(minY, bottom - height - frameChrome);
          void panel.setPosition(new PhysicalPosition(x, y)).catch(() => undefined);
        }
        if (t < 1) rafId = requestAnimationFrame(step);
      };
      rafId = requestAnimationFrame(step);
    };

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
      // root(h-screen) 与 main(flex-1) 的高度差 = 顶栏 + 状态条等固定区域
      const chrome = root.clientHeight - main.clientHeight;
      const contentHeight = Math.round(content.getBoundingClientRect().height);
      const desired = Math.round(chrome + padV + contentHeight);
      const monitor = await currentMonitor();
      if (!monitor) return;
      // workArea 为物理像素，目标高度为逻辑像素，需按缩放比换算上限
      const maxLogical = Math.floor(
        (monitor.workArea.size.height / (monitor.scaleFactor || 1)) * 0.8,
      );
      const next = Math.max(minHeight, Math.min(maxLogical, desired));
      if (lastApplied >= 0 && Math.abs(next - lastApplied) <= HEIGHT_EPSILON) return;
      lastApplied = next;
      await animateHeight(next, monitor);
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
      animToken++;
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
      observer.disconnect();
      window.clearTimeout(timer);
      unlistenMove?.();
      document.removeEventListener("mousedown", onHeaderMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [rootRef, contentRef, minHeight, keepBottom]);
}
