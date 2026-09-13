import { describe, expect, it } from "vitest";
import { snappedEdge } from "./anchor-edge";

const work = { x: 0, y: 25, width: 2560, height: 1415 };

describe("snappedEdge 贴边嗅探（ADR-0027）", () => {
  it("贴工作区顶边 → top（macOS 菜单栏 / Windows 顶部任务栏）", () => {
    expect(snappedEdge({ x: 1052, y: 33, width: 320, height: 420 }, work)).toBe("top");
  });

  it("贴工作区底边 → bottom（底部任务栏，含 Win11 flyout 回退右下角）", () => {
    expect(snappedEdge({ x: 2232, y: 1020, width: 320, height: 420 }, work)).toBe("bottom");
  });

  it("左右状态栏 / 窗口被移动过 → null（只改尺寸不动坐标）", () => {
    expect(snappedEdge({ x: 400, y: 300, width: 320, height: 420 }, work)).toBeNull();
  });

  it("阈值内仍算贴边，阈值外不算", () => {
    expect(snappedEdge({ x: 0, y: 49, width: 320, height: 400 }, work)).toBe("top");
    expect(snappedEdge({ x: 0, y: 50, width: 320, height: 400 }, work)).toBeNull();
  });

  it("工作区过矮上下同贴 → top（与越界钳制方向一致）", () => {
    const tiny = { x: 0, y: 0, width: 800, height: 600 };
    expect(snappedEdge({ x: 0, y: 8, width: 320, height: 584 }, tiny)).toBe("top");
  });
});
