import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  fetchOpenCodeLogs,
  fetchOpenCodeOverview,
  parseOpenCodeDailyCost,
  parseOpenCodeModelUsage,
  parseOpenCodeRequestLogs,
  parseOpenCodeSummary,
} from "./opencode-stats";
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

/** 合成夹具：字段形状照控制台，数值均为假数据。 */
const summaryPayload = {
  totalRequests: "42",
  totalInputTokens: "1000",
  totalOutputTokens: "500",
  totalCacheReadTokens: "2000",
  totalCacheWrite5mTokens: "100",
  totalCacheWrite1hTokens: "50",
  totalCostMicroCents: "12345678",
  services: [],
};

const dailyPayload = [
  {
    date: "2020-01-02",
    totalCostMicroCents: "12345678",
    totalTokens: "3650",
    totalRequests: "42",
  },
];

const modelsPayload = {
  items: [
    {
      model: "test-model",
      provider: "opencode-go",
      totalRequests: "42",
      totalInputTokens: "1000",
      totalOutputTokens: "500",
      totalCacheReadTokens: "2000",
      totalCacheWrite5mTokens: "100",
      totalCacheWrite1hTokens: "50",
      totalCostMicroCents: "12345678",
    },
  ],
  pageInfo: { page: 1, pageSize: 100, total: 1, pageCount: 1 },
};

const logsPayload = {
  items: [
    {
      id: "log-1",
      startedAt: 1_600_000_000_000,
      durationMs: 1500,
      outcome: "succeeded",
      statusCode: 200,
      model: "test-model",
      provider: "opencode",
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      cost: 0.0012,
      sessionID: "sess-test-1",
    },
    {
      id: "log-2",
      startedAt: 1_600_000_100_000,
      outcome: "failed",
      statusCode: 500,
      path: "/console/api/usage/summary",
    },
  ],
  nextCursor: "cursor-test-1",
  retentionDays: 30,
};

function http(status: number, bodyText: string): HttpResult {
  return { status, headers: {}, bodyText };
}

type RequestArgs = { url: string; auth?: string; headers?: Record<string, string> };

function mockBackend(options: {
  credentials?: Record<string, string>;
  respond: (request: RequestArgs) => HttpResult;
}) {
  const calls: RequestArgs[] = [];
  invokeMock.mockImplementation((command: string, args?: RequestArgs) => {
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

const credentials = {
  workspaceId: "wrk_TEST123",
  cookie: "__Host-console_session=test",
};

const apiKeyCredentials = { apiKey: "oc_sk_test" };

describe("parsers", () => {
  it("parses summary totals and micro-cent cost", () => {
    const summary = parseOpenCodeSummary(summaryPayload);
    expect(summary.requests).toBe(42);
    expect(summary.costUsd).toBeCloseTo(0.12345678, 8);
    expect(summary.totalTokens).toBe(3650);
    expect(summary.cacheWriteTokens).toBe(150);
  });

  it("parses daily buckets and model pages", () => {
    expect(parseOpenCodeDailyCost(dailyPayload)).toEqual([
      { date: "2020-01-02", costUsd: 0.12345678, tokens: 3650, requests: 42 },
    ]);
    expect(parseOpenCodeDailyCost({})).toEqual([]);
    // 接口若按倒序返回，图表仍按日期升序
    expect(
      parseOpenCodeDailyCost([
        { date: "2020-01-03", totalCostMicroCents: "1" },
        { date: "2020-01-01", totalCostMicroCents: "1" },
      ]).map((item) => item.date),
    ).toEqual(["2020-01-01", "2020-01-03"]);

    const models = parseOpenCodeModelUsage(modelsPayload);
    expect(models.pageCount).toBe(1);
    expect(models.items[0]).toMatchObject({
      model: "test-model",
      requests: 42,
      costUsd: 0.12345678,
    });
  });

  it("parses request logs, keeping missing cost/duration as unknown", () => {
    const page = parseOpenCodeRequestLogs(logsPayload);
    expect(page.nextCursor).toBe("cursor-test-1");
    expect(page.retentionDays).toBe(30);
    expect(page.items[0]).toMatchObject({
      id: "log-1",
      model: "test-model",
      statusCode: 200,
      durationMs: 1500,
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.0012,
      sessionId: "sess-test-1",
    });
    expect(page.items[1]).toMatchObject({
      model: "",
      costUsd: null,
      durationMs: null,
    });
  });

  it("builds a stable id fallback when id and requestID are missing", () => {
    const page = parseOpenCodeRequestLogs({
      items: [{ startedAt: 1_600_000_000_000, sessionID: "sess-test-2" }],
    });
    expect(page.items[0].id).toBe("1600000000000:sess-test-2");
  });

  it("keeps explicit zero cost/duration instead of treating them as missing", () => {
    const page = parseOpenCodeRequestLogs({
      items: [{ id: "log-zero", startedAt: 1_600_000_000_000, cost: 0, durationMs: 0 }],
    });
    expect(page.items[0]).toMatchObject({ costUsd: 0, durationMs: 0 });
  });
});

describe("fetchOpenCodeOverview", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("requests summary, daily cost and models with the console credentials", async () => {
    const calls = mockBackend({
      credentials: apiKeyCredentials,
      respond: (request) => {
        if (request.url.includes("/usage/summary")) {
          return http(200, JSON.stringify(summaryPayload));
        }
        if (request.url.includes("/usage/cost-by-day")) {
          return http(200, JSON.stringify(dailyPayload));
        }
        if (request.url.includes("/usage/models")) {
          return http(200, JSON.stringify(modelsPayload));
        }
        return http(404, "{}");
      },
    });

    const result = await fetchOpenCodeOverview(instance, "30d");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.summary.costUsd).toBeCloseTo(0.12345678, 8);
    expect(result.data.daily).toHaveLength(1);
    expect(result.data.models).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.auth === "bearer")).toBe(true);
    expect(calls.every((call) => call.headers?.["x-org-id"] === undefined)).toBe(true);
    expect(calls.some((call) => call.url.includes("bucket=day"))).toBe(true);
  });

  it("walks every model page", async () => {
    const pages = [1, 2].map((page) => ({
      items: [
        {
          model: `test-model-${page}`,
          provider: "opencode-go",
          totalRequests: "1",
          totalCostMicroCents: "10000000",
        },
      ],
      pageInfo: { page, pageSize: 100, total: 2, pageCount: 2 },
    }));
    const calls = mockBackend({
      credentials: apiKeyCredentials,
      respond: (request) => {
        if (request.url.includes("/usage/models")) {
          const page = Number(new URL(request.url).searchParams.get("page"));
          return http(200, JSON.stringify(pages[page - 1]));
        }
        return http(200, "{}");
      },
    });

    const result = await fetchOpenCodeOverview(instance, "7d");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.models.map((item) => item.model)).toEqual([
      "test-model-1",
      "test-model-2",
    ]);
    expect(calls.filter((call) => call.url.includes("/usage/models"))).toHaveLength(2);
  });

  it("uses hourly buckets for the 24h range", async () => {
    const calls = mockBackend({
      credentials: apiKeyCredentials,
      respond: () => http(200, JSON.stringify(dailyPayload)),
    });

    await fetchOpenCodeOverview(instance, "24h");

    expect(calls.some((call) => call.url.includes("bucket=hour"))).toBe(true);
  });

  it("asks for the API Key when it is missing", async () => {
    const calls = mockBackend({
      credentials,
      respond: () => http(200, "{}"),
    });

    const result = await fetchOpenCodeOverview(instance, "30d");

    expect(result).toEqual({
      status: "needs_config",
      message: "请在配置中填写 OpenCode Go API Key",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps API key auth and server failures", async () => {
    for (const [status, message] of [
      [401, "OpenCode Go API Key 无效或已过期"],
      [403, "该 API Key 未开通 OpenCode Go 订阅"],
    ] as const) {
      invokeMock.mockReset();
      mockBackend({ credentials: apiKeyCredentials, respond: () => http(status, "{}") });
      const result = await fetchOpenCodeOverview(instance, "30d");
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.message).toBe(message);
    }

    invokeMock.mockReset();
    mockBackend({ credentials: apiKeyCredentials, respond: () => http(500, "{}") });
    const result = await fetchOpenCodeOverview(instance, "30d");
    expect(result).toEqual({
      status: "error",
      message: "OpenCode 用量接口返回 HTTP {status}",
      params: { status: 500 },
    });
  });

  it("uses the usage wording when a bearer response is not JSON", async () => {
    mockBackend({
      credentials: apiKeyCredentials,
      respond: (request) =>
        request.url.includes("/usage/summary")
          ? http(200, "not-json")
          : http(200, "{}"),
    });

    const result = await fetchOpenCodeOverview(instance, "30d");

    expect(result).toEqual({
      status: "error",
      message: "OpenCode 用量接口返回结构无法解析",
    });
  });
});

describe("fetchOpenCodeLogs", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("uses a rolling since window and no cursor on the first page", async () => {
    const calls = mockBackend({
      credentials,
      respond: () => http(200, JSON.stringify(logsPayload)),
    });
    const before = Date.now();

    const result = await fetchOpenCodeLogs(instance, "24h");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.items).toHaveLength(2);
    expect(result.data.nextCursor).toBe("cursor-test-1");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/console/api/request-logs");
    expect(calls[0].auth).toBe("cookie");
    expect(calls[0].headers?.["x-org-id"]).toBe("wrk_TEST123");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("category")).toBe("inference");
    expect(url.searchParams.has("cursor")).toBe(false);
    const since = Number(url.searchParams.get("since"));
    expect(since).toBeGreaterThanOrEqual(before - 86_400_000 - 1_000);
  });

  it("passes the cursor for the next page", async () => {
    const calls = mockBackend({
      credentials,
      respond: () => http(200, JSON.stringify(logsPayload)),
    });

    await fetchOpenCodeLogs(instance, "7d", "cursor-1");

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("does not request logs without the web credentials", async () => {
    const calls = mockBackend({
      credentials: { cookie: "__Host-console_session=test" },
      respond: () => http(200, "{}"),
    });

    const result = await fetchOpenCodeLogs(instance, "7d");

    expect(result).toEqual({
      status: "needs_config",
      message: "请在配置中填写 Workspace ID 和 Cookie 才能查看请求日志",
    });
    expect(calls).toHaveLength(0);
  });

  it("asks for a console session cookie when only the legacy auth value is stored", async () => {
    const calls = mockBackend({
      credentials: { workspaceId: "wrk_TEST123", cookie: "auth=test" },
      respond: () => http(200, "{}"),
    });

    const result = await fetchOpenCodeLogs(instance, "7d");

    expect(result).toEqual({
      status: "needs_config",
      message: "当前 Cookie 不含 __Host-console_session，请重新复制控制台 Cookie",
    });
    expect(calls).toHaveLength(0);
  });

  it("accepts a bare console session value stored by older versions", async () => {
    const calls = mockBackend({
      credentials: { workspaceId: "wrk_TEST123", cookie: "st_TEST-session-0000" },
      respond: () => http(200, JSON.stringify(logsPayload)),
    });

    const result = await fetchOpenCodeLogs(instance, "7d");

    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("maps console auth failures for logs", async () => {
    for (const [status, message] of [
      [401, "OpenCode 登录态已失效，请在配置中重新复制 Cookie"],
      [403, "OpenCode 登录态已失效，请在配置中重新复制 Cookie"],
      [400, "OpenCode 控制台要求 x-org-id，请核对 Workspace ID"],
    ] as const) {
      invokeMock.mockReset();
      mockBackend({ credentials, respond: () => http(status, "{}") });
      const result = await fetchOpenCodeLogs(instance, "7d");
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.message).toBe(message);
    }
  });

  it("uses the console wording for non-auth log failures", async () => {
    mockBackend({ credentials, respond: () => http(500, "{}") });
    const result = await fetchOpenCodeLogs(instance, "7d");
    expect(result).toEqual({
      status: "error",
      message: "OpenCode 控制台返回 HTTP {status}",
      params: { status: 500 },
    });
  });
});
