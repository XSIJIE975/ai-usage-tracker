import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult } from "../types/ipc";
import { glmProvider, parseQuotaLimits } from "./glm";
import type { GlmQuotaData } from "./glm";
import type { ProviderInstance } from "../types/ipc";

const mockInvoke = vi.mocked(invoke);

const readFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const loadQuotaFixture = () => JSON.parse(readFixture("glm-quota.json"));
// 注意：未订阅形态未实测（测试账号已订阅 Lite），此 fixture 按代码容错分支构造
const loadUnsubscribedFixture = () => JSON.parse(readFixture("glm-quota-unsubscribed.json"));

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

const credentialStatus = (fields: { planKey?: boolean }) => ({ planKey: fields.planKey ?? false });

describe("glmProvider.fetch", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("returns needs_config when the Coding Plan API Key is missing", async () => {
    mockInvoke.mockResolvedValueOnce(credentialStatus({}));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("needs_config");
    expect(snapshot.message).toContain("Coding Plan API Key");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("parses quota lines with a single Coding Plan API Key request", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.lines[0]).toMatchObject({ type: "badge", label: "套餐档位", value: "Lite" });

    const [fiveHour, weekly] = snapshot.lines.slice(1);
    expect(fiveHour).toMatchObject({
      type: "progress",
      label: "{hours} 小时请求配额",
      params: { hours: 5 },
      used: 0,
      limit: 2000,
      percentUsed: 0,
    });
    expect(fiveHour.resetsAt).toBeUndefined();
    expect(weekly).toMatchObject({
      type: "progress",
      label: "每周请求配额",
      used: 1994,
      limit: 2000,
      percentUsed: 99,
    });
    expect(weekly.resetsAt).toBe(new Date(1788362308998).toISOString());

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenLastCalledWith(
      "provider_request",
      expect.objectContaining({
        instanceId: "glm",
        url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
        method: "GET",
        auth: "bearer",
      }),
    );
  });

  it("returns error with server code/msg when the plan is unsubscribed", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult(loadUnsubscribedFixture()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.lines).toHaveLength(0);
    expect(snapshot.message).toContain("403");
    expect(snapshot.message).toContain("未开通 Coding Plan");
  });

  it("reports unrecognized window types instead of claiming the plan is unsubscribed", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(
        httpResult({ code: 200, success: true, data: { level: "lite", limits: [{ type: "FUTURE_LIMIT" }] } }),
      );

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("未识别的窗口类型");
  });

  it("returns error with the HTTP status when the API responds non-200", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult("unauthorized", 401));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("401");
  });

  it("returns error when the request rejects", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockRejectedValueOnce(new Error("network down"));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("network down");
  });
});

describe("parseQuotaLimits", () => {
  it("parses the captured fixture", () => {
    const json = loadQuotaFixture() as { data?: GlmQuotaData };
    const lines = parseQuotaLimits(json.data);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "badge", value: "Lite" });
    expect(lines[1]).toMatchObject({
      label: "{hours} 小时请求配额",
      params: { hours: 5 },
      used: 0,
      limit: 2000,
      percentUsed: 0,
    });
    expect(lines[2]).toMatchObject({
      label: "每周请求配额",
      used: 1994,
      limit: 2000,
      percentUsed: 99,
      resetsAt: new Date(1788362308998).toISOString(),
    });
  });

  it("falls back to usage-remaining and ignores unknown types/units", () => {
    const lines = parseQuotaLimits({
      level: "pro",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 1000, remaining: 400 },
        { type: "FUTURE_LIMIT", percentage: 10 },
        { type: "CREDIT_LIMIT", unit: 9, number: 2, usage: 1 },
        // 无任何数值字段的窗口：无信息可渲染，忽略
        { type: "CREDIT_LIMIT", unit: 6 },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "badge", value: "Pro" });
    expect(lines[1]).toMatchObject({ label: "{hours} 小时请求配额", used: 600, limit: 1000 });
  });

  it("recognizes the international TOKENS_LIMIT / TIME_LIMIT vocabulary", () => {
    const lines = parseQuotaLimits({
      level: "max",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12, nextResetTime: 1788362308998 },
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 6, percentage: 6 },
      ],
    });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({
      label: "{hours} 小时 Token 配额",
      params: { hours: 5 },
      percentUsed: 12,
      resetsAt: new Date(1788362308998).toISOString(),
    });
    expect(lines[2]).toMatchObject({ label: "MCP 月度用量", used: 6, limit: 100, percentUsed: 6 });
  });

  it("defaults the hour window to 5 when number is missing", () => {
    const lines = parseQuotaLimits({
      limits: [{ type: "TOKENS_LIMIT", percentage: 3 }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ label: "{hours} 小时 Token 配额", params: { hours: 5 } });
  });

  it("returns empty lines for missing data", () => {
    expect(parseQuotaLimits(undefined)).toEqual([]);
    expect(parseQuotaLimits({})).toEqual([]);
  });
});
