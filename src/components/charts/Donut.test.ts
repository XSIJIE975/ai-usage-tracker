import { describe, expect, it } from "vitest";
import { donutPadAngle } from "./Donut";

describe("donutPadAngle", () => {
  it("returns 0 for fewer than two slices or empty totals", () => {
    expect(donutPadAngle([])).toBe(0);
    expect(donutPadAngle([1021.3])).toBe(0);
    expect(donutPadAngle([0, 0])).toBe(0);
  });

  it("keeps the regular 2° gap when every slice is thick enough", () => {
    expect(donutPadAngle([600, 400])).toBe(2);
    expect(donutPadAngle([500, 300, 200])).toBe(2);
  });

  it("shrinks the gap so a tiny slice is never swallowed by padding", () => {
    // 2026-09-17 用户实测：99.5% vs 0.5%（最小扇区角 1.8° < 固定 2° 间距 → 视觉缺口）
    const tiny = donutPadAngle([995, 5]);
    expect(tiny).toBeCloseTo(1.8 * 0.3, 10);
    expect(tiny).toBeLessThan(2);
  });

  it("still yields a positive gap for an extremely thin slice", () => {
    const value = donutPadAngle([1000, 1]);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeCloseTo(((1 / 1001) * 360) * 0.3, 10);
  });
});
