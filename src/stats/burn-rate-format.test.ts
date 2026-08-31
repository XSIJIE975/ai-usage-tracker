import { describe, expect, it } from "vitest";
import { analyzeBurnRate } from "./burn-rate";
import { describeBurnRate } from "./burn-rate-format";
import type { MetricPoint } from "./snapshot-history";

const HOUR = 3_600_000;

function hourly(values: number[], now: number): MetricPoint[] {
  return values.map((v, i) => ({ t: now - (values.length - 1 - i) * HOUR, v }));
}

describe("describeBurnRate", () => {
  const now = 1_780_000_000_000;

  it("deplete 预测：中文文案含剩余时长与预计时间点", () => {
    const burn = analyzeBurnRate(hourly([100, 90, 80, 70, 60, 50], now), {
      mode: "deplete",
      now,
    });
    const text = describeBurnRate(burn, { locale: "zh", mode: "deplete" });
    expect(text).toContain("按当前速率，余额约 5 小时后耗尽（预计");
  });

  it("fill 预测：英文文案用 quota 措辞", () => {
    const burn = analyzeBurnRate(hourly([10, 20, 30, 40, 50, 60], now), {
      mode: "fill",
      now,
      resetsAt: new Date(now + 48 * HOUR).toISOString(),
    });
    const text = describeBurnRate(burn, { locale: "en", mode: "fill" });
    expect(text).toContain("monthly quota will be used up in about 4 hours");
  });

  it("at-target 不展示预测行", () => {
    const burn = analyzeBurnRate(hourly([5, 4, 3, 2, 1, 0], now), { mode: "deplete", now });
    expect(describeBurnRate(burn, { locale: "zh", mode: "deplete" })).toBeNull();
  });

  it("近乎静止的指标不得外推出越界 ETA（回归：RangeError: Invalid time value 白屏）", () => {
    // 余额连续 15 小时不变：最小二乘得到伪斜率，外推 ETA 远超 Date 可表示范围
    const idleBalance = Array.from({ length: 15 }, (_, i) => ({
      t: now - (14 - i) * HOUR - 9970 * (i + 1),
      v: 1234.56,
    }));
    // 额度按 1e-9/小时 漂移：单调指向目标但趋势无实际意义
    const microDrift = hourly([10, 10.000000001, 10.000000002, 10.000000003, 10.000000004, 10.000000005], now);

    for (const [points, mode] of [
      [idleBalance, "deplete"],
      [microDrift, "fill"],
    ] as const) {
      const burn = analyzeBurnRate(points, { mode, now });
      expect(burn.kind).toBe("stable");
      for (const locale of ["zh", "en"] as const) {
        expect(() => describeBurnRate(burn, { locale, mode })).not.toThrow();
      }
    }
  });
});
