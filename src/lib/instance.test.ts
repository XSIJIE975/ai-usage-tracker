import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "../types/ipc";
import { displayName, hasMultipleSites, providerSites, selectOrderedInstances, SITE_LABELS } from "./instance";

const instance = (note: string): ProviderInstance => ({
  id: "deepseek",
  providerId: "deepseek",
  note,
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
  balanceThreshold: null,
  site: "china",
  createdAt: 0,
});

describe("displayName", () => {
  it("备注优先显示", () => {
    expect(displayName(instance("公司主账号"), "DeepSeek")).toBe("公司主账号");
  });

  it("空白备注回退供应商名", () => {
    expect(displayName(instance(""), "DeepSeek")).toBe("DeepSeek");
    expect(displayName(instance("   "), "DeepSeek")).toBe("DeepSeek");
  });
});

describe("selectOrderedInstances", () => {
  const item = (id: string, sortOrder: number, pinned: boolean, createdAt: number): ProviderInstance => ({
    ...instance(""),
    id,
    sortOrder,
    pinned,
    createdAt,
  });

  it("置顶优先，其余按 sortOrder 升序", () => {
    const ordered = selectOrderedInstances([
      item("a", 0, false, 3),
      item("b", 1, true, 2),
      item("c", 2, false, 1),
    ]);
    expect(ordered.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("sortOrder 相同按 createdAt 升序稳定排列", () => {
    const ordered = selectOrderedInstances([
      item("late", 0, false, 200),
      item("early", 0, false, 100),
    ]);
    expect(ordered.map((i) => i.id)).toEqual(["early", "late"]);
  });

  it("不改写输入数组", () => {
    const input = [item("a", 1, false, 0), item("b", 0, false, 0)];
    selectOrderedInstances(input);
    expect(input.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("providerSites / hasMultipleSites（ADR-0031）", () => {
  it("多站种类给出可选站点集，单站种类为空", () => {
    expect(providerSites("qoder")).toEqual(["china", "international"]);
    expect(providerSites("workbuddy")).toEqual(["china", "international"]);
    expect(providerSites("deepseek")).toEqual([]);
    expect(hasMultipleSites("qoder")).toBe(true);
    expect(hasMultipleSites("workbuddy")).toBe(true);
    expect(hasMultipleSites("glm")).toBe(false);
  });

  it("站点短名可直接当 i18n 键", () => {
    expect(SITE_LABELS.china).toBe("中国站");
    expect(SITE_LABELS.international).toBe("国际站");
  });
});
