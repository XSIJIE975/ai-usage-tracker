import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * 监听元素尺寸变化。
 * 返回 ref 和当前宽高，用于图表根据容器宽度做响应式布局。
 */
export function useResizeObserver<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };

    update();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(el);
    } else {
      window.addEventListener("resize", update);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return [ref, size];
}
