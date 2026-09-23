import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance, ProviderSnapshot } from "../types/ipc";
import {
  isValidSessionCookieValue,
  parseNextReset,
  parseQuotaSummary,
  parseUsageData,
  parseUsageLines,
  processUsageResult,
  qoderProvider,
  qoderSiteOf,
  qoderUsageHeaders,
  qoderUsageUrl,
  SESSION_COOKIE_NAME,
} from "./qoder";
import type { QoderUsageData } from "./qoder";

const mockInvoke = vi.mocked(invoke);

const readFixture = (name: string): QoderUsageData =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")) as QoderUsageData;

/** 构造带模型未声明字段（如接口下发的 usagePercentage）的响应 */
const asUsageData = (value: unknown): QoderUsageData => value as QoderUsageData;

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

const makeInstance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "qoder-1",
  providerId: "qoder",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
  balanceThreshold: null,
  site: "china",
  createdAt: 0,
  ...overrides,
});

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("parseQuotaSummary", () => {
  it("reads camelCase and snake_case keys", () => {
    expect(parseQuotaSummary({ usedValue: 5, limitValue: 10 })).toEqual({
      usedValue: 5,
      limitValue: 10,
      remainingValue: null,
    });
    expect(parseQuotaSummary({ used_value: 5, limit_value: 10, remaining_value: 5 })).toEqual({
      usedValue: 5,
      limitValue: 10,
      remainingValue: 5,
    });
  });

  it("rejects missing, non-finite, and negative values", () => {
    expect(parseQuotaSummary(undefined)).toBeNull();
    expect(parseQuotaSummary({ usedValue: 5 })).toBeNull();
    expect(parseQuotaSummary({ usedValue: "5", limitValue: 10 })).toBeNull();
    expect(parseQuotaSummary({ usedValue: -1, limitValue: 10 })).toBeNull();
  });
});

describe("parseUsageData", () => {
  it("parses the camelCase fixture with provided remaining and ISO reset", () => {
    const usage = parseUsageData(readFixture("qoder-usage.json"));
    expect(usage).not.toBeNull();
    expect(usage!.used).toBe(412.5);
    expect(usage!.total).toBe(1500);
    expect(usage!.remaining).toBe(1087.5);
    // 接口没下发 usage_percentage 也照样按 used/total 算
    expect(usage!.percent).toBeCloseTo(27.5);
    expect(usage!.resetsAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("folds shared quota into totals and recomputes the percentage (CodexBar 口径)", () => {
    const usage = parseUsageData(readFixture("qoder-usage-shared.json"));
    expect(usage).not.toBeNull();
    expect(usage!.used).toBe(1700);
    expect(usage!.total).toBe(2500);
    expect(usage!.remaining).toBe(800);
    //  fixture 里下发的 usage_percentage=80 是个位配额窗口的比例，合并后按 1700/2500 算
    expect(usage!.percent).toBeCloseTo(68);
    // snake_case 的秒级 epoch 重置时刻
    expect(usage!.resetsAt?.toISOString()).toBe("2026-06-02T08:00:00.000Z");
  });

  it("computes the percentage from used/total even when the API supplies one", () => {
    // 下发值的量纲（0~100 还是 0~1）没有真机数据可证，一律不用（ADR-0030 真机校准项）
    const usage = parseUsageData(
      asUsageData({
        totalQuota: {
          quotaSummary: { usedValue: 300, limitValue: 1200, usagePercentage: 0.25, unit: "credits" },
        },
      }),
    );
    expect(usage?.percent).toBeCloseTo(25);
  });

  it("treats zero total with zero usage as exhausted (100%)", () => {
    const usage = parseUsageData({ totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0 } } });
    expect(usage?.percent).toBe(100);
    expect(usage?.resetsAt).toBeNull();
  });

  it("treats zero total across both quotas as exhausted, not a parse failure", () => {
    const usage = parseUsageData({
      totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0 } },
      sharedQuota: { quotaSummary: { usedValue: 0, limitValue: 0 } },
    });
    expect(usage?.percent).toBe(100);
    expect(usage?.total).toBe(0);
  });

  it("rejects zero total with nonzero usage and broken structures", () => {
    expect(parseUsageData({ totalQuota: { quotaSummary: { usedValue: 3, limitValue: 0 } } })).toBeNull();
    expect(
      parseUsageData({
        totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0 } },
        sharedQuota: { quotaSummary: { usedValue: 3, limitValue: 0 } },
      }),
    ).toBeNull();
    expect(parseUsageData(undefined)).toBeNull();
    expect(parseUsageData({} as QoderUsageData)).toBeNull();
    expect(parseUsageData({ totalQuota: {} })).toBeNull();
  });

  it("derives remaining from limit - used when the API omits it", () => {
    const usage = parseUsageData({ totalQuota: { quotaSummary: { usedValue: 300, limitValue: 1200 } } });
    expect(usage?.remaining).toBe(900);
  });
});

describe("parseNextReset", () => {
  it("accepts ISO strings and second/millisecond epochs", () => {
    expect(parseNextReset("2026-06-02T08:00:00Z")?.toISOString()).toBe("2026-06-02T08:00:00.000Z");
    expect(parseNextReset(1780387200)?.toISOString()).toBe("2026-06-02T08:00:00.000Z");
    expect(parseNextReset(1_780_387_200_000)?.toISOString()).toBe("2026-06-02T08:00:00.000Z");
  });

  it("returns null for empty and malformed input", () => {
    expect(parseNextReset(undefined)).toBeNull();
    expect(parseNextReset("")).toBeNull();
    expect(parseNextReset("not-a-date")).toBeNull();
    expect(parseNextReset(0)).toBeNull();
  });
});

describe("parseUsageLines", () => {
  it("maps usage into a single balance-marked progress line", () => {
    const [line] = parseUsageLines({
      used: 412.5,
      total: 1500,
      remaining: 1087.5,
      percent: 27.5,
      resetsAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(line.type).toBe("progress");
    expect(line.label).toBe("积分余量");
    expect(line.used).toBe(412.5);
    expect(line.limit).toBe(1500);
    expect(line.percentUsed).toBeCloseTo(27.5);
    expect(line.balance).toBe(true);
    expect(line.value).toBe("1,088");
    expect(line.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("clamps percentages into [0, 100] and omits absent resets", () => {
    const [line] = parseUsageLines({ used: 5, total: 5, remaining: 0, percent: 130, resetsAt: null });
    expect(line.percentUsed).toBe(100);
    expect(line.resetsAt).toBeUndefined();
  });
});

describe("processUsageResult", () => {
  it("maps 401/403 and login-page HTML to the re-paste message", () => {
    for (const result of [
      httpResult("unauthorized", 401),
      httpResult("forbidden", 403),
      httpResult("<html><body>login</body></html>", 200),
    ]) {
      const outcome = processUsageResult(result);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBe("Qoder 登录凭据无效或已过期，请在设置中重新粘贴 qoder_session_cookie 的值");
    }
  });

  it("maps non-200 statuses to a templated HTTP error", () => {
    const outcome = processUsageResult(httpResult("boom", 502));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("积分接口返回 HTTP {status}{detail}");
    expect(outcome.errorParams).toEqual({ status: 502, detail: "：boom" });
  });

  it("maps broken JSON and missing structures to parse failures", () => {
    const badJson = processUsageResult(httpResult("not-json", 200));
    expect(badJson.ok).toBe(false);
    expect(badJson.error).toBe("积分接口返回数据解析失败：{detail}");

    const missing = processUsageResult(httpResult({ foo: 1 }, 200));
    expect(missing.ok).toBe(false);
    expect(missing.errorParams?.detail).toBe("quota_summary 结构缺失");
  });

  it("passes a valid payload through to usage lines", () => {
    const outcome = processUsageResult(httpResult(readFixture("qoder-usage.json")));
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.lines[0].type).toBe("progress");
  });
});

describe("site selection", () => {
  it("defaults unknown sites to china and honors international", () => {
    expect(qoderSiteOf({ site: "china" })).toBe("china");
    expect(qoderSiteOf({ site: "international" })).toBe("international");
    expect(qoderSiteOf({ site: undefined as unknown as ProviderInstance["site"] })).toBe("china");
  });

  it("switches URL and static headers per site (Bx-V 固定 2.5.35)", () => {
    expect(qoderUsageUrl("china")).toBe("https://qoder.com.cn/api/v2/me/usages/big_model_credits");
    expect(qoderUsageUrl("international")).toBe("https://qoder.com/api/v2/me/usages/big_model_credits");

    const china = qoderUsageHeaders("china");
    expect(china.Origin).toBe("https://qoder.com.cn");
    expect(china.Referer).toBe("https://qoder.com.cn/account/usage");
    expect(china["Bx-V"]).toBe("2.5.35");

    const intl = qoderUsageHeaders("international");
    expect(intl.Origin).toBe("https://qoder.com");
    expect(intl.Referer).toBe("https://qoder.com/account/usage");
  });
});

describe("session cookie value validation", () => {
  it("接受单个 Cookie 的值本体（base64 padding 与 JWT 形态都不误伤）", () => {
    expect(isValidSessionCookieValue("AbC123_x-y==")).toBe(true);
    expect(isValidSessionCookieValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.9dpJFQ")).toBe(true);
    expect(isValidSessionCookieValue("k7Qx2mZp|1790000000|-_ab12CD==")).toBe(true);
  });

  it("拒整段 Cookie 头、连键名一起贴、以及 cookie-value 之外的字符", () => {
    // 三类误输入都直接报错让用户改，不剥前缀不抠字段（存的就是贴的那段值）
    expect(isValidSessionCookieValue(`${SESSION_COOKIE_NAME}=abc`)).toBe(false);
    expect(isValidSessionCookieValue("Cookie: qoder_session_cookie=abc")).toBe(false);
    expect(isValidSessionCookieValue("qoder_session_cookie=abc; theme=dark")).toBe(false);
    expect(isValidSessionCookieValue("abc; def")).toBe(false);
    expect(isValidSessionCookieValue("abc def")).toBe(false);
    expect(isValidSessionCookieValue("abc\ndef")).toBe(false);
    expect(isValidSessionCookieValue("abc,def")).toBe(false);
    expect(isValidSessionCookieValue('abc"def')).toBe(false);
    expect(isValidSessionCookieValue("会 话")).toBe(false);
    expect(isValidSessionCookieValue("")).toBe(false);
  });
});

describe("fetchQoderSnapshot", () => {
  it("reports needs_config without the cookie slot", async () => {
    mockInvoke.mockResolvedValue({});
    const snapshot = await qoderProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("needs_config");
    expect(snapshot.message).toBe("请在设置中粘贴 Qoder 会话 Cookie（qoder_session_cookie）的值");
  });

  it("requests the site URL via the qoder_cookie channel and maps the payload", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult(readFixture("qoder-usage.json")));
    const snapshot: ProviderSnapshot = await qoderProvider.fetch(
      makeInstance({ site: "international" }),
    );

    expect(snapshot.status).toBe("ok");
    expect(snapshot.providerId).toBe("qoder");
    expect(snapshot.lines).toHaveLength(1);

    expect(mockInvoke.mock.calls[1]?.[0]).toBe("provider_request");
    const options = (mockInvoke.mock.calls[1]?.[1] ?? {}) as Record<string, unknown>;
    expect(options.auth).toBe("qoder_cookie");
    expect(options.credentialSlot).toBe("cookie");
    expect(options.url).toBe("https://qoder.com/api/v2/me/usages/big_model_credits");
    expect((options.headers as Record<string, string>).Origin).toBe("https://qoder.com");
  });

  it("maps request failures to error snapshots", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockRejectedValueOnce(new Error("network down"));
    const snapshot = await qoderProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("积分接口查询失败：{detail}");
    expect(snapshot.messageParams?.detail).toBe("network down");
  });

  it("propagates credential errors from the usage endpoint", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult("denied", 403));
    const snapshot = await qoderProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("Qoder 登录凭据无效或已过期，请在设置中重新粘贴 qoder_session_cookie 的值");
  });
});
