import { describe, expect, it } from "vitest";
import { customRangeError, isoDate, resolveRangeMs, statsRangePolicy } from "./time-range";

/** 距今 n 天的 "YYYY-MM-DD" */
const daysAgo = (n: number) => isoDate(new Date(Date.now() - n * 86_400_000));

const LIMIT_MESSAGE = "自定义范围最多 {days} 天（{note}）";

describe("statsRangePolicy", () => {
  it("DeepSeek / GLM 沿用 30 天上限 + 近 7 天默认，成因是官方接口", () => {
    for (const kind of ["deepseek", "glm"] as const) {
      expect(statsRangePolicy(kind)).toEqual({
        maxCustomDays: 30,
        defaultRange: "7d",
        limitNote: "官方接口限制",
      });
    }
  });

  it("WorkBuddy / OpenCode Go 的 30 天是沿用值而非实测上限，成因必须写「本工具的上限」", () => {
    for (const kind of ["workbuddy", "opencode-go"] as const) {
      expect(statsRangePolicy(kind).maxCustomDays).toBe(30);
      expect(statsRangePolicy(kind).limitNote).toBe("本工具的上限");
    }
  });

  it("qoder 放开到一年，默认近 30 天（histories 实测任意区间，ADR-0030）", () => {
    expect(statsRangePolicy("qoder")).toEqual({
      maxCustomDays: 366,
      defaultRange: "30d",
      limitNote: "本工具的上限",
    });
  });
});

describe("自定义范围上限按供应商分叉", () => {
  const from = daysAgo(100);
  const to = daysAgo(0);

  it("100 天跨度：30 天上限的供应商拒收，qoder 受理", () => {
    expect(customRangeError("glm", from, to)).toBe(LIMIT_MESSAGE);
    expect(customRangeError("qoder", from, to)).toBeNull();
    expect(resolveRangeMs("glm", "custom", from, to)).toBeNull();
    expect(resolveRangeMs("qoder", "custom", from, to)).not.toBeNull();
  });

  it("qoder 也拒超过自身上限的跨度，且倒挂与未来日期照旧拒", () => {
    expect(customRangeError("qoder", daysAgo(400), to)).toBe(LIMIT_MESSAGE);
    expect(customRangeError("qoder", to, from)).toBe("开始日期不能晚于结束日期");
    expect(customRangeError("qoder", from, daysAgo(-1))).toBe("结束日期不能晚于今天");
  });
});
