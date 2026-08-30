import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/useAppStore";

/**
 * 统计页自动刷新 hook。
 * 受「自动刷新总开关 + 供应商自动刷新」两级门控：
 * 读取全局 settings.refreshEnabled / refreshIntervalMinutes，
 * 并要求 settings.providers[providerId] 开启，
 * 按配置周期调用 onRefresh 回调，刷新统计页面数据。
 *
 * 回调经 ref 中转，避免内联闭包身份变化导致 effect 反复执行。
 * vault 未解锁或任一门控关闭时不启动定时器。
 */
export function useAutoRefresh(onRefresh: () => void, providerId: string) {
  const { settings, vaultStatus } = useAppStore();
  const callbackRef = useRef(onRefresh);
  callbackRef.current = onRefresh;

  const providerEnabled = settings.providers[providerId];

  useEffect(() => {
    if (!vaultStatus?.unlocked) return;
    if (!settings.refreshEnabled || settings.refreshIntervalMinutes <= 0) return;
    if (!providerEnabled) return;

    const intervalMs = settings.refreshIntervalMinutes * 60_000;
    const timer = window.setInterval(() => {
      callbackRef.current();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [settings.refreshEnabled, settings.refreshIntervalMinutes, providerEnabled, vaultStatus?.unlocked]);
}
