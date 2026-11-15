import { describe, expect, it } from "vitest";
import { islandOutlinePath } from "./shape";

/** 路径里没有弧线标志位等非坐标数字，按成对数字直接解析出采样点 */
function points(path: string): Array<[number, number]> {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const result: Array<[number, number]> = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    result.push([numbers[i], numbers[i + 1]]);
  }
  return result;
}

describe("islandOutlinePath", () => {
  it("表面轮廓左右对称、顶边最宽、底边收在高度上", () => {
    const width = 160;
    const height = 32;
    const d = islandOutlinePath(width, height, 12, 10, 16);

    expect(d.startsWith("M0 0")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);

    const sampled = points(d);
    const xs = sampled.map(([x]) => x);
    const ys = sampled.map(([, y]) => y);
    // 顶边（y=0）是轮廓最宽处：肩部让宽度向屏幕边缘张开，而不是圆角矩形
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(height);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(width);
    // 每个采样点都能在镜像位置找到对应点
    for (const [x] of sampled) {
      expect(xs.some((other) => Math.abs(other - (width - x)) < 0.02)).toBe(true);
    }
  });

  it("肩部在 flareHeight 内收敛到本体侧边，底部圆角与高度同心", () => {
    const d = islandOutlinePath(160, 32, 12, 10, 16);
    // 左肩终点 = 本体左侧边 (flare, flareHeight)；随后竖直下到圆角起点
    expect(d).toContain("L12 10");
    expect(d).toContain("L12 16");
  });

  it("描边路径内收 0.5px 且顶部敞开（屏幕边缘不画线）", () => {
    const rim = islandOutlinePath(160, 32, 12, 10, 16, { inset: 0.5, close: false });
    expect(rim.startsWith("M0.5 0")).toBe(true);
    expect(rim.endsWith("Z")).toBe(false);
    expect(rim.endsWith("L159.5 0")).toBe(true);
  });

  it("展开态轮廓使用面板级尺寸（456 × 284）", () => {
    const d = islandOutlinePath(456, 284, 16, 14, 22);
    expect(d.startsWith("M0 0")).toBe(true);
    expect(d).toContain("L16 262");
  });
});
