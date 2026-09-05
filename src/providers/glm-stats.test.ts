import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance } from "../types/ipc";
import {
  buildGlmUsageQuery,
  fetchGlmAccountBalance,
  fetchGlmResetCards,
  fetchGlmUsage,
  parseGlmAccountBalance,
  parseGlmResetCards,
  parseLocalDateTime,
  parseModelUsage,
  parseToolUsage,
  useGlmResetCard,
} from "./glm-stats";

const mockInvoke = vi.mocked(invoke);

const readFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const loadModelUsage24h = () => JSON.parse(readFixture("glm-model-usage-24h.json"));
const loadModelUsage30d = () => JSON.parse(readFixture("glm-model-usage-30d.json"));
const loadToolUsage = () => JSON.parse(readFixture("glm-tool-usage.json"));
const loadToolUsageLive = () => JSON.parse(readFixture("glm-tool-usage-live.json"));
const loadBalance = () => JSON.parse(readFixture("glm-balance.json"));
const loadReset = () => JSON.parse(readFixture("glm-package-reset.json"));

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

const glmInstance: ProviderInstance = {
  id: "glm",
  providerId: "glm",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: 80,
  balanceThreshold: null,
  createdAt: 0,
};

const credentialStatus = (planKey: boolean) => ({ planKey });

describe("buildGlmUsageQuery", () => {
  it("formats local datetime strings and steps the end back into the last day", () => {
    const startMs = new Date(2026, 8, 1, 0, 0, 0).getTime();
    const endMs = new Date(2026, 8, 3, 0, 0, 0).getTime();
    expect(buildGlmUsageQuery(startMs, endMs)).toEqual({
      startTime: "2026-09-01 00:00:00",
      endTime: "2026-09-02 23:59:59",
    });
  });
});

describe("parseModelUsage", () => {
  it("parses the captured 24h fixture (hourly granularity)", () => {
    const json = loadModelUsage24h();
    const usage = parseModelUsage(json.data);
    expect(usage.buckets).toHaveLength(25);
    expect(usage.granularity).toBe("hourly");
    expect(usage.totals).toEqual({ calls: 230, tokens: 2300000 });
    // 按 Token 合计降序：Flash(1392000) 在 5.3(908000) 前
    expect(usage.models.map((model) => model.name)).toEqual(["GLM-5.3-Flash", "GLM-5.3"]);
    expect(usage.models[0]).toMatchObject({ totalTokens: 1392000 });
    expect(usage.models[0].tokens).toHaveLength(25);
  });

  it("parses the captured 30d fixture (daily granularity)", () => {
    const json = loadModelUsage30d();
    const usage = parseModelUsage(json.data);
    expect(usage.buckets).toHaveLength(31);
    expect(usage.granularity).toBe("daily");
    expect(usage.totals).toEqual({ calls: 286, tokens: 3360006 });
    expect(usage.models.map((model) => model.name)).toEqual(["GLM-5.3-Flash", "GLM-5.3", "GLM-5-Turbo"]);
  });

  it("is tolerant of missing fields and derives totals from series", () => {
    const usage = parseModelUsage({
      x_time: ["2026-09-01", "2026-09-02"],
      modelDataList: [
        { modelName: "GLM-5.3", tokensUsage: [10, 32] },
        { sortOrder: 9 },
      ],
    });
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]).toMatchObject({ name: "GLM-5.3", totalTokens: 42 });
    expect(usage.callCount).toEqual([0, 0]);
    expect(usage.totals).toEqual({ calls: 0, tokens: 0 });
  });

  it("returns an empty shape for missing data", () => {
    expect(parseModelUsage(undefined)).toMatchObject({ buckets: [], models: [], totals: { calls: 0, tokens: 0 } });
  });
});

describe("parseToolUsage", () => {
  it("parses the captured fixture with zero tool calls", () => {
    const usage = parseToolUsage(loadToolUsage().data);
    expect(usage.buckets).toHaveLength(25);
    // 动态列表为空时回退固定序列，但全零序列不再占据展示行
    expect(usage.fixed.map((series) => series.name)).toEqual(["联网搜索", "网页阅读（MCP）", "Zread（MCP）"]);
    expect(usage.fixed.every((series) => series.total === 0)).toBe(true);
    expect(usage.tools).toEqual([]);
    expect(usage.totalCalls).toBe(0);
  });

  it("parses the live fixture: dynamic list wins over fixed aliases", () => {
    const usage = parseToolUsage(loadToolUsageLive().data);
    // 固定三序列与动态列表是同一批数据的两份别名，只展示动态列表（服务端只下发有调用的工具）
    expect(usage.tools).toHaveLength(2);
    expect(usage.tools[0]).toMatchObject({
      name: "联网搜索 MCP",
      i18nName: "Web Search MCP",
      total: 7,
    });
    expect(usage.tools[0]!.counts).toEqual(loadToolUsageLive().data.networkSearchCount);
    expect(usage.tools[1]).toMatchObject({ name: "网页读取 MCP", i18nName: "Web Read MCP", total: 5 });
    expect(usage.totalCalls).toBe(12);
  });

  it("parses dynamic toolDataList entries with the confirmed field names and skips unnamed ones", () => {
    const usage = parseToolUsage({
      x_time: ["2026-09-01", "2026-09-02"],
      networkSearchCount: [3, 1],
      toolDataList: [
        { toolName: "search-mcp", toolNameI18n: "Search MCP", usageCount: [2, 2], totalUsageCount: 4 },
        { usageCount: [1, 1] },
      ],
    });
    // 动态列表非空：固定序列不进入展示行，totalCalls 只按展示序列合计
    expect(usage.fixed[0]).toMatchObject({ name: "联网搜索", counts: [3, 1], total: 4 });
    expect(usage.tools).toEqual([
      { name: "search-mcp", i18nName: "Search MCP", counts: [2, 2], total: 4 },
    ]);
    expect(usage.totalCalls).toBe(4);
  });

  it("falls back to non-zero fixed series when the dynamic list is empty", () => {
    const usage = parseToolUsage({
      x_time: ["2026-09-01", "2026-09-02"],
      networkSearchCount: [3, 1],
      webReadMcpCount: [0, 2],
      zreadMcpCount: [0, 0],
    });
    expect(usage.tools.map((series) => series.name)).toEqual(["联网搜索", "网页阅读（MCP）"]);
    expect(usage.tools[0]).toMatchObject({ counts: [3, 1], total: 4 });
    expect(usage.totalCalls).toBe(6);
  });
});

describe("fetchGlmUsage", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("returns needs_config when the Coding Plan API Key is missing", async () => {
    mockInvoke.mockResolvedValueOnce(credentialStatus(false));
    const result = await fetchGlmUsage(glmInstance, 0, 1);
    expect(result).toMatchObject({ status: "needs_config" });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("fetches model and tool usage with encoded time window", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockImplementationOnce((_, args) => {
        const options = args as Record<string, unknown>;
        expect(options).toMatchObject({ instanceId: "glm", method: "GET", auth: "bearer" });
        expect(String(options.url)).toContain(
          "startTime=2026-09-01%2000%3A00%3A00&endTime=2026-09-02%2023%3A59%3A59",
        );
        return Promise.resolve(httpResult(loadModelUsage24h()));
      })
      .mockImplementationOnce((_, args) => {
        expect(String((args as Record<string, unknown>).url)).toContain("/tool-usage?");
        return Promise.resolve(httpResult(loadToolUsage()));
      });

    const startMs = new Date(2026, 8, 1).getTime();
    const endMs = new Date(2026, 8, 3).getTime();
    const result = await fetchGlmUsage(glmInstance, startMs, endMs);
    expect(result).toMatchObject({ status: "ok" });
    if (result.status === "ok") {
      expect(result.data.models.totals.tokens).toBe(2300000);
      expect(result.data.tools.totalCalls).toBe(0);
    }
  });

  it("fails when the model endpoint returns non-200", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(httpResult("boom", 500))
      .mockResolvedValueOnce(httpResult(loadToolUsage()));
    const result = await fetchGlmUsage(glmInstance, 0, 1);
    expect(result).toMatchObject({ status: "error", params: { status: 500 } });
    expect(result.status === "error" && result.message).toBe("智谱用量接口返回 HTTP {status}");
  });

  it("fails with server code/msg when success is false", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(httpResult({ code: 403, msg: "未开通 Coding Plan", success: false }))
      .mockResolvedValueOnce(httpResult(loadToolUsage()));
    const result = await fetchGlmUsage(glmInstance, 0, 1);
    expect(result).toMatchObject({ status: "error" });
    expect(result.status === "error" && result.params?.detail).toContain("未开通 Coding Plan");
  });

  it("degrades to empty tool data when the tool endpoint fails", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(httpResult(loadModelUsage24h()))
      .mockResolvedValueOnce(httpResult("missing", 404));
    const result = await fetchGlmUsage(glmInstance, 0, 1);
    expect(result).toMatchObject({ status: "ok" });
    if (result.status === "ok") {
      expect(result.data.tools.totalCalls).toBe(0);
      expect(result.data.tools.fixed).toEqual([]);
    }
  });

  it("returns error when the request rejects", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(httpResult(loadToolUsage()));
    const result = await fetchGlmUsage(glmInstance, 0, 1);
    expect(result).toMatchObject({ status: "error", params: { detail: "network down" } });
    expect(result.status === "error" && result.message).toBe("智谱用量查询失败：{detail}");
  });
});

describe("parseGlmAccountBalance / fetchGlmAccountBalance", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("parses the captured fixture into the account breakdown", () => {
    const json = loadBalance() as { data?: Parameters<typeof parseGlmAccountBalance>[0] };
    const balance = parseGlmAccountBalance(json.data);
    expect(balance).toMatchObject({
      balance: 42.75,
      availableBalance: 42.75,
      rechargeAmount: 30,
      giveAmount: 15.25,
      totalSpendAmount: 2.5,
      frozenBalance: 0,
      creditBalance: null,
    });
  });

  it("returns null when the payload has no usable balance", () => {
    expect(parseGlmAccountBalance(undefined)).toBeNull();
    expect(parseGlmAccountBalance({})).toBeNull();
    expect(parseGlmAccountBalance({ balance: null, availableBalance: null })).toBeNull();
  });

  it("fetches the balance detail with the Coding Plan API Key", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockImplementationOnce((_, args) => {
        const options = args as Record<string, unknown>;
        expect(options).toMatchObject({
          instanceId: "glm",
          url: "https://www.bigmodel.cn/api/biz/account/query-customer-account-report",
          method: "GET",
          auth: "bearer",
        });
        return Promise.resolve(httpResult(loadBalance()));
      });

    const result = await fetchGlmAccountBalance("glm");
    expect(result).toMatchObject({ status: "ok" });
    if (result.status === "ok") {
      expect(result.data.balance).toBeCloseTo(42.75, 6);
      expect(result.data.giveAmount).toBeCloseTo(15.25, 6);
    }
  });

  it("returns needs_config / error states distinctly", async () => {
    mockInvoke.mockResolvedValueOnce(credentialStatus(false));
    expect((await fetchGlmAccountBalance("glm")).status).toBe("needs_config");

    mockInvoke
      .mockReset()
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(httpResult({ code: 401, msg: "令牌已过期或验证不正确", success: false }));
    const failed = await fetchGlmAccountBalance("glm");
    expect(failed).toMatchObject({ status: "error" });
    expect(failed.status === "error" && failed.params?.detail).toContain("令牌已过期");
  });
});

describe("parseGlmResetCards / fetchGlmResetCards", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("infers per-card status from availability and expiry time", () => {
    const now = parseLocalDateTime("2026-09-05 12:00:00")!.getTime();
    const json = loadReset() as { data?: Parameters<typeof parseGlmResetCards>[0] };
    const list = parseGlmResetCards(json.data, now);
    // fixture 中三张 5h 卡全部过期（expireTime 均早于 now），周组为空
    expect(list.fiveHour.available).toBe(0);
    expect(list.fiveHour.items.map((item) => item.status)).toEqual(["expired", "expired", "expired"]);
    expect(list.week.items).toEqual([]);
  });

  it("marks unavailable cards that have not expired as used", () => {
    const now = parseLocalDateTime("2026-09-05 12:00:00")!.getTime();
    const list = parseGlmResetCards(
      {
        fiveHourResets: [
          { recordId: 1, expireTime: "2026-09-06 10:00:00", available: false },
          { recordId: 2, expireTime: "2026-09-06 11:00:00", available: true },
        ],
        weekResets: [],
      },
      now,
    );
    expect(list.fiveHour.items.map((item) => item.status)).toEqual(["available", "used"]);
    expect(list.fiveHour.available).toBe(1);
  });

  it("parses local datetime strings", () => {
    expect(parseLocalDateTime("2026-09-02 01:35:13")).toEqual(new Date(2026, 8, 2, 1, 35, 13));
    expect(parseLocalDateTime(null)).toBeNull();
    expect(parseLocalDateTime("not-a-date")).toBeNull();
  });

  it("sorts available cards first, then recently expired (official order)", () => {
    const now = parseLocalDateTime("2026-09-05 12:00:00")!.getTime();
    const list = parseGlmResetCards(
      {
        fiveHourResets: [
          { recordId: 1, expireTime: "2026-09-02 01:35:13", available: false },
          { recordId: 2, expireTime: "2026-09-06 01:33:59", available: true },
          { recordId: 3, expireTime: "2026-09-02 20:42:15", available: false },
        ],
        weekResets: [],
      },
      now,
    );
    // 可用卡置顶；过期卡按最近失效在前
    expect(list.fiveHour.items.map((item) => item.expireTime)).toEqual([
      "2026-09-06 01:33:59",
      "2026-09-02 20:42:15",
      "2026-09-02 01:35:13",
    ]);
  });

  it("fetches the reset card detail with the Coding Plan API Key", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockImplementationOnce((_, args) => {
        const options = args as Record<string, unknown>;
        expect(options).toMatchObject({
          instanceId: "glm",
          url: "https://www.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL",
          method: "GET",
          auth: "bearer",
        });
        return Promise.resolve(httpResult(loadReset()));
      });

    const result = await fetchGlmResetCards("glm");
    expect(result).toMatchObject({ status: "ok" });
    if (result.status === "ok") {
      expect(result.data.fiveHour.items).toHaveLength(3);
      expect(result.data.week.available).toBe(0);
    }
  });

  it("returns needs_config / error states distinctly", async () => {
    mockInvoke.mockResolvedValueOnce(credentialStatus(false));
    expect((await fetchGlmResetCards("glm")).status).toBe("needs_config");

    mockInvoke
      .mockReset()
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(httpResult({ code: 401, msg: "令牌已过期或验证不正确", success: false }));
    const failed = await fetchGlmResetCards("glm");
    expect(failed).toMatchObject({ status: "error" });
    expect(failed.status === "error" && failed.params?.detail).toContain("令牌已过期");
  });
});

describe("useGlmResetCard", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("posts the official payload with an idempotency requestId", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockImplementationOnce((_, args) => {
        const options = args as Record<string, unknown>;
        expect(options).toMatchObject({
          instanceId: "glm",
          url: "https://www.bigmodel.cn/api/biz/customer-package-reset/use",
          method: "POST",
          auth: "bearer",
        });
        const body = JSON.parse(String(options.bodyText));
        expect(body).toMatchObject({ targetType: "PERSONAL", resetType: "FIVE_HOUR", recordId: 900003 });
        expect(typeof body.requestId).toBe("string");
        expect(body.requestId).not.toBe("");
        return Promise.resolve(httpResult({ code: 200, msg: "操作成功", success: true }));
      });

    const result = await useGlmResetCard("glm", "FIVE_HOUR", 900003, "req-1");
    expect(result).toMatchObject({ status: "ok", data: true });
  });

  it("surfaces the server msg when success is false", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(
        httpResult({ code: 500, msg: "指定的重置次数不可用，请刷新后重试", success: false }),
      );

    const result = await useGlmResetCard("glm", "WEEK", 1, "req-2");
    expect(result).toMatchObject({ status: "error" });
    expect(result.status === "error" && result.params?.detail).toContain("指定的重置次数不可用");
  });

  it("surfaces the business msg even when the HTTP status is non-200 (2026-09-05 live shape)", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(
        httpResult({ code: 400, msg: "指定的重置次数不可用，请刷新后重试", data: null, success: false }, 400),
      );

    const result = await useGlmResetCard("glm", "FIVE_HOUR", 900003, "req-5");
    expect(result).toMatchObject({ status: "error" });
    expect(result.status === "error" && result.params?.detail).toBe("指定的重置次数不可用，请刷新后重试");
  });

  it("returns needs_config when the key is missing and error on HTTP failure", async () => {
    mockInvoke.mockResolvedValueOnce(credentialStatus(false));
    expect((await useGlmResetCard("glm", "WEEK", 1, "req-3")).status).toBe("needs_config");

    mockInvoke
      .mockReset()
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(httpResult("boom", 500));
    const failed = await useGlmResetCard("glm", "WEEK", 1, "req-4");
    expect(failed).toMatchObject({ status: "error", params: { status: 500 } });
  });
});
