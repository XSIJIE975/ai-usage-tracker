import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult } from "../types/ipc";
import { glmProvider, countAvailableResets, parseBalanceLine, parseGlmBalance, parseQuotaLimits, parseResetLine } from "./glm";
import type { GlmBalanceData, GlmQuotaData } from "./glm";
import type { ProviderInstance } from "../types/ipc";

const mockInvoke = vi.mocked(invoke);

const readFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const loadQuotaFixture = () => JSON.parse(readFixture("glm-quota.json"));
const loadBalanceFixture = () => JSON.parse(readFixture("glm-balance.json"));
const loadResetFixture = () => JSON.parse(readFixture("glm-package-reset.json"));
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
  balanceThreshold: null,
  createdAt: 0,
};

const credentialStatus = (fields: { planKey?: boolean }) => ({ planKey: fields.planKey ?? false });

/** 双源取数的调用次序：配额 → 余额 → 重置卡（mock 队列按此顺序入队） */
const mockHappyPath = () => {
  mockInvoke
    .mockResolvedValueOnce(credentialStatus({ planKey: true }))
    .mockResolvedValueOnce(httpResult(loadQuotaFixture()))
    .mockResolvedValueOnce(httpResult(loadBalanceFixture()))
    .mockResolvedValueOnce(httpResult(availableResetCard()));
};

const availableResetCard = () => ({
  code: 200,
  msg: "操作成功",
  success: true,
  data: {
    fiveHourResets: [{ recordId: 1, expireTime: "2026-09-30 10:00:00", available: true }],
    weekResets: [{ recordId: 2, expireTime: "2026-10-01 10:00:00", available: true }],
  },
});

const emptyResetPayload = () => ({
  code: 200,
  msg: "操作成功",
  success: true,
  data: { fiveHourResets: [], weekResets: [] },
});

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

  it("parses quota lines plus the balance text line from parallel sources", async () => {
    mockHappyPath();

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.lines).toHaveLength(5);
    expect(snapshot.lines[0]).toMatchObject({ type: "badge", label: "套餐档位", value: "Lite" });

    const [fiveHour, weekly] = snapshot.lines.slice(1);
    expect(fiveHour).toMatchObject({
      type: "progress",
      label: "{hours} 小时请求配额",
      params: { hours: 5 },
      used: 0,
      limit: 1200,
      percentUsed: 0,
    });
    expect(fiveHour.resetsAt).toBeUndefined();
    expect(weekly).toMatchObject({
      type: "progress",
      label: "每周请求配额",
      used: 1080,
      limit: 1200,
      percentUsed: 90,
    });
    expect(weekly.resetsAt).toBe(new Date(1788362308998).toISOString());
    expect(snapshot.lines[3]).toMatchObject({ type: "text", label: "账户余额" });
    expect((snapshot.lines[3] as { value?: string }).value).toMatch(/¥42\.75/);
    expect(snapshot.lines[4]).toMatchObject({
      type: "text",
      label: "可用重置卡",
      value: "5 小时 ×1 · 周 ×1",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(4);
    expect(mockInvoke).toHaveBeenNthCalledWith(
      3,
      "provider_request",
      expect.objectContaining({
        instanceId: "glm",
        url: "https://www.bigmodel.cn/api/biz/account/query-customer-account-report",
        method: "GET",
        auth: "bearer",
      }),
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      4,
      "provider_request",
      expect.objectContaining({
        instanceId: "glm",
        url: "https://www.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL",
        method: "GET",
        auth: "bearer",
      }),
    );
  });

  it("renders no reset-card line and no message when no card is available", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()))
      .mockResolvedValueOnce(httpResult(loadBalanceFixture()))
      .mockResolvedValueOnce(httpResult(loadResetFixture()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.lines).toHaveLength(4);
    expect(snapshot.lines.some((line) => line.label === "可用重置卡")).toBe(false);
  });

  it("degrades to ok with a message when only the balance source fails", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()))
      .mockResolvedValueOnce(httpResult("unauthorized", 401))
      .mockResolvedValueOnce(httpResult(emptyResetPayload()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.message).toBe("账户余额接口返回 HTTP {status}{detail}");
    expect(snapshot.messageParams).toMatchObject({ status: 401 });
  });

  it("degrades to ok with a message when the reset-card source fails", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()))
      .mockResolvedValueOnce(httpResult(loadBalanceFixture()))
      .mockResolvedValueOnce(httpResult({ code: 401, msg: "令牌已过期或验证不正确", success: false }));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(4);
    expect(snapshot.message).toBe("重置卡查询失败：{detail}");
    expect(snapshot.messageParams).toMatchObject({ detail: "code=401 msg=令牌已过期或验证不正确" });
  });

  it("degrades to ok with a message when the balance request rejects", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(httpResult(emptyResetPayload()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.message).toBe("账户余额查询失败：{detail}");
    expect(snapshot.messageParams).toMatchObject({ detail: "network down" });
  });

  it("keeps ok and reports the quota failure when the balance source still works", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult("unauthorized", 401))
      .mockResolvedValueOnce(httpResult(loadBalanceFixture()))
      .mockResolvedValueOnce(httpResult(emptyResetPayload()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]).toMatchObject({ type: "text", label: "账户余额" });
    expect(snapshot.message).toBe("Coding Plan 配额接口返回 HTTP {status}{detail}");
    expect(snapshot.messageParams).toMatchObject({ status: 401 });
  });

  it("hides the balance line but stays ok when the balance payload has no amount", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult(loadQuotaFixture()))
      .mockResolvedValueOnce(httpResult({ code: 200, msg: "操作成功", data: {}, success: true }))
      .mockResolvedValueOnce(httpResult(emptyResetPayload()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.message).toBe("账户余额接口未返回可用数据");
  });

  it("reports a joined error when all three sources fail", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult("unauthorized", 401))
      .mockResolvedValueOnce(httpResult({ code: 401, msg: "令牌已过期或验证不正确", success: false }))
      .mockRejectedValueOnce(new Error("network down"));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.lines).toHaveLength(0);
    expect(snapshot.message).toContain("Coding Plan 配额接口返回 HTTP 401：unauthorized");
    expect(snapshot.message).toContain("账户余额查询失败：code=401 msg=令牌已过期或验证不正确");
    expect(snapshot.message).toContain("重置卡查询失败：network down");
  });

  it("keeps ok and reports the quota unsubscribed reason when the balance source still works", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(httpResult(loadUnsubscribedFixture()))
      .mockResolvedValueOnce(httpResult(loadBalanceFixture()))
      .mockResolvedValueOnce(httpResult(emptyResetPayload()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.message).toBe("Coding Plan 配额查询失败：{detail}");
    expect(snapshot.messageParams?.detail).toContain("403");
    expect(snapshot.messageParams?.detail).toContain("未开通 Coding Plan");
  });

  it("reports unrecognized quota window types instead of claiming the plan is unsubscribed", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockResolvedValueOnce(
        httpResult({ code: 200, success: true, data: { level: "lite", limits: [{ type: "FUTURE_LIMIT" }] } }),
      )
      .mockResolvedValueOnce(httpResult(loadBalanceFixture()))
      .mockResolvedValueOnce(httpResult(emptyResetPayload()));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.message).toContain("未识别的窗口类型");
  });

  it("returns a joined error when the quota and balance requests reject", async () => {
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ planKey: true }))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(httpResult({ code: 401, success: false }))
      .mockRejectedValueOnce(new Error("dns failure"));

    const snapshot = await glmProvider.fetch(glmInstance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("Coding Plan 配额查询失败：network down");
    expect(snapshot.message).toContain("重置卡查询失败：dns failure");
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
      limit: 1200,
      percentUsed: 0,
    });
    expect(lines[2]).toMatchObject({
      label: "每周请求配额",
      used: 1080,
      limit: 1200,
      percentUsed: 90,
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

describe("parseBalanceLine / parseGlmBalance", () => {
  it("parses the captured fixture into a CNY text line", () => {
    const json = loadBalanceFixture() as { data?: GlmBalanceData };
    const line = parseBalanceLine(json.data);
    expect(line).toMatchObject({ type: "text", label: "账户余额" });
    expect(line?.value).toMatch(/¥42\.75/);
    expect(parseGlmBalance(json.data)).toBeCloseTo(42.75, 6);
  });

  it("falls back to availableBalance when balance is missing", () => {
    expect(parseGlmBalance({ availableBalance: "12.5" })).toBe(12.5);
    expect(parseBalanceLine({ availableBalance: "12.5" })?.value).toMatch(/¥12\.50/);
  });

  it("returns null for missing or non-numeric amounts", () => {
    expect(parseBalanceLine(undefined)).toBeNull();
    expect(parseBalanceLine({})).toBeNull();
    expect(parseBalanceLine({ balance: null })).toBeNull();
    expect(parseBalanceLine({ balance: "abc" })).toBeNull();
    expect(parseGlmBalance({ balance: "abc" })).toBeNull();
  });
});

describe("parseResetLine / countAvailableResets", () => {
  it("counts only available cards per window", () => {
    const data = (loadResetFixture().data ?? {}) as NonNullable<Parameters<typeof parseResetLine>[0]>;
    expect(countAvailableResets(data.fiveHourResets)).toBe(0);
    expect(countAvailableResets(data.weekResets)).toBe(0);
    expect(parseResetLine(data)).toBeNull();
  });

  it("renders one line with per-window counts when any card is available", () => {
    const line = parseResetLine({
      fiveHourResets: [
        { recordId: 1, expireTime: "2026-09-30 10:00:00", available: true },
        { recordId: 2, expireTime: "2026-09-29 10:00:00", available: false },
      ],
      weekResets: [{ recordId: 3, expireTime: "2026-10-01 10:00:00", available: true }],
    });
    expect(line).toMatchObject({ type: "text", label: "可用重置卡", value: "5 小时 ×1 · 周 ×1" });
  });

  it("hides the five-hour part when only weekly cards are available", () => {
    const line = parseResetLine({
      fiveHourResets: [{ recordId: 1, expireTime: "2026-09-30 10:00:00", available: false }],
      weekResets: [{ recordId: 3, expireTime: "2026-10-01 10:00:00", available: true }],
    });
    expect(line?.value).toBe("周 ×1");
    expect(parseResetLine(undefined)).toBeNull();
    expect(parseResetLine({})).toBeNull();
  });
});
