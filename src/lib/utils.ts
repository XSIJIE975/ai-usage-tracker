import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { applyParams } from "../i18n/apply-params";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeOpenCodeAuthCookie(value: string): string {
  let cookie = value.trim();
  if (cookie.toLowerCase().startsWith("cookie:")) {
    cookie = cookie.slice("cookie:".length).trim();
  }

  if (cookie.includes(";")) {
    for (const part of cookie.split(";")) {
      const [rawName, ...rest] = part.trim().split("=");
      if (rawName?.trim().toLowerCase() === "auth") {
        return rest.join("=").trim();
      }
    }
  }

  if (/^auth=/i.test(cookie)) {
    return cookie.slice("auth=".length).trim();
  }

  return cookie;
}

/** 小时数标签（刷新间隔与告警冷却预设共用）：整串模板，英文用缩写单位 */
export function formatHoursLabel(hours: number | string, translate?: (s: string) => string) {
  const t = translate ?? ((s: string) => s);
  return applyParams(t("{hours} 小时"), { hours });
}

export function formatRefreshLabel(minutes: number, translate?: (s: string) => string) {
  const t = translate ?? ((s: string) => s);
  if (minutes < 1) return t("已禁用");
  if (minutes < 60) return applyParams(t("{minutes} 分钟"), { minutes });
  const hours = minutes / 60;
  return formatHoursLabel(hours % 1 === 0 ? hours : hours.toFixed(1), translate);
}

export function formatClock(ts: number | string | null | undefined) {
  if (!ts) return "暂无数据";
  const date = typeof ts === "string" ? new Date(ts) : new Date(ts);
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

/** 紧凑数字格式：1234 → 1,234；1520704 → 1.5M（图表轴与统计卡使用） */
export function formatCompact(value: number) {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(0)}K`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(value));
}

/** 千分位整数：152704 → 152,704 */
export function formatInt(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/**
 * 图表格式化器兜底（数字原样转字符串）。必须是模块级稳定引用：
 * 写成组件参数默认值 `format = (v) => String(v)` 时每次渲染都是新函数身份，
 * 会穿透图表 option 的 useMemo，让 echarts-for-react 每渲染 setOption(notMerge) 重建图形。
 */
export const formatPlain = (value: number) => String(value);

/** 字节数可读化：1536 → 1.5 KB；5242880 → 5 MB */
export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const text = index === 0 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[index]}`;
}

/** 重置时刻的绝对时间显示（M/D HH:mm，en 为 12 小时制），无效输入返回占位符 */
export function formatResetAt(iso: string, language: "zh" | "en" = "zh"): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: language === "en",
  }).format(date);
}

/** 相对口径的重置倒计时。整串模板而不是「数字 + 单位 + 后缀」逐词拼接——英文有单复数
 *  （1 day / 2 days），拼出来的句子无法正确变形；英文侧用缩写单位（d/h/min），
 *  顺带适配速览面板 320px 的窄行 */
export function formatReset(iso?: string | null, now = Date.now(), translate?: (s: string) => string) {
  const t = translate ?? ((s: string) => s);
  if (!iso) return t("重置时间未知");
  const diff = new Date(iso).getTime() - now;
  if (!Number.isFinite(diff)) return t("重置时间未知");
  if (diff <= 0) return t("即将重置");
  const totalMinutes = Math.max(1, Math.floor(diff / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0
      ? applyParams(t("{days} 天 {hours} 小时后重置"), { days, hours })
      : applyParams(t("{days} 天后重置"), { days });
  }
  if (hours > 0) {
    return minutes > 0
      ? applyParams(t("{hours} 小时 {minutes} 分钟后重置"), { hours, minutes })
      : applyParams(t("{hours} 小时后重置"), { hours });
  }
  return applyParams(t("{minutes} 分钟后重置"), { minutes });
}
