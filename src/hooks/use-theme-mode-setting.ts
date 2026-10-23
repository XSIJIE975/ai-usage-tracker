import { useCallback } from "react";
import { setThemeMode, useThemeMode, type ThemeMode } from "../lib/theme";
import { useAppStore } from "../store/useAppStore";

/**
 * 主题切换的唯一写入路径：先即时生效并广播到所有窗口，再落本机设置。
 * 设置抽屉的「外观」分段控件与主窗口头部快捷按钮共用，避免两套状态。
 */
export function useThemeModeSetting() {
  const mode = useThemeMode();
  const change = useCallback((next: ThemeMode) => {
    setThemeMode(next);
    const current = useAppStore.getState().settings;
    void useAppStore.getState().saveSettings({ ...current, themeMode: next });
  }, []);
  return [mode, change] as const;
}
