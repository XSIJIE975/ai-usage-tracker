import { describe, expect, it } from "vitest";
import type { MetricLine, ProviderInstance, ProviderSnapshot } from "../../types/ipc";
import { buildGlanceInstances } from "./data";

const translate = (text: string): string => text;

function instance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: "i-1",
    providerId: "qoder",
    note: "",
    sortOrder: 0,
    pinned: false,
    autoRefresh: true,
    threshold: null,
    balanceThreshold: null,
    site: "china",
    tokenAutoRenew: true,
    createdAt: 1,
    ...overrides,
  };
}

function build(inst: ProviderInstance, lines: MetricLine[]) {
  const snapshot: ProviderSnapshot = {
    instanceId: inst.id,
    providerId: inst.providerId,
    providerName: "Qoder",
    status: "ok",
    updatedAt: 0,
    lines,
  };
  return buildGlanceInstances([inst], [snapshot], {
    alertActive: {},
    refreshing: {},
    loading: false,
    translate,
    language: "zh",
  })[0];
}

describe("buildGlanceInstances 行模型", () => {
  it("Qoder 未分配积分：状态行进速览，没有进度行与余额行", () => {
    const item = build(instance(), [
      { type: "text", label: "积分额度", value: "未分配积分", status: true },
    ]);
    expect(item.tightestPercent).toBeNull();
    expect(item.lines).toEqual([{ kind: "status", label: "积分额度", value: "未分配积分" }]);
  });

  it("WorkBuddy 无套餐同一口径，状态行主语是积分额度", () => {
    const inst = instance({ providerId: "workbuddy" });
    const item = build(inst, [
      { type: "text", label: "积分额度", value: "暂无有效套餐", status: true },
    ]);
    expect(item.lines[0]).toMatchObject({
      kind: "status",
      label: "积分额度",
      value: "暂无有效套餐",
    });
  });

  it("WorkBuddy 进度 + 剩余积分 + 最近到期明细：三类行按快照顺序排列", () => {
    const inst = instance({ providerId: "workbuddy" });
    const item = build(inst, [
      { type: "progress", label: "积分额度", used: 2, limit: 100, percentUsed: 2 },
      { type: "text", label: "剩余积分", value: "6,106.51", balance: true },
      {
        type: "text",
        label: "月度套餐",
        value: "余 {remain} · {expiresAt}到期",
        valueParams: { remain: "6,106.51", expiresAt: "2026-10-31T12:00:00.000Z" },
        detail: true,
      },
      { type: "text", label: "连登", value: "3 天" },
    ]);
    expect(item.tightestPercent).toBe(2);
    expect(item.tightestLabel).toBe("积分额度");
    expect(item.lines.map((line) => line.kind)).toEqual(["window", "balance", "detail"]);
    expect(item.lines[0]).toMatchObject({ kind: "window", percent: 2, tightest: true });
    expect(item.lines[1]).toMatchObject({ kind: "balance", label: "剩余积分", value: "6,106.51" });
    expect(item.lines[2]).toMatchObject({
      kind: "detail",
      label: "月度套餐",
      value: "余 6,106.51 · 10月31日到期",
    });
  });

  it("Qoder 单资源包：池明细承担余量，不再出合计行", () => {
    const item = build(instance(), [
      { type: "progress", label: "资源包积分", used: 0, limit: 2793, percentUsed: 0 },
      {
        type: "text",
        label: "资源包",
        value: "余 {remain}",
        valueParams: { remain: "2,793" },
        detail: true,
      },
    ]);
    expect(item.lines.map((line) => line.kind)).toEqual(["window", "detail"]);
    expect(item.lines.some((line) => line.kind === "balance")).toBe(false);
  });

  it("Qoder 多池：合计余额行出在明细之后", () => {
    const item = build(instance(), [
      { type: "progress", label: "订阅积分", used: 80, limit: 100, percentUsed: 80 },
      { type: "progress", label: "资源包积分", used: 0, limit: 534, percentUsed: 0 },
      {
        type: "text",
        label: "资源包",
        value: "余 {remain}",
        valueParams: { remain: "534" },
        detail: true,
      },
      { type: "text", label: "剩余积分", value: "2,793", balance: true },
    ]);
    expect(item.tightestPercent).toBe(80);
    expect(item.lines.map((line) => line.kind)).toEqual([
      "window",
      "window",
      "detail",
      "balance",
    ]);
  });

  it("Qoder 单订阅池：没有池明细，合计行照出", () => {
    const item = build(instance(), [
      { type: "progress", label: "订阅积分", used: 20, limit: 100, percentUsed: 20 },
      { type: "text", label: "剩余积分", value: "80", balance: true },
    ]);
    expect(item.lines.map((line) => line.kind)).toEqual(["window", "balance"]);
  });

  it("最紧窗取已用最高者；平手取重置更近者", () => {
    const item = build(instance(), [
      {
        type: "progress",
        label: "订阅积分",
        used: 50,
        limit: 100,
        percentUsed: 50,
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
      {
        type: "progress",
        label: "资源包积分",
        used: 50,
        limit: 100,
        percentUsed: 50,
        resetsAt: "2026-10-24T00:00:00.000Z",
      },
      { type: "progress", label: "专属资源包", used: 10, limit: 100, percentUsed: 10 },
    ]);
    expect(item.tightestLabel).toBe("资源包积分");
    expect(item.lines.find((line) => line.kind === "window" && line.tightest)).toMatchObject({
      label: "资源包积分",
    });
  });

  it("没有 reset 的窗口不带 resetsAt，不写未知", () => {
    const item = build(instance(), [
      { type: "progress", label: "积分额度", used: 20, limit: 100, percentUsed: 20 },
    ]);
    expect(item.lines[0]).not.toHaveProperty("resetsAt");
  });

  it("未标记的文本行不进速览（连登/旅行/充值明细）", () => {
    const item = build(instance({ providerId: "workbuddy" }), [
      { type: "progress", label: "积分额度", used: 20, limit: 100, percentUsed: 20 },
      { type: "text", label: "连登", value: "3 天" },
      { type: "text", label: "喵喵旅行", value: "旅行中" },
      { type: "text", label: "充值余额", value: "¥4.00" },
    ]);
    expect(item.lines.map((line) => line.kind)).toEqual(["window"]);
  });

  it("GLM 未订阅但有余额：状态行与余额行并存，不被余额吞掉", () => {
    const item = build(instance({ providerId: "glm" }), [
      { type: "text", label: "Coding Plan", value: "未订阅", status: true },
      { type: "text", label: "账户余额", value: "¥0.01", balance: true },
    ]);
    expect(item.lines.map((line) => line.kind)).toEqual(["status", "balance"]);
  });

  it("DeepSeek 不可用：状态行带颜色，与余额行并存", () => {
    const item = build(instance({ providerId: "deepseek" }), [
      {
        type: "badge",
        label: "可用状态",
        value: "不可用",
        color: "#dc2626",
        status: true,
      },
      { type: "text", label: "账户余额", value: "¥4.88", balance: true },
    ]);
    expect(item.lines[0]).toMatchObject({
      kind: "status",
      label: "可用状态",
      value: "不可用",
      color: "#dc2626",
    });
    expect(item.lines[1]).toMatchObject({ kind: "balance", label: "账户余额" });
  });
});
