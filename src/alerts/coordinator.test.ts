import { describe, expect, it, vi } from "vitest";
import { AlertCoordinator } from "./coordinator";
import type { AlertFire } from "./evaluate";
import type { AppSettings, ProviderSnapshot } from "../types/ipc";
import { extractMetric } from "../stats/snapshot-history";

const HOUR = 3_600_000;

const settings = (alertsEnabled = true): AppSettings => ({
  refreshEnabled: true,
  refreshIntervalMinutes: 5,
  providers: {},
  alertsEnabled,
  alertThresholds: { deepseekBalanceBelowCny: 50, opencodeMonthlyUsedPercent: 80, glmQuotaUsedPercent: 80 },
  quickPanelShortcut: "Alt+KeyU",
  quickAutoHide: true,
  interfaceLanguage: "auto",
});

const deepseekSnapshot = (balance: number): ProviderSnapshot => ({
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

    coordinator.observe("deepseek", deepseekSnapshot(100), settings());
    expect(notify).not.toHaveBeenCalled();

    now.value = HOUR;
    coordinator.observe("deepseek", deepseekSnapshot(30), settings());
    expect(notify).toHaveBeenCalledTimes(1);
    const fire = notify.mock.calls[0][0] as AlertFire;
    expect(fire.ruleKey).toBe("deepseek:balance");
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);

    now.value = 2 * HOUR;
    coordinator.observe("deepseek", deepseekSnapshot(20), settings());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("冷却期内恢复再触发不通知；超过冷却期再次越线才重新通知", () => {
    const now = { value: 0 };
    const notify = vi.fn();
    const coordinator = new AlertCoordinator({ now: () => now.value, notify, onActiveChange: vi.fn() });

    now.value = 0;
    coordinator.observe("deepseek", deepseekSnapshot(10), settings());
    expect(notify).toHaveBeenCalledTimes(1);

    now.value = HOUR;
    coordinator.observe("deepseek", deepseekSnapshot(100), settings()); // 恢复
    now.value = 2 * HOUR;
    coordinator.observe("deepseek", deepseekSnapshot(10), settings()); // 冷却期内再触发
    expect(notify).toHaveBeenCalledTimes(1);

    now.value = 7 * HOUR;
    coordinator.observe("deepseek", deepseekSnapshot(100), settings());
    now.value = 8 * HOUR;
    coordinator.observe("deepseek", deepseekSnapshot(10), settings());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("恢复到阈值以上解除告警态；总开关关闭时清空告警态", () => {
    const now = { value: 0 };
    const onActiveChange = vi.fn();
    const coordinator = new AlertCoordinator({ now: () => now.value, notify: vi.fn(), onActiveChange });

    coordinator.observe("deepseek", deepseekSnapshot(10), settings());
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);

    coordinator.observe("deepseek", deepseekSnapshot(100), settings());
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", false);

    coordinator.observe("deepseek", deepseekSnapshot(10), settings());
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);
    coordinator.observe("deepseek", deepseekSnapshot(10), settings(false));
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", false);
  });

  it("OpenCode 本月额度达到阈值触发", () => {
    const notify = vi.fn();
    const coordinator = new AlertCoordinator({ notify, onActiveChange: vi.fn() });
    const snapshot: ProviderSnapshot = {
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      status: "ok",
      updatedAt: 0,
      lines: [{ type: "progress", label: "本月额度", percentUsed: 85, resetsAt: "2026-09-30T00:00:00Z" }],
    };
    coordinator.observe("opencode-go", snapshot, settings());
    expect(notify).toHaveBeenCalledTimes(1);
    const fire = notify.mock.calls[0][0] as AlertFire;
    expect(extractFrom(snapshot).value).toBe(85);
    expect(fire.ruleKey).toBe("opencode-go:monthly");
  });
});
