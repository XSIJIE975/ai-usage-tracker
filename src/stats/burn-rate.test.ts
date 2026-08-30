import { describe, expect, it } from "vitest";
import type { MetricPoint } from "./snapshot-history";
import { analyzeBurnRate } from "./burn-rate";

const HOUR = 3_600_000;

/** 构造等间隔点列：从 startMs 起、每小时一个点 */
function series(values: number[], startMs = 1_000_000_000_000): MetricPoint[] {
  return values.map((v, i) => ({ t: startMs + i * HOUR, v }));
}

describe("analyzeBurnRate", () => {
  it("样本不足 6 个 → insufficient 并给出估算小时数", () => {
    const result = analyzeBurnRate(series([100, 90, 80, 70]), {
      mode: "deplete",
      now: 1_000_000_000_000 + 3 * HOUR,
    });
    expect(result.kind).toBe("insufficient");
  });

  it("点数足够但跨度不足 1 小时 → insufficient", () => {
    const start = 1_000_000_000_000;
    const points = Array.from({ length: 8 }, (_, i) => ({
      t: start + i * 5 * 60_000,
      v: 100 - i,
    }));
    const result = analyzeBurnRate(points, {
      mode: "deplete",
      now: start + 7 * 5 * 60_000,
    });
    expect(result.kind).toBe("insufficient");
    if (result.kind === "insufficient") expect(result.hoursNeeded).toBeGreaterThanOrEqual(1);
  });

  it("deplete：余额稳定下降 → 预测耗尽时间", () => {
    // 每小时消耗 10，起点 100，6 个点后剩 50 → 还需 5 小时
    const points = series([100, 90, 80, 70, 60, 50]);
    const now = points[points.length - 1].t;
    const result = analyzeBurnRate(points, { mode: "deplete", now });
    expect(result.kind).toBe("predict");
    if (result.kind === "predict") {
      expect(result.ratePerHour).toBeCloseTo(-10, 5);
      expect(result.hoursLeft).toBeCloseTo(5, 5);
      expect(result.etaMs).toBe(now + 5 * HOUR);
    }
  });

  it("fill：额度稳定上升 → 预测用满时间；超过重置时间 → no-risk", () => {
    const points = series([10, 20, 30, 40, 50, 60]);
    const now = points[points.length - 1].t;
    const eta = now + 4 * HOUR; // 每小时 +10，60 → 100 需 4 小时

    const ok = analyzeBurnRate(points, {
      mode: "fill",
      resetsAt: new Date(eta + 10 * HOUR).toISOString(),
      now,
    });
    expect(ok.kind).toBe("predict");
    if (ok.kind === "predict") expect(ok.etaMs).toBeCloseTo(eta, 5);

    const noRisk = analyzeBurnRate(points, {
      mode: "fill",
      resetsAt: new Date(eta - 10 * HOUR).toISOString(),
      now,
    });
    expect(noRisk.kind).toBe("no-risk");
  });

  it("数值平稳（斜率不指向目标）→ stable", () => {
    const points = series([50, 50.2, 49.8, 50, 50.1, 49.9]);
    const now = points[points.length - 1].t;
    const result = analyzeBurnRate(points, { mode: "deplete", now });
    expect(result.kind).toBe("stable");
  });

  it("波动远大于趋势（R² 过低）→ stable", () => {
    const points = series([100, 10, 95, 5, 90, 50]);
    const now = points[points.length - 1].t;
    const result = analyzeBurnRate(points, { mode: "deplete", now });
    expect(result.kind).toBe("stable");
  });

  it("已越过目标 → at-target", () => {
    const points = series([5, 4, 3, 2, 1, 0]);
    const now = points[points.length - 1].t;
    const result = analyzeBurnRate(points, { mode: "deplete", now });
    expect(result.kind).toBe("at-target");
  });

  it("fill 已用 ≥100 → at-target", () => {
    const points = series([99.5, 99.7, 99.8, 99.9, 100, 100]);
    const now = points[points.length - 1].t;
    const result = analyzeBurnRate(points, { mode: "fill", now });
    expect(result.kind).toBe("at-target");
  });

  it("超出拟合窗口的旧点不参与计算", () => {
    const old = series([100, 0], 0); // 久远的异常点
    const recent = series([100, 90, 80, 70, 60, 50], 1_000_000_000_000);
    const now = recent[recent.length - 1].t;
    const result = analyzeBurnRate([...old, ...recent], {
      mode: "deplete",
      now,
      windowMs: 72 * HOUR,
    });
    expect(result.kind).toBe("predict");
    if (result.kind === "predict") expect(result.ratePerHour).toBeCloseTo(-10, 5);
  });
});
