import { describe, expect, it } from "vitest";
import { customRangeError, isoDate, resolveRangeMs, statsRangePolicy } from "./time-range";

/** 距今 n 天的 "YYYY-MM-DD" */
const daysAgo = (n: number) => isoDate(new Date(Date.now() - n * 86_400_000));

describe("statsRangePolicy", () => {
  it("没进表的供应商沿用 30 天上限 + 近 7 天默认（与本次改造前的行为一致）", () => {
    for (const kind of ["deepseek", "glm", "workbuddy", "opencode-go"] as const) {
      expect(statsRangePolicy(kind)).toEqual({ maxCustomDays: 30, defaultRange: "7d" });
    }
  });

  it("qoder 放开到一年，默认近 30 天（histories 实测任意区间，ADR-0030）", () => {
    expect(statsRangePolicy("qoder")).toEqual({ maxCustomDays: 366, defaultRange: "30d" });
  });
});

describe("自定义范围上限按供应商分叉", () => {
  const from = daysAgo(100);
  const to = daysAgo(0);

  it("100 天跨度：30 天上限的供应商拒收，qoder 受理", () => {
    expect(customRangeError("glm", from, to)).toBe("自定义范围最多 30 天（官方接口限制）");
    expect(customRangeError("qoder", from, to)).toBeNull();
    expect(resolveRangeMs("glm", "custom", from, to)).toBeNull();
    expect(resolveRangeMs("qoder", "custom", from, to)).not.toBeNull();
  });

  it("qoder 也拒超过自身上限的跨度，且倒挂与未来日期照旧拒", () => {
    expect(customRangeError("qoder", daysAgo(400), to)).toBe(
      "自定义范围最多 366 天（官方接口限制）",
    );
    expect(customRangeError("qoder", to, from)).toBe("开始日期不能晚于结束日期");
    expect(customRangeError("qoder", from, daysAgo(-1))).toBe("结束日期不能晚于今天");
  });
});
