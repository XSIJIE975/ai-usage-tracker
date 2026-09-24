import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance, ProviderSnapshot } from "../types/ipc";
import { primaryProgressLine } from "../alerts/metric";
import {
  isValidSessionCookieValue,
  parseNextReset,
  parseQuotaSummary,
  parseUsageLines,
  parseUsageView,
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

describe("parseUsageView", () => {
  /** 显式「现在」：两份合成 fixture 的重置时刻（2026-06-02 / 2026-10-01）都要在它之后，
   *  否则未来的重置会被「只认未来」这条规则判掉，测试随日历腐烂 */
  const NOW = Date.parse("2026-05-01T00:00:00Z");
  /** china fixture 的采集日（真机 2026-09-24），nextResetAt 2026-09-26 相对它才是未来 */
  const CHINA_NOW = Date.parse("2026-09-24T06:00:00Z");

  it("parses the camelCase fixture with provided remaining and ISO reset", () => {
    const view = parseUsageView(readFixture("qoder-usage.json"), NOW);
    expect(view).not.toBeNull();
    expect(view!.aggregate).toMatchObject({ used: 412.5, total: 1500, remaining: 1087.5 });
    // 接口没下发 usage_percentage 也照样按 used/total 算
    expect(view!.aggregate.percent).toBeCloseTo(27.5);
    expect(view!.resetsAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // 老形态只给 total_quota，没有分容器 → 不拆窗（真机两站都会给，见 china/trial fixture）
    expect(view!.windows).toEqual([]);
  });

  it("reads the snake_case container and the second-epoch reset", () => {
    const view = parseUsageView(
      asUsageData({
        total_quota: { quota_summary: { used_value: 1700, limit_value: 2500, remaining_value: 800 } },
        next_reset_at: 1780387200,
      }),
      NOW,
    );
    expect(view!.aggregate).toMatchObject({ used: 1700, total: 2500, remaining: 800 });
    expect(view!.resetsAt?.toISOString()).toBe("2026-06-02T08:00:00.000Z");
  });

  it("drops a reset moment that has already passed", () => {
    // 真机样本里未分配积分账号的 nextResetAt 停在八个月前，照挂就是永远显示一个
    // 已经过去的「重置」时刻（相对口径更会写成「即将重置」）
    const view = parseUsageView(readFixture("qoder-usage.json"), Date.parse("2026-11-01T00:00:00Z"));
    expect(view!.resetsAt).toBeNull();
    expect(view!.aggregate.percent).toBeCloseTo(27.5); // 用量本身不受影响
  });

  it("computes percentages from used/total even when the API supplies one", () => {
    // 下发值是向上取整的整数（真机 2534/3200 下发 80），本地算才留得住精度（ADR-0030 §4）。
    // 这里故意给一个与真实比例不同的下发值，证明它进不了模型（汇总位与分容器都要证）
    const view = parseUsageView(
      asUsageData({
        totalQuota: {
          quotaSummary: { usedValue: 300, limitValue: 1200, usagePercentage: 100, unit: "credits" },
        },
        plan_quota: {
          quota_summary: { used_value: 200, limit_value: 1000, usage_percentage: 40, unit: "credits" },
        },
      }),
    );
    expect(view?.aggregate.percent).toBeCloseTo(25);
    expect(view?.windows[0].percent).toBeCloseTo(20);
  });

  it("treats zero total as no quota, not as exhausted", () => {
    // 体验版账号即如此（2026-09-24 真机）：真用满会回 used=limit>0，百分比自然到 100
    const view = parseUsageView({ totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0 } } }, NOW);
    expect(view!.aggregate).toMatchObject({ total: 0, percent: 0 });
    expect(view!.resetsAt).toBeNull();
  });

  it("drops the reset countdown along with the zero quota", () => {
    // 重置时刻用的是未来的值，好让这条断言只由「零总量」决定，而不是上面那条过期规则
    const view = parseUsageView(
      {
        totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0 } },
        nextResetAt: "2026-10-06T14:15:00Z",
      },
      NOW,
    );
    expect(view?.resetsAt).toBeNull();
  });

  it("rejects zero total with nonzero usage and broken structures", () => {
    expect(parseUsageView({ totalQuota: { quotaSummary: { usedValue: 3, limitValue: 0 } } })).toBeNull();
    // 零总量却还有余量同样是矛盾数据（CodexBar 插件的判定覆盖 used 与 remaining 两项）
    expect(
      parseUsageView({ totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0, remainingValue: 500 } } }),
    ).toBeNull();
    expect(parseUsageView(undefined)).toBeNull();
    expect(parseUsageView({} as QoderUsageData)).toBeNull();
    expect(parseUsageView({ totalQuota: {} })).toBeNull();
  });

  it("rejects a container whose summary is malformed instead of dropping it", () => {
    // 分容器结构坏了不能当「这个容器没分配」——那会把有额度的号读成零额度
    expect(
      parseUsageView({
        totalQuota: { quotaSummary: { usedValue: 0, limitValue: 1000 } },
        plan_quota: { quota_summary: { used_value: "lots", limit_value: 1000 } },
      }),
    ).toBeNull();
  });

  it("skips containers with nothing allocated and keeps the rest", () => {
    const view = parseUsageView(
      asUsageData({
        plan_quota: { quota_summary: { used_value: 0, limit_value: 0, remaining_value: 0 } },
        resource_package_quota: { quota_summary: { used_value: 20, limit_value: 100, remaining_value: 80 } },
        total_quota: { quota_summary: { used_value: 20, limit_value: 100, remaining_value: 80 } },
      }),
      NOW,
    );
    expect(view!.windows.map((window) => window.key)).toEqual(["package"]);
  });

  it("parses the real paid China-site response into per-container windows", () => {
    // fixture 是真机响应（账号标识打码、quota_detail 从 8 条资源包裁到 2 条代表项）：
    // total_quota 就是汇总位——plan 2000/2000 + 资源包 534/1200 = 2534/3200，余 666
    const view = parseUsageView(readFixture("qoder-usage-china.json"), CHINA_NOW)!;
    expect(view.aggregate).toMatchObject({ used: 2534, total: 3200, remaining: 666 });
    // 下发的是向上取整的 80，本地按 2534/3200 算是 79.1875
    expect(view.aggregate.percent).toBeCloseTo(79.1875, 4);
    // 毫秒 epoch 自适应；这一刻与官网「将于 2026年9月26日 08:28:27 刷新配额」是同一个时刻
    expect(view.resetsAt?.toISOString()).toBe("2026-09-26T00:28:27.566Z");

    expect(view.windows).toHaveLength(2);
    const [plan, pack] = view.windows;
    // 订阅见底：这一行自己就是 100%，合并口径把它藏起来了（ADR-0030 的已知缺陷，本轮修）
    expect(plan).toMatchObject({
      key: "plan",
      used: 2000,
      total: 2000,
      remaining: 0,
      earliestExpiry: null,
    });
    expect(plan!.percent).toBe(100);
    expect(plan!.resetsAt?.toISOString()).toBe("2026-09-26T00:28:27.566Z");
    // 全响应只有一个 nextResetAt，它是订阅周期——资源包行绝不能挂这个时刻
    expect(pack).toMatchObject({ key: "package", used: 534, total: 1200, remaining: 666, resetsAt: null });
    expect(pack!.percent).toBeCloseTo(44.5);
    // 最早到期只认还有余量的包：detail 里 9-30 那笔已经耗尽，它不代表这 666 点的去处
    expect(pack!.earliestExpiry?.toISOString()).toBe(new Date(1792307582568).toISOString());
  });

  it("derives remaining from limit - used when the API omits it", () => {
    const view = parseUsageView({ totalQuota: { quotaSummary: { usedValue: 300, limitValue: 1200 } } });
    expect(view?.aggregate.remaining).toBe(900);
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
  const NOW = Date.parse("2026-05-01T00:00:00Z");
  const CHINA_NOW = Date.parse("2026-09-24T06:00:00Z");

  it("falls back to one merged line when the response has no per-container quota", () => {
    // 真机两站都会给分容器；这条走的是"只回 total_quota"的老形态，不拆窗也不编造窗口
    const view = parseUsageView(readFixture("qoder-usage.json"), NOW)!;
    const [line] = parseUsageLines(view);
    expect(line.type).toBe("progress");
    expect(line.label).toBe("积分余量");
    expect(line.used).toBe(412.5);
    expect(line.limit).toBe(1500);
    expect(line.percentUsed).toBeCloseTo(27.5);
    expect(line.balance).toBe(true);
    expect(line.value).toBe("1,088");
    expect(line.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("splits the paid China-site sample into subscription and resource package lines", () => {
    const view = parseUsageView(readFixture("qoder-usage-china.json"), CHINA_NOW)!;
    const lines = parseUsageLines(view);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      type: "progress",
      label: "订阅积分",
      used: 2000,
      limit: 2000,
      // 余额位是实例级总余量（total_quota 汇总位），不是这一行自己的 0
      value: "666",
      balance: true,
      resetsAt: "2026-09-26T00:28:27.566Z",
    });
    expect(lines[0].percentUsed).toBe(100);
    expect(lines[1]).toMatchObject({ type: "progress", label: "资源包积分", used: 534, limit: 1200 });
    expect(lines[1].percentUsed).toBeCloseTo(44.5);
    expect(lines[2]).toMatchObject({
      type: "text",
      label: "资源包",
      value: "余 {remain} · {expiresAt}到期",
      valueParams: { remain: "666", expiresAt: new Date(1792307582568).toISOString() },
    });
  });

  it("keeps the reset moment on the subscription line only, so it stays the primary window", () => {
    // 主窗是隐式选出来的：primaryProgressLine 取重置最远的一行，资源包行故意不带 resetsAt，
    // 阈值告警才盯在订阅配额上（Q5）。谁给资源包行补上重置时刻，这条就会红
    const view = parseUsageView(readFixture("qoder-usage-china.json"), CHINA_NOW)!;
    const lines = parseUsageLines(view);
    expect(lines[1].resetsAt).toBeUndefined();
    expect(primaryProgressLine(lines)?.label).toBe("订阅积分");
  });

  it("marks only the first progress line as the balance carrier", () => {
    const view = parseUsageView(
      asUsageData({
        plan_quota: { quota_summary: { used_value: 500, limit_value: 500, remaining_value: 0 } },
        resource_package_quota: { quota_summary: { used_value: 0, limit_value: 100, remaining_value: 100 } },
        dedicated_resource_package_quota: {
          quota_summary: { used_value: 10, limit_value: 40, remaining_value: 30 },
        },
        total_quota: { quota_summary: { used_value: 510, limit_value: 640, remaining_value: 130 } },
      }),
      NOW,
    )!;
    const lines = parseUsageLines(view);
    const progressLines = lines.filter((line) => line.type === "progress");
    expect(progressLines.map((line) => line.label)).toEqual(["订阅积分", "资源包积分", "专属资源包"]);
    expect(progressLines.map((line) => line.balance)).toEqual([true, undefined, undefined]);
    expect(progressLines[0].value).toBe("130");
    // 两个池子都还剩点数，各带一条到期明细行（这批数据没下发 quota_detail，所以只报余量）
    expect(lines.filter((line) => line.type === "text").map((line) => line.label)).toEqual([
      "资源包",
      "专属资源包",
    ]);
  });

  it("omits the package detail line when nothing is left in the pool", () => {
    const view = parseUsageView(
      asUsageData({
        plan_quota: { quota_summary: { used_value: 10, limit_value: 100, remaining_value: 90 } },
        resource_package_quota: { quota_summary: { used_value: 120, limit_value: 120, remaining_value: 0 } },
        total_quota: { quota_summary: { used_value: 130, limit_value: 220, remaining_value: 90 } },
      }),
      NOW,
    )!;
    expect(parseUsageLines(view).map((line) => line.type)).toEqual(["progress", "progress"]);
  });

  it("degrades the package detail line to a bare remainder when no expiry is known", () => {
    // quota_detail 在真机是 null 而不是空数组（体验版即如此），没有到期日就只报余量
    const view = parseUsageView(
      asUsageData({
        plan_quota: { quota_summary: { used_value: 0, limit_value: 0, remaining_value: 0 } },
        resource_package_quota: { quota_summary: { used_value: 534, limit_value: 1200, remaining_value: 666 } },
        total_quota: { quota_summary: { used_value: 534, limit_value: 1200, remaining_value: 666 } },
      }),
      NOW,
    )!;
    const [, detail] = parseUsageLines(view);
    expect(detail).toMatchObject({ type: "text", label: "资源包", value: "余 {remain}" });
    expect(detail.valueParams).toEqual({ remain: "666" });
  });

  it("clamps percentages into [0, 100] and omits absent resets", () => {
    const view = parseUsageView(
      asUsageData({
        plan_quota: { quota_summary: { used_value: 13, limit_value: 10, remaining_value: 0 } },
        total_quota: { quota_summary: { used_value: 13, limit_value: 10, remaining_value: 0 } },
      }),
      NOW,
    )!;
    const [line] = parseUsageLines(view);
    expect(line.percentUsed).toBe(100);
    expect(line.resetsAt).toBeUndefined();
  });

  it("renders zero total as a neutral fact line instead of a progress bar", () => {
    // 没有进度行就没有 100%、重置倒计时与耗尽告警（与 WorkBuddy 无套餐同法）
    const view = parseUsageView({ totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0 } } }, NOW)!;
    expect(parseUsageLines(view)).toEqual([{ type: "text", label: "积分余量", value: "未分配积分" }]);
  });

  it("renders the real trial-account response end to end", () => {
    // fixture 是真机响应原样落盘（账号标识打码）：容器键 snake_case、重置时刻 camelCase，
    // 四个配额容器全为 0，nextResetAt 停在 2026-01-06——三条规则同时作用在这份数据上
    const view = parseUsageView(
      readFixture("qoder-usage-trial.json"),
      Date.parse("2026-09-24T11:08:00Z"),
    );
    expect(view).not.toBeNull();
    expect(view!.windows).toEqual([]);
    expect(parseUsageLines(view!)).toEqual([{ type: "text", label: "积分余量", value: "未分配积分" }]);
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
