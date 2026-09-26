import { describe, expect, it } from "vitest";
import { heatGrid, heatLevel } from "./Heatmap";

/** 真机 credits-heatmap 下发的官方分档阈值（中国站 2026-09-25 实测） */
const LEVELS = [21.3659738556, 215.00358015839998, 423.6209661112, 986.7862368407999];

describe("heatLevel", () => {
  it("零与脏值都是「无消耗」档", () => {
    expect(heatLevel(0, LEVELS)).toBe(0);
    expect(heatLevel(-5, LEVELS)).toBe(0);
    expect(heatLevel(Number.NaN, LEVELS)).toBe(0);
  });

  it("阈值之间逐档上升，超过最高阈值钉在最后一档", () => {
    expect(heatLevel(5, LEVELS)).toBe(1);
    expect(heatLevel(207.25, LEVELS)).toBe(2);
    expect(heatLevel(300, LEVELS)).toBe(3);
    expect(heatLevel(500, LEVELS)).toBe(4);
    expect(heatLevel(986.79, LEVELS)).toBe(4);
    expect(heatLevel(5000, LEVELS)).toBe(4);
  });

  it("阈值缺失时所有有值的格子并成一档，不猜分位数", () => {
    expect(heatLevel(5, [])).toBe(1);
    expect(heatLevel(5, [0, Number.NaN])).toBe(1);
    expect(heatLevel(0, [])).toBe(0);
  });
});

describe("heatGrid", () => {
  it("空输入不出格子", () => {
    expect(heatGrid([], LEVELS)).toEqual([]);
  });

  it("首列按起始日的星期补前导空格（2026-09-20 是周日 → 不补）", () => {
    const grid = heatGrid([{ date: "2026-09-20", value: 207.25 }], LEVELS);
    expect(grid).toHaveLength(1);
    expect(grid[0]).toEqual({ date: "2026-09-20", value: 207.25, level: 2 });
  });

  it("起始日是周二时补两格，总长 = 前导空格 + 天数", () => {
    const days = [
      { date: "2026-09-15", value: 207.250215128 },
      { date: "2026-09-16", value: 0 },
      { date: "2026-09-17", value: 0 },
    ];
    const grid = heatGrid(days, LEVELS);
    expect(grid).toHaveLength(5);
    expect(grid.slice(0, 2)).toEqual([null, null]);
    expect(grid[2]).toEqual({ date: "2026-09-15", value: 207.250215128, level: 2 });
    expect(grid[3]?.level).toBe(0);
  });
});
