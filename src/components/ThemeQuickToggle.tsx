import { Monitor, Moon, Sun } from "lucide-react";
import { IconButton } from "./ui/icon-button";
import { applyParams, useT } from "../i18n";
import { nextThemeMode, type ThemeMode } from "../lib/theme";

const THEME_ICONS = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} satisfies Record<ThemeMode, typeof Monitor>;

const THEME_LABELS: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

/**
 * 主窗口头部的主题快捷切换：显示当前模式的图标，点击按
 * 跟随系统 → 浅色 → 深色 → 跟随系统 循环。
 * 只收 mode/onChange，不直接读写 store——写入路径由 useThemeModeSetting 统一。
 */
export function ThemeQuickToggle({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (next: ThemeMode) => void;
}) {
  const t = useT();
  const next = nextThemeMode(mode);
  const title = applyParams(t("主题：{mode}，点击切换到{next}"), {
    mode: t(THEME_LABELS[mode]),
    next: t(THEME_LABELS[next]),
  });
  const Icon = THEME_ICONS[mode];

  return (
    <IconButton onClick={() => onChange(next)} title={title} aria-label={title}>
      <Icon key={mode} className="theme-icon-enter h-4 w-4" aria-hidden />
    </IconButton>
  );
}
