import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "../types/ipc";
import { displayName } from "./instance";

const instance = (note: string): ProviderInstance => ({
  id: "deepseek",
  providerId: "deepseek",
  note,
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
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
