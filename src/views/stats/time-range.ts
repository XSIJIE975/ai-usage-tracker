import { dayOffsetMs, daySpan } from "../../lib/utils";
import type { ProviderKind } from "../../types/ipc";

export type TimeRange = "today" | "yesterday" | "7d" | "30d" | "month" | "lastMonth" | "custom";

export interface StatsRangePolicy {
  /** 自定义区间的最大跨度（含首尾两天），超出直接报错 */
  maxCustomDays: number;
  /** 打开抽屉时的默认档 */
  defaultRange: TimeRange;
  /** 上限的成因（进用户文案）：是官方接口挡着，还是本工具自己设的闸——两者不能混为一谈 */
  limitNote: "官方接口限制" | "本工具的上限";
}

/** 没在表里的供应商走这份——现状：30 天上限 + 近 7 天默认 */
const FALLBACK_POLICY: StatsRangePolicy = {
  maxCustomDays: 30,
  defaultRange: "7d",
  limitNote: "官方接口限制",
};

/**
 * 时间范围策略按供应商声明（数值要有出处，别当分支写进各抽屉）：
 * - deepseek / glm：用量接口实测只支持约 30 天动态窗口，故成因写「官方接口限制」。
 * - workbuddy：沿用 30 天这个保守值，**未单独实测过上限**，故成因写「本工具的上限」。
 * - opencode-go：不走本模块（自己的区间口径），这里只为将来接入留位。
 * - qoder：`big_model_credits/histories` 实测 `page_size=1000` 一次回 535 条、
 *   `start_time`/`end_time` 任意区间都受理，且官网用量页自己就给近一年热力图（ADR-0030），
 *   故放开到 366 天；默认档取近 30 天（真机样本里一次重置跨了 95 天，7 天窗常常是空的）。
 */
const POLICIES: Partial<Record<ProviderKind, StatsRangePolicy>> = {
  workbuddy: { maxCustomDays: 30, defaultRange: "7d", limitNote: "本工具的上限" },
  "opencode-go": { maxCustomDays: 30, defaultRange: "7d", limitNote: "本工具的上限" },
  qoder: { maxCustomDays: 366, defaultRange: "30d", limitNote: "本工具的上限" },
};

export const statsRangePolicy = (kind: ProviderKind): StatsRangePolicy =>
  POLICIES[kind] ?? FALLBACK_POLICY;

/**
 * 自定义范围校验：返回用户可读的错误文案（含占位符），合法返回 null。
 * 不变式：**`resolveRangeMs` 对自定义档返回 null 的每一条路径，这里都必须给出对应成因** ——
 * 抽屉只在 customError 非空时显示原因，而区间为 null 会让 cacheKey 变 null、取数 effect 直接
 * 早退，于是界面停在 loading 且无话可说（日期输入被清空就是这条死路）。
 */
export const customRangeError = (
  kind: ProviderKind,
  customFrom: string,
  customTo: string,
): string | null => {
  const today = localMidnight(new Date());
  const startMs = parseLocalDateMs(customFrom);
  const toBase = parseLocalDateMs(customTo);
  if (startMs === null || toBase === null) return "请填写完整的开始与结束日期";
  if (toBase < startMs) return "开始日期不能晚于结束日期";
  if (toBase > today) return "结束日期不能晚于今天";
  const { maxCustomDays } = statsRangePolicy(kind);
  if (daySpan(startMs, toBase) + 1 > maxCustomDays) {
    // 天数与成因都留给渲染端填（renderTemplate 会先 t() 字符串参数）：
    // 整串烘焙进中文会让英文字典每档、每种成因各存一个键
    return "自定义范围最多 {days} 天（{note}）";
  }
  return null;
};

/** n 天前的 "YYYY-MM-DD"：抽屉里自定义范围的初始值（同样按日历日推，不减毫秒） */
export const isoDateDaysAgo = (n: number): string => isoDate(new Date(dayOffsetMs(Date.now(), -n)));

export const timeRangeOptions: { value: TimeRange; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "month", label: "本月" },
  { value: "lastMonth", label: "上月" },
  { value: "custom", label: "自定义范围" },
];

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
      return { startMs: today, endMs: dayOffsetMs(today, 1) };
    case "yesterday":
      return { startMs: dayOffsetMs(today, -1), endMs: today };
    case "7d":
      return { startMs: dayOffsetMs(today, -6), endMs: dayOffsetMs(today, 1) };
    case "30d":
      return { startMs: dayOffsetMs(today, -29), endMs: dayOffsetMs(today, 1) };
    case "month": {
      const now = new Date();
      return {
        startMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
        endMs: dayOffsetMs(today, 1),
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
      if (daySpan(startMs, toBase) + 1 > maxCustomDays) return null;
      return { startMs, endMs: dayOffsetMs(toBase, 1) };
    }
  }
};
