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

function progress(
  label: string,
  percentUsed: number,
  resetsAt?: string,
  windowPeriodMs?: number,
) {
  return {
    type: "progress" as const,
    label,
    percentUsed,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowPeriodMs != null ? { windowPeriodMs } : {}),
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

describe("ringWindows 环层序（ADR-0017：周期短→长，取最紧三扇）", () => {
  const HOUR_MS = 3_600_000;
  const DAY_MS = 86_400_000;

  it("三窗按周期短→长排层位（外=5h 短窗、内=月长窗），resetsAt 缺失与快照顺序均不影响层序", () => {
    // GLM 5h 滚动窗：无 nextResetTime（resetsAt 缺失），快照中排第一
    const fiveHour = progress("{hours} 小时请求配额", 10, undefined, 5 * HOUR_MS);
    const weekly = progress("每周请求配额", 60, "2026-09-13T00:00:00.000Z", 7 * DAY_MS);
    const monthly = progress("MCP 月度用量", 30, "2026-10-01T00:00:00.000Z", 30 * DAY_MS);
    const candidate = build([fiveHour, weekly, monthly]);
    // windows（tooltip/柱序）仍是 resetsAt 近→远：周 → 月 → 5h（缺失排后）
    expect(candidate.windows.map((w) => w.label)).toEqual([
      "每周请求配额",
      "MCP 月度用量",
      "{hours} 小时请求配额",
    ]);
    // 环层序独立于 resetsAt 口径：外环 5h → 中环周 → 内环月
    expect(candidate.ringWindows.map((w) => w.label)).toEqual([
      "{hours} 小时请求配额",
      "每周请求配额",
      "MCP 月度用量",
    ]);
  });

  it("超三层取最紧三扇（已用%降序），层内仍按周期短→长排位", () => {
    const loose5h = progress("5h 窗", 1, undefined, 5 * HOUR_MS); // 不在最紧三扇内
    const tightWeekly = progress("周窗", 90, "2026-09-13T00:00:00.000Z", 7 * DAY_MS);
    const tightMonthly = progress("月窗", 80, "2026-10-01T00:00:00.000Z", 30 * DAY_MS);
    const tight5h = progress("5h 窗2", 70, undefined, 5 * HOUR_MS);
    const candidate = build([loose5h, tightWeekly, tightMonthly, tight5h]);
    expect(candidate.ringWindows.map((w) => w.label)).toEqual([
      "5h 窗2", // 70%，周期最短 → 外环
      "周窗", // 90%，周期居中
      "月窗", // 80%，周期最长 → 内环
    ]);
  });

  it("全无周期字段时层内保持快照相对顺序（稳定排序兜底）", () => {
    const first = progress("第一窗", 40, "2026-09-10T00:00:00.000Z");
    const second = progress("第二窗", 20, "2026-09-20T00:00:00.000Z");
    const candidate = build([first, second]);
    expect(candidate.ringWindows.map((w) => w.label)).toEqual(["第一窗", "第二窗"]);
  });

  it("周期缺失的扇排在已知周期扇之后，已知扇之间按周期短→长", () => {
    const unknown = progress("未知周期窗", 10);
    const weekly = progress("周窗", 20, "2026-09-13T00:00:00.000Z", 7 * DAY_MS);
    const fiveHour = progress("5h 窗", 30, undefined, 5 * HOUR_MS);
    const candidate = build([unknown, weekly, fiveHour]);
    expect(candidate.ringWindows.map((w) => w.label)).toEqual([
      "5h 窗",
      "周窗",
      "未知周期窗",
    ]);
  });
});
