import { describe, expect, it } from "vitest";
import { Spring, lerp, smoothstep } from "./spring";

/** 固定步长推进，构造确定性轨迹 */
function run(spring: Spring, dt: number, frames: number): number[] {
  const trace: number[] = [];
  for (let i = 0; i < frames; i++) {
    spring.step(dt);
    trace.push(spring.pos);
  }
  return trace;
}

describe("Spring", () => {
  it("从静止收敛到目标并报告 settled", () => {
    const spring = new Spring(0, { stiffness: 320, zeta: 0.9 });
    spring.target = 1;
    run(spring, 1 / 60, 120);
    expect(Math.abs(spring.pos - 1)).toBeLessThan(0.001);
    expect(spring.settled()).toBe(true);
  });

  it("欠阻尼先过冲再回落", () => {
    const spring = new Spring(0, { stiffness: 320, zeta: 0.7 });
    spring.target = 1;
    const trace = run(spring, 1 / 60, 240);
    const peak = Math.max(...trace);
    expect(peak).toBeGreaterThan(1.02);
    expect(Math.abs(trace[trace.length - 1] - 1)).toBeLessThan(0.01);
  });

  it("帧率无关：不同帧间隔的轨迹一致", () => {
    // 同一物理时长 0.4s，分别按 240/120/60/30 Hz 推进
    const traces = [1 / 240, 1 / 120, 1 / 60, 1 / 30].map((dt) => {
      const spring = new Spring(0, { stiffness: 260, zeta: 0.8 });
      spring.target = 1;
      return run(spring, dt, Math.round(0.4 / dt));
    });
    for (const trace of traces) {
      // 不同帧率的末态应一致（子步积分保证），差异超过 1% 即为积分不稳
      expect(Math.abs(trace[trace.length - 1] - traces[0][traces[0].length - 1])).toBeLessThan(
        0.01,
      );
    }
    // 中途抽查也不应发散（子步积分保证形状一致，不追求逐点相等）
    for (const trace of traces) {
      for (const pos of trace) {
        expect(pos).toBeGreaterThanOrEqual(-0.05);
        expect(pos).toBeLessThanOrEqual(1.35);
      }
    }
  });

  it("途中改目标不跳变：速度保留、位置连续", () => {
    const spring = new Spring(0, { stiffness: 300, zeta: 0.85 });
    spring.target = 1;
    run(spring, 1 / 60, 8); // 展开途中
    const before = spring.pos;
    const velBefore = spring.vel;
    spring.target = 0; // 立刻反向收起
    spring.step(1 / 60);
    // 一帧内位置连续，不会瞬移
    expect(Math.abs(spring.pos - before)).toBeLessThan(0.2);
    // 速度方向在改目标后逐步反转，但本帧不会清零
    expect(spring.vel).not.toBe(0);
    expect(velBefore).not.toBe(0);
  });

  it("snap 直达并清空速度", () => {
    const spring = new Spring(0, { stiffness: 320, zeta: 0.7 });
    spring.target = 1;
    run(spring, 1 / 60, 5);
    spring.snap(0);
    expect(spring.pos).toBe(0);
    expect(spring.target).toBe(0);
    expect(spring.vel).toBe(0);
    expect(spring.settled()).toBe(true);
  });

  it("长帧被限幅，不会发散", () => {
    const spring = new Spring(0, { stiffness: 320, zeta: 0.8 });
    spring.target = 1;
    spring.step(5); // 掉帧 5 秒
    expect(Number.isFinite(spring.pos)).toBe(true);
    expect(Math.abs(spring.pos)).toBeLessThan(2);
  });
});

describe("插值", () => {
  it("lerp 与 smoothstep 端点封闭", () => {
    expect(lerp(20, 40, 0)).toBe(20);
    expect(lerp(20, 40, 1)).toBe(40);
    expect(lerp(20, 40, 0.5)).toBe(30);
    expect(smoothstep(0.5, 1, 0.4)).toBe(0);
    expect(smoothstep(0.5, 1, 1.2)).toBe(1);
    expect(smoothstep(0.5, 1, 0.75)).toBeCloseTo(0.5, 4);
    // 反向区间：越靠近 edge0 越强（t=0.8 → 0.896）
    expect(smoothstep(1, 0.5, 0.6)).toBeGreaterThan(0.85);
  });
});
