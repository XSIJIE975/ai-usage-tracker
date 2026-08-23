import { useSyncExternalStore } from "react";

/**
 * 主题模式：
 * - "system" 跟随系统（默认）
 * - "light" / "dark" 手动锁定
 * 仅持久化在 localStorage，属于纯界面偏好，不入库。
 */
export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "aui-theme";
const listeners = new Set<() => void>();

export function getThemeMode(): ThemeMode {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function setThemeMode(mode: ThemeMode) {
  localStorage.setItem(STORAGE_KEY, mode);
  applyTheme(mode);
  listeners.forEach((fn) => fn());
}

export function applyTheme(mode: ThemeMode = getThemeMode()) {
  const root = document.documentElement;
  if (mode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", mode);
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React Hook：读取并监听主题模式 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode);
}
