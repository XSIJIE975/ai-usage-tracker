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

export function formatRefreshLabel(minutes: number) {
  if (minutes < 1) return "已禁用";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} 小时`;
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

export function formatReset(iso?: string | null, now = Date.now()) {
  if (!iso) return "重置时间未知";
  const diff = new Date(iso).getTime() - now;
  if (!Number.isFinite(diff)) return "重置时间未知";
  if (diff <= 0) return "即将重置";
  const totalMinutes = Math.max(1, Math.floor(diff / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days} 天 ${hours} 小时后重置` : `${days} 天后重置`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours} 小时 ${minutes} 分钟后重置` : `${hours} 小时后重置`;
  }
  return `${minutes} 分钟后重置`;
}
