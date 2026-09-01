import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult } from "../types/ipc";
import { glmProvider, parseFinanceBalance, parseQuotaLimits } from "./glm";
import type { GlmQuotaData } from "./glm";

const mockInvoke = vi.mocked(invoke);

const readFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const loadQuotaFixture = () => JSON.parse(readFixture("glm-quota.json"));
// 注意：未订阅形态未实测（测试账号已订阅 Lite），此 fixture 按代码容错分支构造
const loadUnsubscribedFixture = () => JSON.parse(readFixture("glm-quota-unsubscribed.json"));
const loadBalanceFixture = () => JSON.parse(readFixture("glm-finance-balance.json"));

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

const credentialStatus = (fields: { planKey?: boolean; webToken?: boolean }) => ({
  deepseekApiKey: false,
  deepseekUserToken: false,
  opencodeGoWorkspaceId: false,
  opencodeGoAuthCookie: false,
  opencodeGoApiKey: false,
  glmCodingPlanKey: fields.planKey ?? false,
  glmWebToken: fields.webToken ?? false,
});

describe("glmProvider.fetch", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("returns needs_config when both credentials are missing", async () => {
    mockInvoke.mockResolvedValueOnce(credentialStatus({}));

    const snapshot = await glmProvider.fetch();
    expect(snapshot.status).toBe("needs_config");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("parses quota and balance lines when both sources succeed", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true, webToken: true }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()))
      .mockResolvedValueOnce(httpResult(loadBalanceFixture()));

    const snapshot = await glmProvider.fetch();
    expect(snapshot.status).toBe("ok");
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.lines).toHaveLength(4);
    expect(snapshot.lines[0]).toMatchObject({ type: "badge", label: "套餐档位", value: "lite" });

    const [fiveHour, weekly] = snapshot.lines.slice(1);
    expect(fiveHour).toMatchObject({
      type: "progress",
      label: "5 小时请求配额",
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

    expect(snapshot.lines[3]).toMatchObject({ type: "text", label: "账户余额" });
    expect(snapshot.lines[3].value).toContain("1.76");

    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      "provider_request",
      expect.objectContaining({
        providerId: "glm",
        url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
        method: "GET",
        auth: "bearer",
      }),
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      3,
      "provider_request",
      expect.objectContaining({
        providerId: "glm-web",
        url: "https://www.bigmodel.cn/api/biz/account/query-customer-account-report",
        method: "GET",
        auth: "bearer",
      }),
    );
  });

  it("degrades to balance-only with a message when the plan is unsubscribed", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true, webToken: true }))
      .mockResolvedValueOnce(httpResult(loadUnsubscribedFixture()))
      .mockResolvedValueOnce(httpResult(loadBalanceFixture()));

    const snapshot = await glmProvider.fetch();
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]).toMatchObject({ type: "text", label: "账户余额" });
    expect(snapshot.message).toContain("403");
    expect(snapshot.message).toContain("未开通 Coding Plan");
  });

  it("returns quota-only lines without a web token and skips the balance request", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true, webToken: false }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()));

    const snapshot = await glmProvider.fetch();
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.lines.map((line) => line.label)).toEqual([
      "套餐档位",
      "5 小时请求配额",
      "每周请求配额",
    ]);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("returns error with server code/msg when all sources fail", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true, webToken: true }))
      .mockResolvedValueOnce(httpResult(loadUnsubscribedFixture()))
      .mockResolvedValueOnce(httpResult({ code: 401, msg: "token 已过期" }, 401));

    const snapshot = await glmProvider.fetch();
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("403");
    expect(snapshot.message).toContain("401");
    expect(snapshot.lines).toHaveLength(0);
  });

  it("stays ok when the balance request rejects", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true, webToken: true }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()))
      .mockRejectedValueOnce(new Error("network down"));

    const snapshot = await glmProvider.fetch();
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.message).toContain("余额查询失败");
    expect(snapshot.message).toContain("network down");
  });
});

describe("parseQuotaLimits", () => {
  it("parses the captured fixture", () => {
    const json = loadQuotaFixture() as { data?: GlmQuotaData };
    const lines = parseQuotaLimits(json.data);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "badge", value: "lite" });
    expect(lines[1]).toMatchObject({ label: "5 小时请求配额", used: 0, limit: 2000, percentUsed: 0 });
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
        { type: "TOKENS_LIMIT", percentage: 10 },
        { type: "CREDIT_LIMIT", unit: 9, number: 2, usage: 1 },
        // 无任何数值字段的窗口：无信息可渲染，忽略
        { type: "CREDIT_LIMIT", unit: 6 },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "badge", value: "pro" });
    expect(lines[1]).toMatchObject({ label: "5 小时请求配额", used: 600, limit: 1000 });
  });

  it("returns empty lines for missing data", () => {
    expect(parseQuotaLimits(undefined)).toEqual([]);
    expect(parseQuotaLimits({})).toEqual([]);
  });
});

describe("parseFinanceBalance", () => {
  it("parses the captured fixture balance", () => {
    const line = parseFinanceBalance(loadBalanceFixture());
    expect(line).toMatchObject({ type: "text", label: "账户余额" });
    expect(line?.value).toContain("1.76");
  });

  it("supports string amounts and the availableBalance fallback", () => {
    expect(parseFinanceBalance({ data: { balance: "12.5" } })?.value).toContain("12.5");
    expect(parseFinanceBalance({ data: { availableBalance: 3.2 } })?.value).toContain("3.2");
  });

  it("returns null when fields are missing or invalid", () => {
    expect(parseFinanceBalance({})).toBeNull();
    expect(parseFinanceBalance({ data: {} })).toBeNull();
    expect(parseFinanceBalance({ data: { balance: null } })).toBeNull();
    expect(parseFinanceBalance({ data: { balance: "abc" } })).toBeNull();
  });
});
