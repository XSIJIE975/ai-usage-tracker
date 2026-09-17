import { describe, expect, it } from "vitest";
import { legendLabelMaxWidth } from "./ChartLegend";

describe("legendLabelMaxWidth", () => {
  it("gives few items a large budget so long names show in full", () => {
    // 2026-09-17 用户实测：系统健康度仅两个图例，写死 160px 把放得下的长名截断
    expect(legendLabelMaxWidth(1300, 2)).toBe(610);
    expect(legendLabelMaxWidth(400, 1)).toBe(360);
  });

  it("falls back to the 160px compact cap when items are many", () => {
    expect(legendLabelMaxWidth(800, 6)).toBe(160);
    expect(legendLabelMaxWidth(300, 8)).toBe(160);
  });

  it("returns the compact cap before the container has been measured", () => {
    expect(legendLabelMaxWidth(0, 2)).toBe(160);
    expect(legendLabelMaxWidth(-1, 2)).toBe(160);
    expect(legendLabelMaxWidth(800, 0)).toBe(160);
  });
});
