import { describe, expect, it, vi } from "vitest";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";
import { buildTrayCandidates } from "./use-tray-sync";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

const translate = (text: string): string => text;

function instance(id = "glm"): ProviderInstance {
  return {
    id,
    providerId: "glm",
    note: "",
    sortOrder: 0,
    pinned: false,
    autoRefresh: true,
    threshold: null,
    balanceThreshold: null,
    createdAt: 1,
  };
}

function progress(label: string, percentUsed: number, resetsAt?: string) {
  return {
    type: "progress" as const,
    label,
    percentUsed,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function snapshot(inst: ProviderInstance, lines: ProviderSnapshot["lines"]): ProviderSnapshot {
  return {
    instanceId: inst.id,
    providerId: inst.providerId,
    providerName: "GLM",
    status: "ok",
    updatedAt: Date.now(),
    lines,
  };
}

function build(lines: ProviderSnapshot["lines"]) {
  const inst = instance();
  return buildTrayCandidates([inst], [snapshot(inst, lines)], translate)[0];
}

describe("buildTrayCandidates 窗口排序（ADR-0016）", () => {
  it("缺失 resetsAt 的窗口排在有重置时刻的窗口之后（GLM 滚动窗保底下条）", () => {
    const fiveHour = progress("{hours} 小时请求配额", 100); // 无 nextResetTime → unknown
    const weekly = progress("每周请求配额", 60, "2026-09-13T00:00:00.000Z");
    const candidate = build([fiveHour, weekly]);
    expect(candidate.windows.map((w) => w.label)).toEqual([
      "每周请求配额",
      "{hours} 小时请求配额",
    ]);
    // 柱渲染对按同一窗口顺序：known(周窗) 在上、unknown(5h) 在下
    expect(candidate.barWindows.map((w) => w.label)).toEqual([
      "每周请求配额",
      "{hours} 小时请求配额",
    ]);
    expect(candidate.barWindows[1].percent).toBe(100);
  });

  it("带 resetsAt 的窗口之间按重置近→远排序，与快照顺序无关", () => {
    const far = progress("月窗口", 30, "2026-10-01T00:00:00.000Z");
    const near = progress("周窗口", 80, "2026-09-07T00:00:00.000Z");
    const candidate = build([far, near]);
    expect(candidate.windows.map((w) => w.label)).toEqual(["周窗口", "月窗口"]);
    expect(candidate.barWindows[0].label).toBe("周窗口");
  });

  it("全无 resetsAt 时保持快照相对顺序（稳定排序兜底）", () => {
    const first = progress("第一窗", 90);
    const second = progress("第二窗", 10);
    const candidate = build([first, second]);
    expect(candidate.windows.map((w) => w.label)).toEqual(["第一窗", "第二窗"]);
    expect(candidate.barWindows.map((w) => w.label)).toEqual(["第一窗", "第二窗"]);
  });
});
