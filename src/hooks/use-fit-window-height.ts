import { useEffect, type RefObject } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";

const PANEL_WIDTH = 380;
const MIN_HEIGHT = 240;
const DEBOUNCE_MS = 120;
/** 与当前高度差小于该值不调整：刷新引起的卡片高度微变不让窗口抖动 */
const HEIGHT_EPSILON = 8;

/**
 * 快速面板高度自适应：ResizeObserver 观测内容根高度，
 * 面板窗口 setSize 到 clamp(内容高, 240, 工作区×80%)。
 * 三条纪律：120ms 防抖；|Δ|≤8px 不调用；顶栏拖动期间跳过
 * （拖动中改尺寸会打断系统拖动循环）。
 */
export function useFitWindowHeight(contentRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const panel = getCurrentWindow();
    let resizing = false;
    let timer: number | undefined;
    let lastApplied = -1;

    const isHeaderPress = (target: EventTarget | null) =>
      target instanceof Element && target.closest("[data-quick-header]") !== null;

    const onDocumentMouseDown = (event: MouseEvent) => {
      if (event.button === 0 && isHeaderPress(event.target)) resizing = true;
    };
    const onDocumentMouseUp = () => {
      resizing = false;
    };

    const apply = async () => {
      timer = undefined;
      if (resizing) return;
      const element = contentRef.current;
      if (!element) return;
      const contentHeight = Math.round(element.getBoundingClientRect().height);
      const monitor = await currentMonitor();
      if (!monitor) return;
      // workArea 尺寸为物理像素，setSize 用逻辑尺寸，需除以缩放比；副屏切换后每次都会重算上限
      const maxLogical = Math.floor(
        (monitor.workArea.size.height / (monitor.scaleFactor || 1)) * 0.8,
      );
      const next = Math.max(MIN_HEIGHT, Math.min(Math.round(maxLogical), contentHeight));
      if (lastApplied >= 0 && Math.abs(next - lastApplied) <= HEIGHT_EPSILON) return;
      lastApplied = next;
      await panel.setSize(new LogicalSize(PANEL_WIDTH, next)).catch(() => undefined);
    };

    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void apply(), DEBOUNCE_MS);
    });
    if (contentRef.current) observer.observe(contentRef.current);

    document.addEventListener("mousedown", onDocumentMouseDown);
    document.addEventListener("mouseup", onDocumentMouseUp);

    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDocumentMouseDown);
      document.removeEventListener("mouseup", onDocumentMouseUp);
    };
  }, [contentRef]);
}
