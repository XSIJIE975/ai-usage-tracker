import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/useAppStore";

/** 各供应商统计页最近一次已响应的序号，跨组件卸载保留 */
const handledTicks: Record<string, number> = {};

/**
 * 手动全局刷新联动：顶栏「刷新」走 `refreshAll` 手动路径并递增
 * `manualRefreshTick`，本 hook 在序号变化时调用统计页的刷新回调，
 * 使全局刷新同时覆盖统计数据。
 *
 * 若组件卸载期间发生过全局刷新（如在总览点了刷新再切到统计页签），
 * 重新挂载时依据模块级 `handledTicks` 补刷一次，避免停留在旧缓存。
 */
export function useGlobalRefresh(onRefresh: () => void, providerId: string) {
  const tick = useAppStore((state) => state.manualRefreshTick);
  const callbackRef = useRef(onRefresh);
  callbackRef.current = onRefresh;
  const seenTickRef = useRef<number | null>(null);

  useEffect(() => {
    if (seenTickRef.current === null) {
      seenTickRef.current = tick;
      const handled = handledTicks[providerId];
      handledTicks[providerId] = tick;
      if (handled !== undefined && handled !== tick) {
        callbackRef.current();
      }
      return;
    }
    if (seenTickRef.current === tick) return;
    seenTickRef.current = tick;
    handledTicks[providerId] = tick;
    callbackRef.current();
  }, [tick, providerId]);
}
