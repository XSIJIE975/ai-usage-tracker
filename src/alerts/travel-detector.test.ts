import { describe, expect, it } from "vitest";
import type { ProviderInstance, ProviderSnapshot, StoredWorkbuddyTravelClaim } from "../types/ipc";
import { TravelDetector, type TravelArrival } from "./travel-detector";

const makeInstance = (id = "wb-1"): ProviderInstance => ({
  id,
  providerId: "workbuddy",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
  balanceThreshold: null,
  createdAt: 0,
});

const makeSnapshot = (travel?: { tripKey: string; credited: number }): ProviderSnapshot => ({
  instanceId: "wb-1",
  providerId: "workbuddy",
  providerName: "腾讯 WorkBuddy / CodeBuddy",
  status: "ok",
  updatedAt: 0,
  lines: [],
  ...(travel ? { travel } : {}),
});

/** 捕获 notify / onStateChange 的检测器，便于逐条断言 */
const makeDetector = () => {
  const notifications: TravelArrival[] = [];
  const saved: StoredWorkbuddyTravelClaim[] = [];
  const detector = new TravelDetector({
    notify: (arrival) => notifications.push(arrival),
    onStateChange: (record) => saved.push(record),
  });
  return { detector, notifications, saved };
};

describe("TravelDetector", () => {
  it("首条领奖通知：body 带到账积分，回写行程键", () => {
    const { detector, notifications, saved } = makeDetector();
    detector.observe(makeInstance(), makeSnapshot({ tripKey: "1789370635", credited: 9 }));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toBe("旅行积分 +{credit} 已到账");
    expect(notifications[0].params).toMatchObject({ credit: 9 });
    expect(saved).toEqual([{ instance_id: "wb-1", claimed_key: "1789370635" }]);
  });

  it("同一行程的快照重放（重启后 reevaluate）不重复通知", () => {
    const { detector, notifications, saved } = makeDetector();
    const snapshot = makeSnapshot({ tripKey: "1789370635", credited: 9 });
    detector.observe(makeInstance(), snapshot);
    detector.observe(makeInstance(), snapshot);
    expect(notifications).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });

  it("新行程（不同 tripKey）再次通知——一天多趟旅行各判各的", () => {
    const { detector, notifications, saved } = makeDetector();
    detector.observe(makeInstance(), makeSnapshot({ tripKey: "1789370635", credited: 9 }));
    detector.observe(makeInstance(), makeSnapshot({ tripKey: "1789957341", credited: 8 }));
    expect(notifications).toHaveLength(2);
    expect(saved).toHaveLength(2);
    expect(saved[1].claimed_key).toBe("1789957341");
  });

  it("credit=0（响应缺到账数）照发通知，body 不带数量占位", () => {
    const { detector, notifications } = makeDetector();
    detector.observe(makeInstance(), makeSnapshot({ tripKey: "1789370635", credited: 0 }));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toBe("旅行积分已到账");
    expect(notifications[0].params.credit).toBeUndefined();
  });

  it("hydrate 播种后同行程的重放直接跳过（后端事实源恢复）", () => {
    const { detector, notifications } = makeDetector();
    detector.hydrate([{ instance_id: "wb-1", claimed_key: "1789370635" }]);
    detector.observe(makeInstance(), makeSnapshot({ tripKey: "1789370635", credited: 9 }));
    expect(notifications).toHaveLength(0);
    // 未播种过的实例照常通知
    detector.observe(makeInstance("wb-2"), makeSnapshot({ tripKey: "1789370635", credited: 9 }));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].instanceId).toBe("wb-2");
  });

  it("无 travel 字段的快照不触发（取数失败/本轮没领奖）", () => {
    const { detector, notifications } = makeDetector();
    detector.observe(makeInstance(), makeSnapshot(undefined));
    expect(notifications).toHaveLength(0);
  });

  it("prune 清理投影：删除实例后重建同 id 实例不继承旧行程键", () => {
    const { detector, notifications } = makeDetector();
    detector.observe(makeInstance(), makeSnapshot({ tripKey: "1789370635", credited: 9 }));
    detector.prune("wb-1");
    detector.observe(makeInstance(), makeSnapshot({ tripKey: "1789370635", credited: 9 }));
    expect(notifications).toHaveLength(2);
  });
});
