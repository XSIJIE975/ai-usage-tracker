import { describe, expect, it, vi } from "vitest";
import { AlertCoordinator } from "./coordinator";
import type { AlertFire } from "./evaluate";
import { evaluateRules } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";
import { extractMetric } from "./metric";

const HOUR = 3_600_000;

const instance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "deepseek",
  providerId: "deepseek",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: 50,
  balanceThreshold: null,
  createdAt: 0,
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

describe("evaluateRules 标题", () => {
  it("备注为空时标题与旧版一致；有备注时带备注与供应商名", () => {
    const snapshot = deepseekSnapshot(10);
    const plain = evaluateRules(instance(), snapshot)[0]!;
    expect(plain.title).toBe("DeepSeek 余额告警");

    const noted = evaluateRules(instance({ note: "公司主账号" }), snapshot)[0]!;
    expect(noted.title).toBe("公司主账号（DeepSeek）余额告警");
  });
});

describe("GLM 配额与余额双规则", () => {
  const glmInstance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
    ...instance({ id: "glm-1", providerId: "glm", threshold: 80, balanceThreshold: null }),
    ...overrides,
  });
  /** GLM 快照：周配额 progress 行 + 账户余额 text 行（与真实快照结构一致） */
  const glmSnapshot = (quotaPercent: number, balance: number | null): ProviderSnapshot => ({
    instanceId: "glm-1",
    providerId: "glm",
    providerName: "智谱 GLM",
    status: "ok",
    updatedAt: 0,
    lines: [
      { type: "badge", label: "套餐档位", value: "Lite" },
      { type: "progress", label: "每周请求配额", percentUsed: quotaPercent, resetsAt: "2026-09-08T00:00:00Z" },
      ...(balance !== null
        ? [{ type: "text" as const, label: "账户余额", value: `¥${balance.toFixed(2)}` }]
        : []),
    ],
  });

  it("配额与余额同时越线时产生两条独立 fire", () => {
    const fires = evaluateRules(glmInstance({ threshold: 80, balanceThreshold: 5 }), glmSnapshot(90, 2));
    expect(fires.map((fire) => fire.ruleKey)).toEqual(["glm-1:quota", "glm-1:balance"]);
    expect(fires[1]!.body).toContain("2.00");
  });

  it("只越余额线时仅产生余额 fire；主指标仍是配额百分比", () => {
    const fires = evaluateRules(glmInstance({ threshold: 80, balanceThreshold: 5 }), glmSnapshot(50, 2));
    expect(fires.map((fire) => fire.ruleKey)).toEqual(["glm-1:balance"]);
  });

  it("未设余额阈值时不产生余额 fire", () => {
    const fires = evaluateRules(glmInstance(), glmSnapshot(50, 1));
    expect(fires).toEqual([]);
  });

  it("余额行缺失（查询失败降级）时不产生余额 fire，配额规则不受影响", () => {
    const fires = evaluateRules(glmInstance({ balanceThreshold: 5 }), glmSnapshot(90, null));
    expect(fires.map((fire) => fire.ruleKey)).toEqual(["glm-1:quota"]);
  });

  it("协调器对两条规则的边沿与冷却互相独立", () => {
    const now = { value: 0 };
    const notify = vi.fn();
    const onActiveChange = vi.fn();
    const coordinator = new AlertCoordinator({ now: () => now.value, notify, onActiveChange });
    const glm = glmInstance({ threshold: 80, balanceThreshold: 5 });

    // 仅余额越线
    coordinator.observe(glm, glmSnapshot(50, 2), true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].ruleKey).toBe("glm-1:balance");
    expect(onActiveChange).toHaveBeenLastCalledWith("glm-1", true);

    // 配额随后越线：余额规则在冷却+已触发态不重复通知，配额规则首次通知
    now.value = HOUR;
    coordinator.observe(glm, glmSnapshot(90, 2), true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0].ruleKey).toBe("glm-1:quota");
    expect(onActiveChange).toHaveBeenLastCalledWith("glm-1", true);

    // 余额恢复：配额仍处告警态，实例告警态不变
    now.value = 2 * HOUR;
    coordinator.observe(glm, glmSnapshot(90, 20), true);
    expect(onActiveChange).not.toHaveBeenCalledWith("glm-1", false);

    // 配额也恢复：实例告警态解除
    now.value = 3 * HOUR;
    coordinator.observe(glm, glmSnapshot(50, 20), true);
    expect(onActiveChange).toHaveBeenLastCalledWith("glm-1", false);
  });
});
