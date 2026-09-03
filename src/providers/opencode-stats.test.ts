import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { invoke } from "@tauri-apps/api/core";
import type { ProviderInstance } from "../types/ipc";
import {
  OPENCODE_RPC_ENDPOINT,
  OPENCODE_RPC_ID_HISTORY,
  OPENCODE_RPC_ID_MONTHLY,
  buildRpcEnvelope,
  fetchOpenCodeHistoryPage,
  fetchOpenCodeMonthlyCost,
  formatTimezoneOffset,
} from "./opencode-stats";

const mockInvoke = vi.mocked(invoke);

const readFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const vaultCredentials = { workspaceId: "wrk_test_ws", cookie: "Fe26.2" };

const instance: ProviderInstance = {
  id: "opencode-go",
  providerId: "opencode-go",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: 80,
  createdAt: 0,
};

describe("buildRpcEnvelope", () => {
  it("serializes the monthly envelope with string/number typed args and l=4", () => {
    expect(buildRpcEnvelope(["wrk_demo", 2026, 7, "+08:00"])).toBe(
      '{"t":{"t":9,"i":0,"l":4,"a":[{"t":1,"s":"wrk_demo"},{"t":0,"s":2026},{"t":0,"s":7},{"t":1,"s":"+08:00"}],"o":0},"f":31,"m":[]}',
    );
  });

  it("serializes the history envelope with l=2", () => {
    expect(buildRpcEnvelope(["wrk_demo", 3])).toBe(
      '{"t":{"t":9,"i":0,"l":2,"a":[{"t":1,"s":"wrk_demo"},{"t":0,"s":3}],"o":0},"f":31,"m":[]}',
    );
  });
});

describe("formatTimezoneOffset", () => {
  it("formats positive, negative and zero offsets as ±HH:MM", () => {
    expect(formatTimezoneOffset(480)).toBe("+08:00");
    expect(formatTimezoneOffset(-300)).toBe("-05:00");
    expect(formatTimezoneOffset(90)).toBe("+01:30");
    expect(formatTimezoneOffset(0)).toBe("+00:00");
  });
});

describe("fetchOpenCodeMonthlyCost", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the RPC envelope with the monthly x-server-id and maps cost to USD", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyText: readFixture("opencode-rpc-monthly.txt") });

    const result = await fetchOpenCodeMonthlyCost(instance, 2026, 8);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.costs).toHaveLength(6);
    const aug14 = result.data.costs.find((row) => row.date === "2026-08-14" && row.model === "deepseek-v4-flash");
    expect(aug14?.costUsd).toBe(7.63124625);
    expect(aug14?.keyId).toBe("key_TESTKEYAAAAAAAAAAAAAAAAA");
    expect(result.data.keys).toEqual([
      { id: "key_TESTKEYAAAAAAAAAAAAAAAAA", displayName: "user@example.com - Default API Key" },
      { id: "key_TESTKEYBBBBBBBBBBBBBBBBB", displayName: "user@example.com - workbuddy" },
    ]);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "vault_credentials", { instanceId: "opencode-go" });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "provider_request", {
      instanceId: "opencode-go",
      url: OPENCODE_RPC_ENDPOINT,
      method: "POST",
      auth: "cookie",
      headers: {
        "Content-Type": "application/json",
        "x-server-id": OPENCODE_RPC_ID_MONTHLY,
        "x-server-instance": "server-fn:0",
      },
      bodyText:
        '{"t":{"t":9,"i":0,"l":4,"a":[{"t":1,"s":"wrk_test_ws"},{"t":0,"s":2026},{"t":0,"s":7},{"t":1,"s":"+08:00"}],"o":0},"f":31,"m":[]}',
    });
  });

  it("returns needs_config without any request when workspace id is missing", async () => {
    invokeMock.mockResolvedValueOnce({ workspaceId: "   ", cookie: "" });

    const result = await fetchOpenCodeMonthlyCost(instance, 2026, 8);

    expect(result).toEqual({
      status: "needs_config",
      message: "请在设置中填写 Workspace ID 和 Auth Cookie",
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("returns an error carrying the HTTP status on non-200 responses", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({ status: 503, headers: {}, bodyText: "<html>down</html>" });

    const result = await fetchOpenCodeMonthlyCost(instance, 2026, 8);

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.params?.status).toBe(503);
    expect(result.status === "error" && result.message).toBe("opencode.ai 接口返回 HTTP {status}");
  });

  it("surfaces the x-error server business message with a workspace-mismatch hint", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({
        status: 200,
        headers: { "x-error": 'actor of type "account" is not associated with a workspace' },
        bodyText: ";0x1;((self.$R=self.$R||{})[\"server-fn:0\"]=[],($R=>$R[0]=Object.assign(new Error(\"boom\"),{stack:\"s\"}))($R[\"server-fn:0\"]))",
      });

    const result = await fetchOpenCodeMonthlyCost(instance, 2026, 8);

    expect(result).toEqual({
      status: "error",
      message: "opencode.ai：{detail}。请核对设置中的 Workspace ID 与 Auth Cookie 是否来自同一账号",
      params: { detail: 'actor of type "account" is not associated with a workspace' },
    });
  });

  it("surfaces a friendly message for the server-side 'Invalid time value' bug", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({
        status: 200,
        headers: { "x-error": "Invalid time value" },
        bodyText:
          ';0x3;((self.$R=self.$R||{})["server-fn:0"]=[],($R=>$R[0]=Object.assign(new RangeError("Invalid time value"),{stack:"..."}))($R["server-fn:0"]))',
      });

    const result = await fetchOpenCodeMonthlyCost(instance, 2026, 8);

    expect(result).toEqual({
      status: "error",
      message: "opencode.ai 服务端内部错误（时间处理异常），请稍后重试或切换到其他月份查看。",
      params: {},
    });
  });

  it("reports an expired login when the response redirects to /auth/authorize", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({
        status: 200,
        headers: { "x-error": "true" },
        bodyText:
          ';0x2;((self.$R=self.$R||{})["server-fn:0"]=[],($R=>$R[0]=new Response(null,$R[1]={headers:new Headers([["location","/auth/authorize"]]),status:302}))($R["server-fn:0"]))',
      });

    const result = await fetchOpenCodeMonthlyCost(instance, 2026, 8);

    expect(result).toEqual({
      status: "error",
      message: "OpenCode 登录态已失效，请在设置中重新复制 Auth Cookie",
    });
  });

  it("returns the fixed revision-drift message when the body cannot be parsed", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyText: "<html>unexpected</html>" });

    const result = await fetchOpenCodeMonthlyCost(instance, 2026, 8);

    expect(result).toEqual({
      status: "error",
      message: "opencode.ai 返回结构无法解析，可能已改版",
    });
  });
});

describe("fetchOpenCodeHistoryPage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps usage records with USD costs, ISO timestamps and empty session ids kept", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyText: readFixture("opencode-rpc-history.txt") });

    const result = await fetchOpenCodeHistoryPage(instance, 0);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const records = result.data.records;
    expect(records).toHaveLength(5);
    expect(records[0]?.timeCreated).toBe("2026-08-24T01:49:24.000Z");
    expect(records[3]?.model).toBe("mimo-v2.5");
    expect(records[3]?.costUsd).toBe(0.00020852);
    expect(records[3]?.cacheReadTokens).toBe(46272);
    expect(records[0]?.sessionId).toBe("ses_TESTSESSION00000000001");
    expect(records[1]?.sessionId).toBe("");
    expect(records[4]?.sessionId).not.toBe("");
  });

  it("drops unmodeled fields such as enrichment and timeDeleted", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyText: readFixture("opencode-rpc-history.txt") });

    const result = await fetchOpenCodeHistoryPage(instance, 0);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const record = result.data.records[0];
    expect(Object.keys(record ?? {})).toEqual([
      "id",
      "timeCreated",
      "model",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheReadTokens",
      "costUsd",
      "keyId",
      "sessionId",
    ]);
  });

  it("routes through the history x-server-id with a two-arg envelope", async () => {
    invokeMock
      .mockResolvedValueOnce(vaultCredentials)
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyText: readFixture("opencode-rpc-history.txt") });

    await fetchOpenCodeHistoryPage(instance, 2);

    expect(mockInvoke).toHaveBeenNthCalledWith(2, "provider_request", {
      instanceId: "opencode-go",
      url: OPENCODE_RPC_ENDPOINT,
      method: "POST",
      auth: "cookie",
      headers: {
        "Content-Type": "application/json",
        "x-server-id": OPENCODE_RPC_ID_HISTORY,
        "x-server-instance": "server-fn:0",
      },
      bodyText:
        '{"t":{"t":9,"i":0,"l":2,"a":[{"t":1,"s":"wrk_test_ws"},{"t":0,"s":2}],"o":0},"f":31,"m":[]}',
    });
  });
});
