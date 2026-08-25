import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/useAppStore";

/**
 * 统计页自动刷新 hook。
 * 读取全局 settings.refreshEnabled / refreshIntervalMinutes，
 * 按配置周期调用 onRefresh 回调，刷新统计页面数据。
 *
 * 回调经 ref 中转，避免内联闭包身份变化导致 effect 反复执行。
 * vault 未解锁或自动刷新关闭时不启动定时器。
 */
export function useAutoRefresh(onRefresh: () => void) {
  const { settings, vaultStatus } = useAppStore();
  const callbackRef = useRef(onRefresh);
  callbackRef.current = onRefresh;

  useEffect(() => {
    if (!vaultStatus?.unlocked) return;
    if (!settings.refreshEnabled || settings.refreshIntervalMinutes <= 0) return;

    const intervalMs = settings.refreshIntervalMinutes * 60_000;
    const timer = window.setInterval(() => {
      callbackRef.current();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [settings.refreshEnabled, settings.refreshIntervalMinutes, vaultStatus?.unlocked]);
}
