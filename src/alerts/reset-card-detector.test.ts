import { describe, expect, it, vi } from "vitest";
import { diffNewCardIds, ResetCardDetector } from "./reset-card-detector";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";

const instance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "glm-1",
  providerId: "glm",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: 80,
  balanceThreshold: null,
  site: "china",
  createdAt: 0,
  ...overrides,
});

const snapshot = (
  availableResetIds?: { fiveHour: number[]; week: number[] },
  overrides: Partial<ProviderSnapshot> = {},
): ProviderSnapshot => ({
  instanceId: "glm-1",
  providerId: "glm",
  providerName: "智谱 GLM",
  status: "ok",
  updatedAt: 0,
  lines: [],
  ...(availableResetIds ? { availableResetIds } : {}),
  ...overrides,
});

describe("diffNewCardIds", () => {
  it("只保留未见过的新 id，组内保持原顺序", () => {
    const seen = new Set([1, 2]);
    expect(diffNewCardIds(seen, { fiveHour: [2, 3, 4], week: [1, 5] })).toEqual({
      fiveHour: [3, 4],
      week: [5],
    });
  });
});

describe("ResetCardDetector", () => {
  it("首刷播种不通知：存量可用卡全部记为已见并回写", () => {
    const notify = vi.fn();
    const onStateChange = vi.fn();
    const detector = new ResetCardDetector({ notify, onStateChange });

    detector.observe(instance(), snapshot({ fiveHour: [1, 2], week: [3] }));
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledWith({
      instance_id: "glm-1",
      record_ids: [1, 2, 3],
      seeded: true,
    });

    // 播种后同一批卡再次出现：不通知、无变化不回写
    detector.observe(instance(), snapshot({ fiveHour: [1, 2], week: [3] }));
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it("新卡到账发一条合并通知，同一张卡不重复提醒", () => {
    const notify = vi.fn();
    const onStateChange = vi.fn();
    const detector = new ResetCardDetector({ notify, onStateChange });
    detector.observe(instance(), snapshot({ fiveHour: [1], week: [] }));

    detector.observe(instance(), snapshot({ fiveHour: [1, 2], week: [9] }));
    expect(notify).toHaveBeenCalledTimes(1);
    const arrival = notify.mock.calls[0][0];
    expect(arrival.instanceId).toBe("glm-1");
    expect(arrival.params).toMatchObject({ count: 2, fiveHour: 1, week: 1 });

    // 第三轮无新卡：不再通知
    detector.observe(instance(), snapshot({ fiveHour: [1, 2], week: [9] }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("卡被使用后（从可用集消失）不影响后续差集；id 复现也不重报", () => {
    const notify = vi.fn();
    const onStateChange = vi.fn();
    const detector = new ResetCardDetector({ notify, onStateChange });
    detector.observe(instance(), snapshot({ fiveHour: [1, 2], week: [] }));

    // 卡 2 被使用：无新卡，不通知、不回写（集合只增不减，无需收缩）
    detector.observe(instance(), snapshot({ fiveHour: [1], week: [] }));
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledTimes(1);

    // 即使 id 2 复现（服务端不复用已用卡 id，但接口闪动可能短暂置回 true），仍视为已见
    detector.observe(instance(), snapshot({ fiveHour: [1, 2], week: [] }));
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it("错误快照或缺 availableResetIds 时冻结：不播种、不判定", () => {
    const notify = vi.fn();
    const onStateChange = vi.fn();
    const detector = new ResetCardDetector({ notify, onStateChange });

    detector.observe(instance(), snapshot(undefined, { status: "error" }));
    detector.observe(instance(), snapshot(undefined));
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();

    // 冻结后恢复：仍未播种，首刷语义不变（播种不通知）
    detector.observe(instance(), snapshot({ fiveHour: [7], week: [] }));
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it("水合后同一张卡不再提醒（重启/F5 恢复）", () => {
    const notify = vi.fn();
    const onStateChange = vi.fn();
    const detector = new ResetCardDetector({ notify, onStateChange });
    detector.hydrate([
      { instance_id: "glm-1", record_ids: [1, 2], seeded: true },
      { instance_id: "glm-2", record_ids: [], seeded: true },
    ]);

    detector.observe(instance(), snapshot({ fiveHour: [1, 2], week: [] }));
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();

    // 播种过但 0 张的实例：新卡照常通知（无行与空集是两种状态）
    detector.observe(instance({ id: "glm-2" }), snapshot({ fiveHour: [], week: [5] }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("非智谱实例不参与检测", () => {
    const notify = vi.fn();
    const onStateChange = vi.fn();
    const detector = new ResetCardDetector({ notify, onStateChange });

    detector.observe(
      instance({ id: "ds", providerId: "deepseek" }),
      snapshot({ fiveHour: [1], week: [] }),
    );
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("删除实例后内存投影清空：重建实例重新播种不通知", () => {
    const notify = vi.fn();
    const detector = new ResetCardDetector({ notify, onStateChange: vi.fn() });
    detector.observe(instance(), snapshot({ fiveHour: [1], week: [] }));
    detector.prune("glm-1");
    detector.observe(instance(), snapshot({ fiveHour: [1], week: [] }));
    expect(notify).not.toHaveBeenCalled();
  });
});
