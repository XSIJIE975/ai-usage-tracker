import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance } from "../types/ipc";
import { buildGlmUsageQuery, fetchGlmUsage, parseModelUsage, parseToolUsage } from "./glm-stats";

const mockInvoke = vi.mocked(invoke);

const readFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const loadModelUsage24h = () => JSON.parse(readFixture("glm-model-usage-24h.json"));
const loadModelUsage30d = () => JSON.parse(readFixture("glm-model-usage-30d.json"));
const loadToolUsage = () => JSON.parse(readFixture("glm-tool-usage.json"));

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
    expect(usage.totals).toEqual({ calls: 739, tokens: 135110104 });
    // 按 Token 合计降序：Flash(82910138) 在 5.3(52199966) 前
    expect(usage.models.map((model) => model.name)).toEqual(["GLM-5.3-Flash", "GLM-5.3"]);
    expect(usage.models[0]).toMatchObject({ totalTokens: 82910138 });
    expect(usage.models[0].tokens).toHaveLength(25);
  });

  it("parses the captured 30d fixture (daily granularity)", () => {
    const json = loadModelUsage30d();
    const usage = parseModelUsage(json.data);
    expect(usage.buckets).toHaveLength(31);
    expect(usage.granularity).toBe("daily");
    expect(usage.totals).toEqual({ calls: 1122, tokens: 191798998 });
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
    expect(usage.fixed.map((series) => series.name)).toEqual(["联网搜索", "网页阅读（MCP）", "Zread（MCP）"]);
    expect(usage.fixed.every((series) => series.total === 0)).toBe(true);
    expect(usage.tools).toEqual([]);
    expect(usage.totalCalls).toBe(0);
  });

  it("parses dynamic toolDataList entries and skips unnamed ones", () => {
    const usage = parseToolUsage({
      x_time: ["2026-09-01", "2026-09-02"],
      networkSearchCount: [3, 1],
      toolDataList: [
        { toolName: "search-mcp", count: [2, 2], totalCount: 4 },
        { count: [1, 1] },
      ],
    });
    expect(usage.fixed[0]).toMatchObject({ name: "联网搜索", counts: [3, 1], total: 4 });
    expect(usage.tools).toEqual([{ name: "search-mcp", counts: [2, 2], total: 4 }]);
    expect(usage.totalCalls).toBe(8);
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
      expect(result.data.models.totals.tokens).toBe(135110104);
      expect(result.data.tools.totalCalls).toBe(0);
    }
  });

  it("fails when the model endpoint returns non-200", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(httpResult("boom", 500))
      .mockResolvedValueOnce(httpResult(loadToolUsage()));
    const result = await fetchGlmUsage(glmInstance, 0, 1);
    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("500") });
  });

  it("fails with server code/msg when success is false", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus(true))
      .mockResolvedValueOnce(httpResult({ code: 403, msg: "未开通 Coding Plan", success: false }))
      .mockResolvedValueOnce(httpResult(loadToolUsage()));
    const result = await fetchGlmUsage(glmInstance, 0, 1);
    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("未开通 Coding Plan") });
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
    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("network down") });
  });
});
