import { describe, expect, it } from "vitest";
import { providerHasStats } from "./StatsSheet";

describe("providerHasStats（种类 + 站点能力，ADR-0030/0031）", () => {
  it("挂了统计模块的种类有统计面", () => {
    expect(providerHasStats({ providerId: "deepseek", site: "china" })).toBe(true);
    expect(providerHasStats({ providerId: "workbuddy", site: "china" })).toBe(true);
  });

  it("没有明细数据源的种类与站点都不出统计入口", () => {
    // qoder 整个种类没有历史端点
    expect(providerHasStats({ providerId: "qoder", site: "china" })).toBe(false);
    expect(providerHasStats({ providerId: "qoder", site: "international" })).toBe(false);
  });

  it("workbuddy 两站都有消耗明细（国际站用量页与中国站同款，2026-09-22 真机确认）", () => {
    expect(providerHasStats({ providerId: "workbuddy", site: "international" })).toBe(true);
  });
});
