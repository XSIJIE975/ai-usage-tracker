import { describe, expect, it } from "vitest";
import { canonicalFromEvent, displayShortcut } from "./shortcut";

describe("displayShortcut", () => {
  it("修饰键与 Code 名转展示格式", () => {
    expect(displayShortcut("Alt+KeyU")).toBe("Alt + U");
    expect(displayShortcut("Control+Shift+Digit3")).toBe("Ctrl + Shift + 3");
    expect(displayShortcut("Super+KeyQ")).toBe("Win + Q");
  });

  it("功能键与其他键回退原名或映射符号", () => {
    expect(displayShortcut("Alt+F5")).toBe("Alt + F5");
    expect(displayShortcut("Ctrl+ArrowUp")).toBe("Ctrl + ↑");
  });

  it("空值显示未设置", () => {
    expect(displayShortcut("")).toBe("未设置");
  });
});

describe("canonicalFromEvent", () => {
  const base = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: "", code: "" };

  it("Alt+字母 → Alt+KeyU", () => {
    expect(canonicalFromEvent({ ...base, altKey: true, key: "u", code: "KeyU" })).toBe("Alt+KeyU");
  });

  it("Ctrl+Shift+数字 → Control+Shift+Digit3", () => {
    expect(
      canonicalFromEvent({ ...base, ctrlKey: true, shiftKey: true, key: "3", code: "Digit3" }),
    ).toBe("Control+Shift+Digit3");
  });

  it("仅修饰键或无修饰键返回 null", () => {
    expect(canonicalFromEvent({ ...base, altKey: true, key: "Alt", code: "AltLeft" })).toBeNull();
    expect(canonicalFromEvent({ ...base, key: "u", code: "KeyU" })).toBeNull();
  });
});
