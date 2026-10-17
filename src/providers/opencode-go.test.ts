import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  opencodeGoProvider,
  parseOpenCodeApiUsage,
  parseOpenCodeBalance,
} from "./opencode-go";
import type { HttpResult, ProviderInstance } from "../types/ipc";

const instance: ProviderInstance = {
  id: "opencode-go",
  providerId: "opencode-go",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: 80,
  balanceThreshold: null,
  site: "china",
  tokenAutoRenew: true,
  createdAt: 0,
};

const NOW = Date.parse("2026-09-20T00:00:00.000Z");

/** 合成夹具：金额/时刻均为假数据，勿替换成真实账号导出。 */
const apiUsage = JSON.stringify({
  usage: {
    rolling: { status: "ok", percent: 42.5, resetsAt: "2026-09-20T03:00:00.000Z" },
    weekly: { status: "ok", percent: 18, resetInSec: 3600 },
    monthly: { status: "ok", percent: 9, resetsAt: "2026-10-19T00:00:00.000Z" },
  },
});

const billingZero = JSON.stringify({
  billingMode: "prepaid",
  mode: "pay-as-you-go",
  balanceMicroCents: "0",
  creditLimitMicroCents: null,
  availableMicroCents: "0",
  canPurchaseCredits: true,
});

const billingPositive = JSON.stringify({
  billingMode: "prepaid",
  mode: "pay-as-you-go",
  balanceMicroCents: "123456789",
  availableMicroCents: "123456789",
});

const API_URL = "https://opencode.ai/zen/go/v1/usage";
const BILLING_URL = "https://opencode.ai/console/api/billing/status";

type RequestArgs = {
  url: string;
  auth?: string;
  headers?: Record<string, string>;
};

function http(status: number, bodyText: string): HttpResult {
  return { status, headers: {}, bodyText };
}

function mockBackend(options: {
  status?: Record<string, boolean>;
  credentials?: Record<string, string>;
  respond: (request: RequestArgs) => HttpResult;
}) {
  const calls: RequestArgs[] = [];
  invokeMock.mockImplementation((command: string, args?: RequestArgs) => {
    if (command === "vault_credential_status") {
      return Promise.resolve({
        workspaceId: false,
        cookie: false,
        apiKey: false,
        ...options.status,
      });
    }
    if (command === "vault_credentials") {
      return Promise.resolve({ ...options.credentials });
    }
    if (command === "provider_request") {
      calls.push(args as RequestArgs);
      return Promise.resolve(options.respond(args as RequestArgs));
    }
    return Promise.reject(new Error(`unexpected command ${command}`));
  });
  return calls;
}

describe("parseOpenCodeApiUsage", () => {
  it("reads percent as 0-100 and accepts both reset encodings", () => {
    const windows = parseOpenCodeApiUsage(apiUsage, NOW);

    expect(windows?.rolling).toEqual({ usagePercent: 42.5, resetInSec: 10_800 });
    expect(windows?.weekly).toEqual({ usagePercent: 18, resetInSec: 3600 });
    expect(windows?.monthly).toEqual({ usagePercent: 9, resetInSec: 2_505_600 });
  });

  it("does not reinterpret a fractional percent as a ratio", () => {
    const windows = parseOpenCodeApiUsage(
      '{"usage":{"rolling":{"percent":0.5,"resetInSec":60}}}',
      NOW,
    );
    expect(windows?.rolling?.usagePercent).toBe(0.5);
  });

  it("rejects payloads without a rolling window", () => {
    expect(parseOpenCodeApiUsage('{"usage":{"weekly":{"percent":1}}}', NOW)).toBeNull();
    expect(parseOpenCodeApiUsage("<html>404</html>", NOW)).toBeNull();
  });
});

describe("parseOpenCodeBalance", () => {
  it("converts micro-cents to USD", () => {
    expect(parseOpenCodeBalance(billingZero)).toBe(0);
    expect(parseOpenCodeBalance(billingPositive)).toBeCloseTo(1.23456789, 8);
    expect(parseOpenCodeBalance('{"balanceMicroCents":"-12345678"}')).toBeCloseTo(-0.12345678, 8);
  });

  it("does not substitute availableMicroCents for a missing balance", () => {
    expect(parseOpenCodeBalance('{"availableMicroCents":"1500000000"}')).toBeNull();
    expect(parseOpenCodeBalance('{"balanceMicroCents":null}')).toBeNull();
    expect(parseOpenCodeBalance("<html>403</html>")).toBeNull();
  });
});

describe("opencodeGoProvider.fetch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("requires an API Key", async () => {
    const calls = mockBackend({
      status: { workspaceId: true, cookie: true },
      credentials: { workspaceId: "wrk_TEST123", cookie: "__Host-console_session=test" },
      respond: () => http(200, apiUsage),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("needs_config");
    expect(snapshot.message).toBe("请在配置中填写 OpenCode Go API Key");
    expect(calls).toHaveLength(0);
  });

  it("uses the API Key alone without requiring a workspace or cookie", async () => {
    const calls = mockBackend({
      status: { apiKey: true },
      credentials: {},
      respond: () => http(200, apiUsage),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toMatchObject([
      { label: "5 小时额度", windowPeriodMs: 5 * 3_600_000, percentUsed: 42.5 },
      { label: "本周额度", windowPeriodMs: 7 * 86_400_000, percentUsed: 18 },
      { label: "本月额度", windowPeriodMs: 30 * 86_400_000, percentUsed: 9 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(API_URL);
    expect(calls[0].auth).toBe("bearer");
  });

  it("appends the Zen balance when workspace and cookie are configured", async () => {
    const calls = mockBackend({
      status: { apiKey: true, workspaceId: true, cookie: true },
      credentials: {
        workspaceId: "wrk_TEST123",
        cookie: "__Host-console_session=test",
      },
      respond: (request) =>
        request.url === BILLING_URL ? http(200, billingZero) : http(200, apiUsage),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(4);
    expect(snapshot.lines[3]).toEqual({
      type: "text",
      label: "Zen 余额",
      value: "$0.00",
      balance: true,
    });
    // 余额与用量并行发出，顺序不固定
    expect(calls.map((call) => call.url).sort()).toEqual([API_URL, BILLING_URL].sort());
    const billing = calls.find((call) => call.url === BILLING_URL);
    expect(billing?.auth).toBe("cookie");
    expect(billing?.headers?.["x-org-id"]).toBe("wrk_TEST123");
  });

  it("formats a positive balance as USD", async () => {
    mockBackend({
      status: { apiKey: true, workspaceId: true, cookie: true },
      credentials: { workspaceId: "wrk_TEST123", cookie: "__Host-console_session=test" },
      respond: (request) =>
        request.url === BILLING_URL ? http(200, billingPositive) : http(200, apiUsage),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.lines[3]).toMatchObject({ label: "Zen 余额", value: "$1.23", balance: true });
  });

  it("does not query balance when only one of workspace/cookie is filled", async () => {
    const calls = mockBackend({
      status: { apiKey: true, workspaceId: true },
      credentials: { workspaceId: "wrk_TEST123" },
      respond: () => http(200, apiUsage),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual([API_URL]);
  });

  it("does not query balance with a legacy auth-only cookie", async () => {
    const calls = mockBackend({
      status: { apiKey: true, workspaceId: true, cookie: true },
      credentials: { workspaceId: "wrk_TEST123", cookie: "auth=legacy" },
      respond: () => http(200, apiUsage),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
    // billing/status 只认 __Host-console_session；旧 auth Cookie 不发注定失败的请求
    expect(calls.map((call) => call.url)).toEqual([API_URL]);
  });

  it("keeps usage when the balance request fails", async () => {
    mockBackend({
      status: { apiKey: true, workspaceId: true, cookie: true },
      credentials: { workspaceId: "wrk_TEST123", cookie: "__Host-console_session=test" },
      respond: (request) =>
        request.url === BILLING_URL ? http(403, '{"_tag":"Forbidden"}') : http(200, apiUsage),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
  });

  it("omits the balance line when the response has no balance field", async () => {
    mockBackend({
      status: { apiKey: true, workspaceId: true, cookie: true },
      credentials: { workspaceId: "wrk_TEST123", cookie: "__Host-console_session=test" },
      respond: (request) =>
        request.url === BILLING_URL
          ? http(200, '{"availableMicroCents":"1500000000"}')
          : http(200, apiUsage),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
  });

  it("reports an invalid API Key on 401", async () => {
    mockBackend({
      status: { apiKey: true },
      credentials: {},
      respond: () => http(401, "{}"),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("OpenCode Go API Key 无效或已过期");
  });

  it("reports a missing Go subscription on 403", async () => {
    mockBackend({
      status: { apiKey: true },
      credentials: {},
      respond: () => http(403, "{}"),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("该 API Key 未开通 OpenCode Go 订阅");
  });

  it("reports a parse error for a non-JSON usage response", async () => {
    mockBackend({
      status: { apiKey: true },
      credentials: {},
      respond: () => http(200, "<html>not json</html>"),
    });

    const snapshot = await opencodeGoProvider.fetch(instance);

    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("OpenCode Go 用量接口返回结构无法解析");
  });
});
