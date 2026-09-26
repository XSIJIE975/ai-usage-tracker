import { describe, expect, it, vi } from "vitest";
import { CheckinDetector, type CheckinArrival } from "./checkin-detector";
import type { ProviderInstance, ProviderSnapshot, StoredWorkbuddyCheckin } from "../types/ipc";

const instance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "wb-1",
  providerId: "workbuddy",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
  balanceThreshold: null,
  site: "china",
  createdAt: 0,
  ...overrides,
});

const snapshot = (checkin?: { date: string; credited: number }): ProviderSnapshot => ({
  instanceId: "wb-1",
  providerId: "workbuddy",
  providerName: "腾讯 WorkBuddy / CodeBuddy",
  status: "ok",
  updatedAt: 0,
  lines: [],
  ...(checkin ? { checkin } : {}),
});

const setup = (hydrated: StoredWorkbuddyCheckin[] = []) => {
  const notify = vi.fn();
  const onStateChange = vi.fn();
  const detector = new CheckinDetector({ notify, onStateChange });
  detector.hydrate(hydrated);
  return { detector, notify, onStateChange };
};

describe("CheckinDetector", () => {
  it("快照无签到字段时不表态（含错误快照）", () => {
    const { detector, notify, onStateChange } = setup();
    detector.observe(instance(), snapshot(undefined));
    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("首次签到发通知，落库判重日期", () => {
    const { detector, notify, onStateChange } = setup();
    detector.observe(instance({ note: "主账号" }), snapshot({ date: "2026-09-20", credited: 30 }));
    expect(notify).toHaveBeenCalledTimes(1);
    const arrival = notify.mock.calls[0][0] as CheckinArrival;
    expect(arrival.instanceId).toBe("wb-1");
    expect(arrival.title).toBe("{note}（{provider}）{rule}");
    expect(arrival.params).toMatchObject({ note: "主账号", rule: "签到成功", credit: 30 });
    expect(arrival.body).toBe("积分 +{credit} 已到账");
    expect(onStateChange).toHaveBeenCalledWith({ instance_id: "wb-1", notified_date: "2026-09-20" });
  });

  it("同一天的快照重放（reevaluate/重启后重读落库快照）不重复通知", () => {
    const { detector, notify } = setup();
    const snap = snapshot({ date: "2026-09-20", credited: 30 });
    detector.observe(instance(), snap);
    detector.observe(instance(), snap);
    detector.observe(instance(), snapshot({ date: "2026-09-20", credited: 30 }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("跨天的新签到再次通知（判重按日期，不是一次性）", () => {
    const { detector, notify } = setup();
    detector.observe(instance(), snapshot({ date: "2026-09-20", credited: 30 }));
    detector.observe(instance(), snapshot({ date: "2026-09-21", credited: 20 }));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("水合后同一天的旧快照重放被抑制——重启不重报", () => {
    const { detector, notify } = setup([{ instance_id: "wb-1", notified_date: "2026-09-20" }]);
    detector.observe(instance(), snapshot({ date: "2026-09-20", credited: 30 }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("水合的是昨天的日期：今天的签到照常通知", () => {
    const { detector, notify } = setup([{ instance_id: "wb-1", notified_date: "2026-09-19" }]);
    detector.observe(instance(), snapshot({ date: "2026-09-20", credited: 30 }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("prune 清理投影：删实例重建后同一天可重新通知", () => {
    const { detector, notify } = setup();
    detector.observe(instance(), snapshot({ date: "2026-09-20", credited: 30 }));
    expect(notify).toHaveBeenCalledTimes(1);
    detector.prune("wb-1");
    detector.observe(instance(), snapshot({ date: "2026-09-20", credited: 30 }));
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
