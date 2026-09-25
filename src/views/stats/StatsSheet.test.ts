import { describe, expect, it } from "vitest";
import { providerHasStats } from "./StatsSheet";

describe("providerHasStats（种类 + 站点能力，ADR-0030/0031）", () => {
  it("挂了统计模块的种类有统计面", () => {
    expect(providerHasStats({ providerId: "deepseek", site: "china" })).toBe(true);
    expect(providerHasStats({ providerId: "workbuddy", site: "china" })).toBe(true);
  });

  it("qoder 两站都出统计入口（histories 与 credits-heatmap 同契约，免费号也有完整历史）", () => {
    expect(providerHasStats({ providerId: "qoder", site: "china" })).toBe(true);
    expect(providerHasStats({ providerId: "qoder", site: "international" })).toBe(true);
  });

  it("workbuddy 两站都有消耗明细（国际站用量页与中国站同款，2026-09-22 真机确认）", () => {
    expect(providerHasStats({ providerId: "workbuddy", site: "international" })).toBe(true);
  });
});
