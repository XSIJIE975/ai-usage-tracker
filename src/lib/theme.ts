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

// ─── 有效主题检测（用于图表等需要重渲染的场景） ───────────

/**
 * 解析当前生效的主题（"light" 或 "dark"）。
 * 优先看 data-theme 属性；为 system 时查 prefers-color-scheme 媒体查询。
 */
export function getEffectiveTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const dt = document.documentElement.getAttribute("data-theme");
  if (dt === "light" || dt === "dark") return dt;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

/**
 * React Hook：订阅有效主题变化（含 data-theme 切换与系统暗色偏好切换）。
 * 主题变化时触发组件重渲染，图表 / 色板等可以读取最新 CSS 变量值。
 */
export function useEffectiveTheme(): "light" | "dark" {
  const mode = useThemeMode();
  return useSyncExternalStore(
    subscribeEffectiveTheme,
    getEffectiveTheme,
    () => "light" as "light" | "dark",
  );
  // useThemeMode 调用保证 mode 变化时本 hook 也重渲染；
  // useSyncExternalStore 负责监听 matchMedia 变化
  void mode;
}

function subscribeEffectiveTheme(fn: () => void) {
  listeners.add(fn);
  // 监听系统暗色模式切换（system 模式下生效）
  let unlistenMql: (() => void) | undefined;
  if (typeof window !== "undefined" && window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", fn);
    unlistenMql = () => mql.removeEventListener("change", fn);
  }
  return () => {
    listeners.delete(fn);
    unlistenMql?.();
  };
}
