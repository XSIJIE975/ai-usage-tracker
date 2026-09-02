import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "../types/ipc";
import { displayName, selectOrderedInstances } from "./instance";

const instance = (note: string): ProviderInstance => ({
  id: "deepseek",
  providerId: "deepseek",
  note,
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
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
