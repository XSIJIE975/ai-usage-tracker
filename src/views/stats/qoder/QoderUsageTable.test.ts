import { describe, expect, it } from "vitest";
import { discountLabel } from "./QoderUsageTable";

describe("discountLabel", () => {
  it("官网给的是乘数，界面说「几折」", () => {
    expect(discountLabel(0.5)).toBe("5 折");
    expect(discountLabel(0.2)).toBe("2 折");
    expect(discountLabel(0.1)).toBe("1 折");
    expect(discountLabel(0.4)).toBe("4 折");
  });

  it("非整数的十分位保留一位，不打折与脏值不显示", () => {
    expect(discountLabel(0.85)).toBe("8.5 折");
    expect(discountLabel(1)).toBeNull();
    expect(discountLabel(0)).toBeNull();
    expect(discountLabel(Number.NaN)).toBeNull();
  });
});
