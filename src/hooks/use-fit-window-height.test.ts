import { describe, expect, it } from "vitest";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { clampPanelHeight } from "./use-fit-window-height";
import type { Monitor } from "@tauri-apps/api/window";

const MIN_HEIGHT = 240;

function monitor(scaleFactor: number, workHeight = 1040): Pick<Monitor, "workArea" | "scaleFactor"> {
  return {
    workArea: {
      position: new PhysicalPosition(0, 0),
      size: new PhysicalSize(1920, workHeight),
    },
    scaleFactor,
  };
}

describe("clampPanelHeight", () => {
  it("caps desired height at 80% of the monitor work area", () => {
    // workArea 1040 物理像素、scale 1 → 上限 832 逻辑像素
    expect(clampPanelHeight(2000, MIN_HEIGHT, monitor(1))).toBe(832);
  });

  it("converts the work area to logical pixels with the monitor scale", () => {
    // 回归线（ADR-0046）：换算必须用显示器 scale，不能用窗口缓存 scale——
    // 缓存偏高曾把 80% 上限放大到整个工作区、面板盖住系统任务栏
    // floor(1040 / 1.25 × 0.8) = 665
    expect(clampPanelHeight(2000, MIN_HEIGHT, monitor(1.25))).toBe(665);
  });

  it("keeps desired height when it is below the cap", () => {
    expect(clampPanelHeight(400, MIN_HEIGHT, monitor(1))).toBe(400);
  });

  it("never goes below minHeight", () => {
    expect(clampPanelHeight(10, MIN_HEIGHT, monitor(1))).toBe(MIN_HEIGHT);
  });

  it("treats a zero scale factor as 1", () => {
    expect(clampPanelHeight(2000, MIN_HEIGHT, monitor(0))).toBe(832);
  });

  it("does not cap when the monitor is unavailable", () => {
    // 显示器查询失败：退窗口缓存 scale 换算、无工作区上限，越界由 Rust 唤出硬上限兜底
    expect(clampPanelHeight(2000, MIN_HEIGHT, null)).toBe(2000);
    expect(clampPanelHeight(10, MIN_HEIGHT, null)).toBe(MIN_HEIGHT);
  });
});
