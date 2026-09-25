import type { ProviderKind } from "../../types/ipc";

export type TimeRange = "today" | "yesterday" | "7d" | "30d" | "month" | "lastMonth" | "custom";

export interface StatsRangePolicy {
  /** 自定义区间的最大跨度（含首尾两天），超出直接报错 */
  maxCustomDays: number;
  /** 打开抽屉时的默认档 */
  defaultRange: TimeRange;
}

/** 没在表里的供应商走这份——现状：30 天上限 + 近 7 天默认 */
const FALLBACK_POLICY: StatsRangePolicy = { maxCustomDays: 30, defaultRange: "7d" };

/**
 * 时间范围策略按供应商声明（数值要有出处，别当分支写进各抽屉）：
 * - 30 天：DeepSeek / GLM 的用量接口实测只支持约 30 天动态窗口；WorkBuddy 与 OpenCode Go
 *   沿用同一个保守值——**未单独实测过上限**，不代表官方限制就是 30 天。
 * - qoder 366 天：`big_model_credits/histories` 实测 `page_size=1000` 一次回 535 条、
 *   `start_time`/`end_time` 任意区间都受理，且官网用量页自己就给近一年热力图（ADR-0030）。
 */
const POLICIES: Partial<Record<ProviderKind, StatsRangePolicy>> = {
  qoder: { maxCustomDays: 366, defaultRange: "30d" },
};

export const statsRangePolicy = (kind: ProviderKind): StatsRangePolicy =>
  POLICIES[kind] ?? FALLBACK_POLICY;

/**
 * 自定义范围校验：返回用户可读的错误文案，合法返回 null。
 * 输入未填完整时返回 null（由 resolveRangeMs 的非法判断兜底）。
 */
export const customRangeError = (
  kind: ProviderKind,
  customFrom: string,
  customTo: string,
): string | null => {
  const today = localMidnight(new Date());
  const startMs = parseLocalDateMs(customFrom);
  const toBase = parseLocalDateMs(customTo);
  if (startMs === null || toBase === null) return null;
  if (toBase < startMs) return "开始日期不能晚于结束日期";
  if (toBase > today) return "结束日期不能晚于今天";
  const { maxCustomDays } = statsRangePolicy(kind);
  if (toBase - startMs > (maxCustomDays - 1) * DAY_MS) {
    // 天数留给渲染端填（applyParams）：整串烘焙进中文会把英文字典撑成每档一个键
    return "自定义范围最多 {days} 天（官方接口限制）";
  }
  return null;
};

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
  kind: ProviderKind,
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
      // 上限按供应商声明（见 statsRangePolicy）：结束不晚于今天，且跨度（含首尾）不超过该值
      const { maxCustomDays } = statsRangePolicy(kind);
      if (toBase > today) return null;
      if (toBase - startMs > (maxCustomDays - 1) * DAY_MS) return null;
      return { startMs, endMs: toBase + DAY_MS };
    }
  }
};
