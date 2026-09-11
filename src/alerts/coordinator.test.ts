import { describe, expect, it, vi } from "vitest";
import { AlertCoordinator } from "./coordinator";
import type { AlertFire } from "./evaluate";
import { evaluateRules } from "./evaluate";
import { renderTemplate } from "../i18n/apply-params";
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
    expect(fire.params.note).toBe("个人号");
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

  it("错误快照冻结：不触发也不解除，恢复后不重复通知（ADR-0023）", () => {
    const now = { value: 0 };
    const notify = vi.fn();
    const onActiveChange = vi.fn();
    const coordinator = new AlertCoordinator({ now: () => now.value, notify, onActiveChange });
    const errorSnapshot: ProviderSnapshot = {
      ...deepseekSnapshot(0),
      status: "error",
      lines: [],
    };

    coordinator.observe(instance(), deepseekSnapshot(10), true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);

    // 错误快照：告警态原样保持（不解除），边沿不被重置
    coordinator.observe(instance(), errorSnapshot, true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);

    // 恢复后仍是同一条越阈边沿（triggered 未被错误快照清除）：不重复通知
    now.value = HOUR;
    coordinator.observe(instance(), deepseekSnapshot(20), true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);
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

describe("evaluateRules 文案模板（ADR-0022）", () => {
  it("标题是模板 + 参数；经 renderTemplate 渲染后与旧版成品文案一致", () => {
    const snapshot = deepseekSnapshot(10);
    const plain = evaluateRules(instance(), snapshot)[0]!;
    expect(plain.title).toBe("{provider} {rule}");
    expect(plain.params.rule).toBe("余额告警");
    expect(renderTemplate(plain.title, plain.params, (s) => s)).toBe("DeepSeek 余额告警");

    const noted = evaluateRules(instance({ note: "公司主账号" }), snapshot)[0]!;
    expect(noted.title).toBe("{note}（{provider}）{rule}");
    expect(renderTemplate(noted.title, noted.params, (s) => s)).toBe("公司主账号（DeepSeek）余额告警");
  });

  it("正文与数值走模板参数，渲染后还原语义", () => {
    const fire = evaluateRules(instance(), deepseekSnapshot(10))[0]!;
    expect(fire.body).toBe("当前余额 {balance} 元，已低于 {threshold} 元，请及时充值。");
    expect(fire.params.balance).toBe("10.00");
    expect(fire.params.threshold).toBe(50);
    expect(renderTemplate(fire.body, fire.params, (s) => s)).toContain("10.00");
  });

  it("translate 依赖只烘焙动态窗口名（撞满列表），框架文案保持模板", () => {
    const snapshot: ProviderSnapshot = {
      instanceId: "glm",
      providerId: "glm",
      providerName: "智谱 GLM",
      status: "ok",
      updatedAt: 0,
      lines: [
        {
          type: "progress",
          label: "{hours} 小时请求配额",
          params: { hours: 5 },
          percentUsed: 100,
        },
      ],
    };
    const inst = instance({ id: "glm", providerId: "glm", threshold: 80 });
    // GLM 100% 会同时产出 quota 与 exhausted，撞满列表在后者
    const fire = evaluateRules(inst, snapshot, (text) =>
      text === "{hours} 小时请求配额" ? "{hours}-hour request quota" : text,
    ).find((candidate) => candidate.ruleKey === "glm:exhausted")!;
    expect(fire.params.names).toBe("「5-hour request quota」");
    expect(fire.body).toBe("{names}已用尽（100%），等待重置恢复。");
  });
});

describe("AlertCoordinator.prune（ADR-0022）", () => {
  it("删除实例后清理其全部规则的边沿与实例告警态", () => {
    const notify = vi.fn();
    const onActiveChange = vi.fn();
    const coordinator = new AlertCoordinator({ notify, onActiveChange });

    coordinator.observe(instance(), deepseekSnapshot(10), true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", true);

    coordinator.prune("deepseek");

    // 边沿状态已清：同样的越阈快照重新评估会再次触发（实例已删，这是新生命的首次越阈）
    coordinator.observe(instance(), deepseekSnapshot(10), true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("prune 不影响其他实例的状态", () => {
    const notify = vi.fn();
    const onActiveChange = vi.fn();
    const coordinator = new AlertCoordinator({ notify, onActiveChange });
    const other = instance({ id: "other" });

    coordinator.observe(instance(), deepseekSnapshot(10), true);
    coordinator.observe(other, deepseekSnapshot(10), true);
    expect(notify).toHaveBeenCalledTimes(2);

    // 只清 other：deepseek 的已触发边沿保留，恢复后不再重复通知
    coordinator.prune("other");
    expect(onActiveChange).toHaveBeenLastCalledWith("other", true);
    coordinator.observe(instance(), deepseekSnapshot(100), true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(onActiveChange).toHaveBeenLastCalledWith("deepseek", false);
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
    expect(fires[1]!.params.balance).toBe("2.00");
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

describe("额度耗尽规则（ADR-0021）", () => {
  const windowed = (
    providerId: "glm" | "opencode-go",
    lines: ProviderSnapshot["lines"],
  ): { inst: ProviderInstance; snapshot: ProviderSnapshot } => ({
    inst: instance({ id: providerId, providerId, threshold: 80 }),
    snapshot: {
      instanceId: providerId,
      providerId,
      providerName: providerId === "glm" ? "智谱 GLM" : "OpenCode Go",
      status: "ok",
      updatedAt: 0,
      lines,
    },
  });

  it("盲区场景：预算窗（月 40%）远低于阈值、5h 窗撞满，仍产生耗尽告警", () => {
    const { inst, snapshot } = windowed("opencode-go", [
      { type: "progress", label: "本月额度", percentUsed: 40, resetsAt: "2026-09-30T00:00:00Z" },
      { type: "progress", label: "本周额度", percentUsed: 95, resetsAt: "2026-09-14T00:00:00Z" },
      { type: "progress", label: "5 小时请求配额", percentUsed: 100 },
    ]);
    const fires = evaluateRules(inst, snapshot);
    // 主指标 = 重置最远窗（月 40）< 阈值 80 → monthly 不触发；耗尽规则兜住撞满的 5h 窗
    expect(fires.map((fire) => fire.ruleKey)).toEqual(["opencode-go:exhausted"]);
    expect(fires[0]!.params.names).toContain("5 小时请求配额");
  });

  it("多窗同时撞满时全部列名；阈值告警与耗尽告警互不替代", () => {
    const { inst, snapshot } = windowed("glm", [
      { type: "progress", label: "每周请求配额", percentUsed: 100, resetsAt: "2026-09-14T00:00:00Z" },
      { type: "progress", label: "{hours} 小时请求配额", percentUsed: 100, params: { hours: 5 } },
    ]);
    const fires = evaluateRules(inst, snapshot);
    expect(fires.map((fire) => fire.ruleKey)).toEqual(["glm:quota", "glm:exhausted"]);
    expect(renderTemplate(fires[1]!.title, fires[1]!.params, (s) => s)).toBe("智谱 GLM 额度耗尽");
    expect(fires[1]!.params.names).toContain("「每周请求配额」");
    expect(fires[1]!.params.names).toContain("「5 小时请求配额」");
  });

  it("无窗口达到 100% 时不产生耗尽 fire", () => {
    const { inst, snapshot } = windowed("glm", [
      { type: "progress", label: "每周请求配额", percentUsed: 50 },
    ]);
    expect(evaluateRules(inst, snapshot)).toEqual([]);
  });
});
