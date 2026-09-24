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

describe("buildGlanceInstances 中性事实行", () => {
  it("Qoder 未分配积分：没有进度行也没有余额位时，读数用中性事实行原文", () => {
    // 主卡片上写的就是「未分配积分」，速览不能再报「暂无数据」（两套口径互相打脸）
    const item = build(instance(), [{ type: "text", label: "积分余量", value: "未分配积分" }]);
    expect(item.primaryPercent).toBeNull();
    expect(item.balanceText).toBeNull();
    expect(item.neutralText).toBe("未分配积分");
  });

  it("WorkBuddy 无套餐同一口径", () => {
    const inst = instance({ providerId: "workbuddy" });
    const item = build(inst, [{ type: "text", label: "积分余量", value: "暂无有效套餐" }]);
    expect(item.neutralText).toBe("暂无有效套餐");
  });

  it("有进度行时中性行不上位（逐窗明细不能当整实例的状态）", () => {
    const inst = instance({ providerId: "workbuddy" });
    const item = build(inst, [
      {
        type: "progress",
        label: "积分余量",
        used: 40,
        limit: 100,
        percentUsed: 40,
        value: "60",
        balance: true,
      },
      {
        type: "text",
        label: "个人套餐",
        value: "余 {remain} · {expiresAt}到期",
        valueParams: { remain: "60", expiresAt: "2026-10-18T00:00:00.000Z" },
      },
    ]);
    expect(item.primaryPercent).toBe(40);
    expect(item.neutralText).toBeNull();
  });
});
