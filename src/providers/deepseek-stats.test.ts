import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUsageQuery } from "./deepseek-stats";
import {
  dayLabelFromDate,
  mergeDeepSeekUsage,
  platformErrorMessage,
} from "./deepseek-stats-merge";
import type { DeepSeekAmountResponse, DeepSeekCostResponse } from "./deepseek-stats-merge";

const readFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const loadAmountFixture = (): DeepSeekAmountResponse =>
  JSON.parse(readFixture("deepseek-usage-amount.json")) as DeepSeekAmountResponse;

const loadCostFixture = (): DeepSeekCostResponse =>
  JSON.parse(readFixture("deepseek-usage-cost.json")) as DeepSeekCostResponse;

describe("buildUsageQuery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts milliseconds to unix seconds", () => {
    const query = buildUsageQuery(1784995200000, 1787587200500);
    expect(query.start).toBe(1784995200);
    expect(query.end).toBe(1787587200);
  });

  it("derives tz as seconds east of UTC from getTimezoneOffset", () => {
    const offsetSpy = vi
      .spyOn(Date.prototype, "getTimezoneOffset")
      .mockReturnValue(-480);

    const query = buildUsageQuery(0, 0);
    expect(offsetSpy).toHaveBeenCalled();
    expect(query.tz).toBe(28800);
  });

  it("yields tz 0 for UTC", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
    expect(buildUsageQuery(0, 0).tz).toBe(0);
  });
});

describe("dayLabelFromDate", () => {
  it("formats local calendar components as YYYY-MM-DD regardless of timezone", () => {
    expect(dayLabelFromDate(new Date(2026, 6, 15))).toBe("2026-07-15");
    expect(dayLabelFromDate(new Date(2027, 0, 1))).toBe("2027-01-01");
    expect(dayLabelFromDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("mergeDeepSeekUsage", () => {
  it("merges amount and cost fixtures into one row per series bucket", () => {
    const bundle = mergeDeepSeekUsage(loadAmountFixture(), loadCostFixture());
    expect(bundle.rows).toHaveLength(6);
  });

  it("matches exact usage numbers and converted cost for a fixture row", () => {
    const bundle = mergeDeepSeekUsage(loadAmountFixture(), loadCostFixture());
    const row = bundle.rows.find(
      (item) => item.model === "deepseek-v4-flash" && item.requests === 58,
    );
    expect(row).toEqual({
      day: expect.any(String),
      model: "deepseek-v4-flash",
      keyId: "194627f8-55fd-4f85-a57e-47fce0dcd32c",
      cacheHitTokens: 14433280,
      cacheMissTokens: 262481,
      outputTokens: 55183,
      requests: 58,
      costCny: 0.6615126,
    });
  });

  it("converts decimal-string costs with Number()", () => {
    const bundle = mergeDeepSeekUsage(loadAmountFixture(), loadCostFixture());
    const row = bundle.rows.find(
      (item) => item.model === "deepseek-chat & deepseek-reasoner" && item.requests === 1,
    );
    expect(row?.costCny).toBe(0.0021);
  });

  it("records cost 0 when the cost response has no matching bucket", () => {
    const amount = loadAmountFixture();
    const emptyCost: DeepSeekCostResponse = { code: 0, data: { biz_code: 0, biz_data: { data: [] } } };
    const bundle = mergeDeepSeekUsage(amount, emptyCost);
    expect(bundle.rows).toHaveLength(6);
    expect(bundle.rows.every((row) => row.costCny === 0)).toBe(true);
    expect(bundle.currency).toBe("CNY");
  });

  it("deduplicates api keys by tracking_id keeping first name", () => {
    const bundle = mergeDeepSeekUsage(loadAmountFixture(), loadCostFixture());
    expect(bundle.apiKeys).toEqual([
      { id: "194627f8-55fd-4f85-a57e-47fce0dcd32c", name: "HP-Book14 Pro" },
    ]);
  });

  it("keeps all-zero buckets as rows for the view to filter", () => {
    const bundle = mergeDeepSeekUsage(loadAmountFixture(), loadCostFixture());
    const zeroRows = bundle.rows.filter((row) => row.outputTokens === 0 && row.requests === 0);
    expect(zeroRows.length).toBeGreaterThanOrEqual(3);
  });

  it("takes currency from the first cost currency group", () => {
    const bundle = mergeDeepSeekUsage(loadAmountFixture(), loadCostFixture());
    expect(bundle.currency).toBe("CNY");
  });

  it("formats each row day through the injected day label function", () => {
    const bundle = mergeDeepSeekUsage(loadAmountFixture(), loadCostFixture(), (timeSec) => `T${timeSec}`);
    expect(bundle.rows[0]).toMatchObject({ day: "T1785686400" });
  });
});

describe("platformErrorMessage", () => {
  it("returns null for a healthy envelope", () => {
    expect(platformErrorMessage({ code: 0, msg: "", data: { biz_code: 0 } })).toBeNull();
  });

  it("reports wrapper code failures with msg", () => {
    expect(platformErrorMessage({ code: 401, msg: "token invalid" })).toEqual({
      message: "DeepSeek 平台返回错误：{detail}",
      params: { detail: "token invalid" },
    });
  });

  it("reports biz_code failures with biz_msg", () => {
    expect(platformErrorMessage({ code: 0, data: { biz_code: 1, biz_msg: "quota exceeded" } })).toEqual({
      message: "DeepSeek 平台返回错误：{detail}",
      params: { detail: "quota exceeded" },
    });
  });
});
