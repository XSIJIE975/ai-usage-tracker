export type TimeRange = "today" | "yesterday" | "7d" | "30d" | "month" | "lastMonth" | "custom";

export const timeRangeOptions: { value: TimeRange; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "month", label: "本月" },
  { value: "lastMonth", label: "上月" },
  { value: "custom", label: "自定义范围" },
];

const DAY_MS = 86_400_000;

/** 本地时区当日零点毫秒 */
const localMidnight = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "YYYY-MM-DD" → 本地零点毫秒；非法输入返回 null */
const parseLocalDateMs = (value: string): number | null => {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day).getTime();
};

/** Date → "YYYY-MM-DD"（本地时区），用于自定义日期输入的默认值 */
export const isoDate = (date: Date): string => {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

/**
 * 时间范围 → 取数区间：startMs 为起始日本地零点，endMs 为结束日次日本地零点
 * （自定义范围含首尾两天）。自定义起止非法或倒挂时返回 null。
 */
export const resolveRangeMs = (
  range: TimeRange,
  customFrom: string,
  customTo: string,
): { startMs: number; endMs: number } | null => {
  const today = localMidnight(new Date());
  switch (range) {
    case "today":
      return { startMs: today, endMs: today + DAY_MS };
    case "yesterday":
      return { startMs: today - DAY_MS, endMs: today };
    case "7d":
      return { startMs: today - 6 * DAY_MS, endMs: today + DAY_MS };
    case "30d":
      return { startMs: today - 29 * DAY_MS, endMs: today + DAY_MS };
    case "month": {
      const now = new Date();
      return {
        startMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
        endMs: today + DAY_MS,
      };
    }
    case "lastMonth": {
      const now = new Date();
      return {
        startMs: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
        endMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      };
    }
    case "custom": {
      const startMs = parseLocalDateMs(customFrom);
      const toBase = parseLocalDateMs(customTo);
      if (startMs === null || toBase === null || toBase < startMs) return null;
      return { startMs, endMs: toBase + DAY_MS };
    }
  }
};
