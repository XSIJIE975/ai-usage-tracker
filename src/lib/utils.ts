import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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

/** WorkBuddy 登录凭据归一化：期望输入就是 session Cookie 的 Value；同时兼容
 *  "session=…"、整串 Cookie（自动抠出 session 一项）、带 "Cookie:" 前缀的请求头旧写法。
 *  输出恒为 "session=<值>" 完整键值对（Rust 端按整串 Cookie 头原样携带）；
 *  多键 Cookie 里找不到 session 时原样（去前缀）返回，交由服务端判定 */
export function normalizeWorkbuddyCookie(value: string): string {
  let cookie = value.trim();
  if (cookie.toLowerCase().startsWith("cookie:")) {
    cookie = cookie.slice("cookie:".length).trim();
  }
  if (!cookie) return "";

  if (cookie.includes(";")) {
    for (const part of cookie.split(";")) {
      const [rawName, ...rest] = part.trim().split("=");
      if (rawName?.trim().toLowerCase() === "session") {
        return `session=${rest.join("=").trim()}`;
      }
    }
    return cookie;
  }

  if (/^session=/i.test(cookie)) {
    return `session=${cookie.slice("session=".length).trim()}`;
  }
  return `session=${cookie}`;
}

export function formatRefreshLabel(minutes: number, translate?: (s: string) => string) {
  const t = translate ?? ((s: string) => s);
  if (minutes < 1) return t("已禁用");
  if (minutes < 60) return `${minutes} ${t("分钟")}`;
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} ${t("小时")}`;
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
      ? `${days} ${t("天")} ${hours} ${t("小时")}${t("后重置")}`
      : `${days} ${t("天")}${t("后重置")}`;
  }
  if (hours > 0) {
    return minutes > 0
      ? `${hours} ${t("小时")} ${minutes} ${t("分钟")}${t("后重置")}`
      : `${hours} ${t("小时")}${t("后重置")}`;
  }
  return `${minutes} ${t("分钟")}${t("后重置")}`;
}
