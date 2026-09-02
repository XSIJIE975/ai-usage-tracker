import { describe, expect, it, vi } from "vitest";
import { AlertCoordinator } from "./coordinator";
import type { AlertFire } from "./evaluate";
import { evaluateRule } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";
import { extractMetric } from "../stats/snapshot-history";

const HOUR = 3_600_000;

const instance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "deepseek",
  providerId: "deepseek",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: 50,
  ...overrides,
});

const deepseekSnapshot = (balance: number): ProviderSnapshot => ({
  instanceId: "deepseek",
  providerId: "deepseek",
  providerName: "DeepSeek",
  status: "ok",
  updatedAt: 0,
  lines: [{ type: "text", label: "账户余额", value: `¥${balance.toFixed(2)}` }],
});

const extractFrom = (snapshot: ProviderSnapshot) => extractMetric(snapshot)!;

describe("AlertCoordinator", () => {
  it("越过阈值才通知一次；持续低于阈值不重复通知（边沿触发）", () => {
    const now = { value: 0 };
    const notify = vi.fn();
    const onActiveChange = vi.fn();
    const coordinator = new AlertCoordinator({
      now: () => now.value,
      notify,
      onActiveChange,
    });

    coordinator.observe(instance(), deepseekSnapshot(100), true);
    expect(notify).not.toHaveBeenCalled();

    now.value = HOUR;
    coordinator.observe(instance(), deepseekSnapshot(30), true);
    expect(notify).toHaveBeenCalledTimes(1);
    const fire = notify.mock.calls[0][0] as AlertFire;
    expect(fire.ruleKey).toBe("deepseek:balance");
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);

    now.value = 2 * HOUR;
    coordinator.observe(instance(), deepseekSnapshot(20), true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("同种类两个实例的边沿状态与冷却互相独立", () => {
    const now = { value: 0 };
    const notify = vi.fn();
    const coordinator = new AlertCoordinator({ now: () => now.value, notify, onActiveChange: vi.fn() });

    const main = instance();
    const personal = instance({ id: "uuid-personal", note: "个人号" });
    coordinator.observe(main, deepseekSnapshot(10), true);
    coordinator.observe(personal, deepseekSnapshot(100), true);
    expect(notify).toHaveBeenCalledTimes(1);

    now.value = HOUR;
    coordinator.observe(personal, deepseekSnapshot(5), true);
    expect(notify).toHaveBeenCalledTimes(2);
    const fire = notify.mock.calls[1][0] as AlertFire;
    expect(fire.instanceId).toBe("uuid-personal");
    expect(fire.title).toContain("个人号");
  });

  it("未设阈值的实例不告警", () => {
    const notify = vi.fn();
    const coordinator = new AlertCoordinator({ notify, onActiveChange: vi.fn() });

    coordinator.observe(instance({ threshold: null }), deepseekSnapshot(1), true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("冷却期内恢复再触发不通知；超过冷却期再次越线才重新通知", () => {
    const now = { value: 0 };
    const notify = vi.fn();
    const coordinator = new AlertCoordinator({ now: () => now.value, notify, onActiveChange: vi.fn() });

    now.value = 0;
    coordinator.observe(instance(), deepseekSnapshot(10), true);
    expect(notify).toHaveBeenCalledTimes(1);

    now.value = HOUR;
    coordinator.observe(instance(), deepseekSnapshot(100), true); // 恢复
    now.value = 2 * HOUR;
    coordinator.observe(instance(), deepseekSnapshot(10), true); // 冷却期内再触发
    expect(notify).toHaveBeenCalledTimes(1);

    now.value = 7 * HOUR;
    coordinator.observe(instance(), deepseekSnapshot(100), true);
    now.value = 8 * HOUR;
    coordinator.observe(instance(), deepseekSnapshot(10), true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("恢复到阈值以上解除告警态；总开关关闭时清空告警态", () => {
    const now = { value: 0 };
    const onActiveChange = vi.fn();
    const coordinator = new AlertCoordinator({ now: () => now.value, notify: vi.fn(), onActiveChange });

    coordinator.observe(instance(), deepseekSnapshot(10), true);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);

    coordinator.observe(instance(), deepseekSnapshot(100), true);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", false);

    coordinator.observe(instance(), deepseekSnapshot(10), true);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);
    coordinator.observe(instance(), deepseekSnapshot(10), false);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", false);
  });

  it("OpenCode 本月额度达到阈值触发", () => {
    const notify = vi.fn();
    const coordinator = new AlertCoordinator({ notify, onActiveChange: vi.fn() });
    const opencode = instance({ id: "opencode-go", providerId: "opencode-go", threshold: 80 });
    const snapshot: ProviderSnapshot = {
      instanceId: "opencode-go",
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      status: "ok",
      updatedAt: 0,
      lines: [{ type: "progress", label: "本月额度", percentUsed: 85, resetsAt: "2026-09-30T00:00:00Z" }],
    };
    coordinator.observe(opencode, snapshot, true);
    expect(notify).toHaveBeenCalledTimes(1);
    const fire = notify.mock.calls[0][0] as AlertFire;
    expect(extractFrom(snapshot).value).toBe(85);
    expect(fire.ruleKey).toBe("opencode-go:monthly");
  });
});

describe("evaluateRule 标题", () => {
  it("备注为空时标题与旧版一致；有备注时带备注与供应商名", () => {
    const snapshot = deepseekSnapshot(10);
    const plain = evaluateRule(instance(), snapshot)!;
    expect(plain.title).toBe("DeepSeek 余额告警");

    const noted = evaluateRule(instance({ note: "公司主账号" }), snapshot)!;
    expect(noted.title).toBe("公司主账号（DeepSeek）余额告警");
  });
});
