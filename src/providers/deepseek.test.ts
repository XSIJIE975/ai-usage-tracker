import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { deepseekProvider } from "./deepseek";
import type { ProviderInstance } from "../types/ipc";

const mockInvoke = vi.mocked(invoke);

const instance: ProviderInstance = {
  id: "deepseek",
  providerId: "deepseek",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: 50,
};

describe("deepseekProvider", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("returns needs_config when key is missing", async () => {
    mockInvoke.mockResolvedValueOnce({});

    const snapshot = await deepseekProvider.fetch(instance);
    expect(snapshot.status).toBe("needs_config");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("parses balance response", async () => {
    mockInvoke
      .mockResolvedValueOnce({ apiKey: true })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "12.34",
              granted_balance: "2",
              topped_up_balance: "10.34",
            },
          ],
        }),
      });

    const snapshot = await deepseekProvider.fetch(instance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines[0]).toMatchObject({ label: "可用状态", value: "可用" });
    expect(snapshot.lines[1].value).toContain("12.34");
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      "provider_request",
      expect.objectContaining({
        instanceId: "deepseek",
        url: "https://api.deepseek.com/user/balance",
        method: "GET",
        auth: "bearer",
      }),
    );
  });

  it("returns error for non-200 response", async () => {
    mockInvoke
      .mockResolvedValueOnce({ apiKey: true })
      .mockResolvedValueOnce({ status: 401, headers: {}, bodyText: "unauthorized" });

    const snapshot = await deepseekProvider.fetch(instance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("401");
  });
});
