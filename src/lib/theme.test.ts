import { describe, expect, it } from "vitest";
import { nextThemeMode } from "./theme";

describe("nextThemeMode", () => {
  it("按 跟随系统 → 浅色 → 深色 → 跟随系统 循环", () => {
    expect(nextThemeMode("system")).toBe("light");
    expect(nextThemeMode("light")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("system");
  });
});
