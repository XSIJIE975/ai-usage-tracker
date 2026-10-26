import { describe, expect, it } from "vitest";

import { compareVersions } from "./version";

describe("compareVersions", () => {
  it("按三段逐位比较", () => {
    expect(compareVersions("0.15.0", "0.14.0")).toBeGreaterThan(0);
    expect(compareVersions("0.14.0", "0.15.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.14.1", "0.14.0")).toBeGreaterThan(0);
  });

  it("相等与缺段补零", () => {
    expect(compareVersions("0.14.0", "0.14.0")).toBe(0);
    expect(compareVersions("0.14", "0.14.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("忽略 v 前缀与首尾空白", () => {
    expect(compareVersions("v0.15.0", "0.14.9")).toBeGreaterThan(0);
    expect(compareVersions(" 0.14.0 ", "0.14.0")).toBe(0);
  });

  it("非数字段按 0 处理而不是报错", () => {
    expect(compareVersions("0.14.x", "0.14.0")).toBe(0);
    expect(compareVersions("0.15.beta", "0.14.9")).toBeGreaterThan(0);
  });
});
