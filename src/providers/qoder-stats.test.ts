import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance } from "../types/ipc";
import {
  aggregateQoderUsage,
  fetchQoderHeatmap,
  fetchQoderUsage,
  fetchQoderUserId,
  parseHistories,
  qoderDayKey,
  qoderDayLabels,
} from "./qoder-stats";
import { CREDENTIAL_EXPIRED_MESSAGE } from "./qoder";

const mockInvoke = vi.mocked(invoke);

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

/** 每个用例用不同 id：userId 是模块级内存缓存，同 id 会命中上一条用例的缓存 */
const instance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "qoder-stats-1",
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

/** 本地时区某日零点毫秒（聚合的日标签按本地时区切，与 resolveRangeMs 同口径） */
const localDay = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day).getTime();

const historiesFixture = () => readJson("qoder-histories.json") as never;

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("parseHistories", () => {
  it("映射 snake_case 字段并带出分页总数", () => {
    const parsed = parseHistories(JSON.stringify(historiesFixture()));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.value.total).toBe(6);
    expect(parsed.value.lastPage).toBe(1);
    expect(parsed.value.rows).toHaveLength(6);
    expect(parsed.value.rows[4]).toMatchObject({
      time: 1782638715530,
      operation: "Quest Mode",
      kind: "Charged",
      credits: 115,
      originalCredits: 321.82,
      modelCategory: "Qwen3.7-Max",
      cost: 3.39,
      discountFactor: 0.2,
    });
  });

  it("非 JSON 响应归为解析失败", () => {
    const parsed = parseHistories("not-json");
    expect(parsed.kind).toBe("parse");
  });
});

describe("fetchQoderUsage", () => {
  const startMs = localDay(2026, 6, 23);
  const endMs = localDay(2026, 6, 23) + 86_400_000;

  it("缺凭据时与卡片同一句引导", async () => {
    mockInvoke.mockResolvedValueOnce({});
    const result = await fetchQoderUsage(instance({ id: "u-missing" }), startMs, endMs);
    expect(result.status).toBe("needs_config");
  });

  it("显式带上区间与排序参数，走 qoder_cookie 通道", async () => {
    mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(httpResult(historiesFixture()));
    const result = await fetchQoderUsage(instance({ id: "u-single" }), startMs, endMs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.rows).toHaveLength(6);
    expect(result.data.total).toBe(6);

    const call = mockInvoke.mock.calls[1] ?? [];
    expect(call[0]).toBe("provider_request");
    const options = call[1] as Record<string, unknown>;
    expect(options.auth).toBe("qoder_cookie");
    expect(options.credentialSlot).toBe("cookie");
    const url = String(options.url);
    expect(url.startsWith("https://qoder.com.cn/api/v1/me/usages/big_model_credits/histories?")).toBe(true);
    // endMs 是结束日次日零点，服务端按含边界算 → 退一秒回到末日最后一刻
    expect(url).toContain(`start_time=${startMs}`);
    expect(url).toContain(`end_time=${endMs - 1}`);
    expect(url).toContain("page=1");
    expect(url).toContain("page_size=1000");
    expect(url).toContain("order_by=begin_at");
    expect(url).toContain("order=-1");
  });

  it("首页给满 page_size 时按 last_page 续拉，合并成一整份明细", async () => {
    // 真实形状：page_size=1000 的首页必须满页才继续，短页即视为末页
    const rows = (historiesFixture() as { data: Array<Record<string, unknown>> }).data;
    const fullPage = Array.from({ length: 1000 }, (_, index) => ({ ...rows[0], time: index }));
    const pageOne = httpResult({ data: fullPage, page_result: { last_page: 2, total_size: 1006 } });
    const pageTwo = httpResult({ data: rows, page_result: { last_page: 2, total_size: 1006 } });
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(pageOne)
      .mockResolvedValueOnce(pageTwo);
    const result = await fetchQoderUsage(instance({ id: "u-pages" }), startMs, endMs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.rows).toHaveLength(1006);
    expect(result.data.total).toBe(1006);
    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(String((mockInvoke.mock.calls[2]?.[1] as Record<string, unknown>).url)).toContain("page=2");
  });

  it("401 与登录页 HTML 都归为凭据失效，文案与卡片完全一致", async () => {
    for (const reply of [httpResult("denied", 401), httpResult("<html>login</html>")]) {
      mockInvoke.mockReset();
      mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(reply);
      const result = await fetchQoderUsage(instance({ id: "u-expired" }), startMs, endMs);
      expect(result).toEqual({ status: "error", message: CREDENTIAL_EXPIRED_MESSAGE });
    }
  });

  it("非 200 与解析失败各给一句可诊断的话", async () => {
    mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(httpResult("boom", 502));
    const http = await fetchQoderUsage(instance({ id: "u-http" }), startMs, endMs);
    expect(http).toMatchObject({ status: "error", message: "消耗明细接口返回 HTTP {status}" });

    mockInvoke.mockReset();
    mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(httpResult("nope"));
    const parse = await fetchQoderUsage(instance({ id: "u-parse" }), startMs, endMs);
    expect(parse).toMatchObject({ status: "error", message: "消耗明细返回数据解析失败：{detail}" });
  });
});

describe("fetchQoderUserId", () => {
  it("每次调用都重取身份（按实例缓存会在换号后命中旧号）", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult(readJson("qoder-me.json")))
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult(readJson("qoder-me.json")));
    const first = await fetchQoderUserId(instance({ id: "u-id" }));
    expect(first).toEqual({ status: "ok", data: "019ef31d-0000-0000-0000-000000000000" });
    const second = await fetchQoderUserId(instance({ id: "u-id" }));
    expect(second).toEqual(first);
    expect(mockInvoke).toHaveBeenCalledTimes(4); // 两轮各：凭据状态 + 身份请求
  });

  it("响应里的账号名与邮箱不进返回值", async () => {
    mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(httpResult(readJson("qoder-me.json")));
    const result = await fetchQoderUserId(instance({ id: "u-privacy" }));
    const text = JSON.stringify(result);
    expect(text).not.toContain("占位账号名");
    expect(text).not.toContain("example.invalid");
    expect(text).not.toContain("avatars");
  });

  it("响应没有 id 时如实报错，不猜一个", async () => {
    mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(httpResult({ name: "x" }));
    const result = await fetchQoderUserId(instance({ id: "u-noid" }));
    expect(result).toMatchObject({ status: "error", message: "身份接口未返回账号标识，无法取近一年消耗分布" });
  });
});

describe("fetchQoderHeatmap", () => {
  it("先取 userId 再拉分布，分档阈值原样透传", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult(readJson("qoder-me.json")))
      .mockResolvedValueOnce(httpResult(readJson("qoder-heatmap.json")));
    const result = await fetchQoderHeatmap(instance({ id: "u-heat" }), 366);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.unit).toBe("credits");
    expect(result.data.levels).toHaveLength(4);
    expect(result.data.items[0]).toEqual({ date: "2026-09-15", value: 207.250215128 });
    const url = String((mockInvoke.mock.calls[2]?.[1] as Record<string, unknown>).url);
    expect(url.startsWith("https://qoder.com.cn/api/v1/me/ai-conversations/credits-heatmap?")).toBe(true);
    expect(url).toContain("userId=019ef31d-0000-0000-0000-000000000000");
    expect(url).toContain("days=366");
  });

  it("total 是整年口径、items 是裁剪窗口，两者不一致也照原样返回", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult(readJson("qoder-me.json")))
      .mockResolvedValueOnce(httpResult(readJson("qoder-heatmap.json")));
    const result = await fetchQoderHeatmap(instance({ id: "u-total" }));
    if (result.status !== "ok") throw new Error("expected ok");
    const sum = result.data.items.reduce((acc, item) => acc + item.value, 0);
    expect(sum).not.toBe(result.data.total);
    expect(result.data.total).toBe(6599.335911297798);
  });
});

describe("响应上限与错误净化", () => {
  const startMs = localDay(2026, 6, 23);
  const endMs = startMs + 86_400_000;

  it("单页行数超过请求上限时报错，不把任意大的响应灌进内存", () => {
    const huge = httpResult({
      data: Array.from({ length: 1001 }, () => ({ credits: 1 })),
      page_result: { total_size: 1001, last_page: 1 },
    });
    mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(huge);
    return expect(
      fetchQoderUsage(instance({ id: "s-oversize" }), startMs, endMs),
    ).resolves.toMatchObject({
      status: "error",
      params: { detail: "单页条数超过请求上限" },
    });
  });

  it("解析失败不回显响应体片段", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult('{"id": "secret-account-name"'));
    const result = await fetchQoderUsage(instance({ id: "s-parse" }), startMs, endMs);
    expect(JSON.stringify(result)).not.toContain("secret-account-name");
    expect(result).toMatchObject({ params: { detail: "响应不是合法 JSON" } });
  });

  it("网络错误不带请求 URL（query 里有 userId）", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockRejectedValueOnce(
        new Error(
          "error sending request for url (https://qoder.com.cn/api/v1/me/usages/big_model_credits/histories?page=1&userId=019ef31d-4bc7)",
        ),
      );
    const result = await fetchQoderUsage(instance({ id: "s-network" }), startMs, endMs);
    const detail = String((result as { params?: Record<string, unknown> }).params?.detail);
    expect(detail).not.toContain("https://");
    expect(detail).not.toContain("userId=");
    expect(detail).not.toContain("019ef31d");
  });

  it("热力图条目数与请求天数不符时报错", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}`, value: 1 }));
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult(readJson("qoder-me.json")))
      .mockResolvedValueOnce(httpResult({ unit: "credits", levels: [], items, total: 20 }));
    const result = await fetchQoderHeatmap(instance({ id: "s-items" }), 7);
    expect(result).toMatchObject({ status: "error", message: "消耗分布条目数与请求天数不符" });
  });
  it("响应没有 page_result 时按短页收口，不当成「只有 0 条」", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult({ data: [{ time: 1782196272012, credits: 1 }] }));
    const result = await fetchQoderUsage(instance({ id: "s-nometa" }), startMs, endMs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.total).toBe(1);
  });

  it("每页都给满又拿不到分页元数据：撞页数上限时显式报错，不交半份数据", async () => {
    const full = httpResult({ data: Array.from({ length: 1000 }, (_, i) => ({ time: i, credits: 1 })) });
    mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValue(full);
    const result = await fetchQoderUsage(instance({ id: "s-endpage" }), startMs, endMs);
    expect(result).toMatchObject({
      status: "error",
      message: "消耗明细未取全（已取 {count} 条，达到 {pages} 页上限），请缩小时间范围。",
      params: { count: 10000, pages: 10 },
    });
  });

  it("声明的 total_size 大于实得条数时报元数据自相矛盾", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(
        httpResult({ data: [{ time: 1, credits: 1 }], page_result: { total_size: 535, last_page: 1 } }),
      );
    const result = await fetchQoderUsage(instance({ id: "s-lie" }), startMs, endMs);
    expect(result).toMatchObject({
      status: "error",
      message: "消耗明细分页元数据自相矛盾（声明 {total} 条，实得 {count} 条）。",
      params: { total: 535, count: 1 },
    });
  });
});

describe("aggregateQoderUsage", () => {
  const rows = (historiesFixture() as { data: Array<Record<string, unknown>> }).data.map((row) => ({
    time: Number(row.time),
    beginAt: Number(row.begin_at),
    finishAt: Number(row.finish_at),
    source: String(row.source),
    operation: String(row.operation),
    kind: String(row.kind),
    credits: Number(row.credits),
    originalCredits: Number(row.original_credits),
    modelCategory: String(row.model_category),
    cost: Number(row.cost),
    discountFactor: Number(row.discount_factor),
  }));
  const startMs = localDay(2026, 6, 23);
  const endMs = localDay(2026, 6, 29) + 86_400_000; // 6/23 ~ 6/29 共 7 天，覆盖全部样本行

  it("按用途与模型分组、消耗降序", () => {
    const aggregates = aggregateQoderUsage(rows, startMs, endMs);
    expect(aggregates.perOperation.map((group) => group.name)).toEqual([
      "Repo Wiki",
      "Quest Mode",
      "Agent",
      "Optimize Input",
    ]);
    expect(aggregates.perOperation[1]).toEqual({ name: "Quest Mode", requests: 2, credits: 117.64 });
    expect(aggregates.perModel.map((group) => group.name)).toEqual(["Auto", "Qwen3.7-Max"]);
  });

  it("合计、日均与折扣节省", () => {
    const aggregates = aggregateQoderUsage(rows, startMs, endMs);
    expect(aggregates.totalRequests).toBe(6);
    expect(aggregates.totalCredits).toBeCloseTo(305.24, 4);
    expect(aggregates.savedCredits).toBeCloseTo(230.64, 4);
    expect(aggregates.days).toBe(7);
    expect(aggregates.dailyAvgCredits).toBeCloseTo(305.24 / 7, 4);
    expect(aggregates.dayLabels).toEqual([
      qoderDayKey(startMs),
      qoderDayKey(startMs + 86_400_000),
      qoderDayKey(startMs + 2 * 86_400_000),
      qoderDayKey(startMs + 3 * 86_400_000),
      qoderDayKey(startMs + 4 * 86_400_000),
      qoderDayKey(startMs + 5 * 86_400_000),
      qoderDayKey(startMs + 6 * 86_400_000),
    ]);
    expect(aggregates.daily[qoderDayKey(rows[0].time)]).toEqual({ credits: 1.44, requests: 1 });
  });

  it("堆叠系列与 dayLabels 等长，缺数据的格子补 0", () => {
    const aggregates = aggregateQoderUsage(rows, startMs, endMs);
    for (const series of aggregates.dailyCreditsSeries) {
      expect(series.values).toHaveLength(aggregates.dayLabels.length);
    }
    const repoWiki = aggregates.dailyCreditsSeries.find((series) => series.name === "Repo Wiki");
    const sum = (repoWiki?.values ?? []).reduce((acc, value) => acc + value, 0);
    expect(sum).toBeCloseTo(172.95, 4);
    expect(repoWiki?.values[0]).toBe(0); // 6/23 那天只有 1.44 的 Agent 调用
  });

  it("Not Charged 的记录计入次数、不计积分（免费调用是真实构成）", () => {
    const free = { ...rows[0], operation: "Optimize Input", kind: "Not Charged", credits: 0, originalCredits: 0.11 };
    const aggregates = aggregateQoderUsage([...rows, free], startMs, endMs);
    expect(aggregates.totalRequests).toBe(rows.length + 1);
    expect(aggregates.totalCredits).toBeCloseTo(305.24, 4);
    expect(aggregates.savedCredits).toBeCloseTo(230.64 + 0.11, 4);
  });

  it("qoderDayLabels 覆盖含首尾的连续自然日", () => {
    expect(qoderDayLabels(localDay(2026, 9, 28), localDay(2026, 9, 30) + 86_400_000)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ]);
  });

  it("跨月与整年都逐日连续、不重不漏", () => {
    const crossing = qoderDayLabels(localDay(2026, 2, 27), localDay(2026, 3, 2) + 86_400_000);
    expect(crossing).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    const year = qoderDayLabels(localDay(2025, 10, 1), localDay(2026, 10, 1));
    expect(year).toHaveLength(365);
    expect(new Set(year).size).toBe(365);
    expect(year[0]).toBe("2025-10-01");
    expect(year[year.length - 1]).toBe("2026-09-30");
  });

  it("区间被灌大时按防御上限收口，不无界生成标签", () => {
    const huge = qoderDayLabels(localDay(2000, 1, 1), localDay(2030, 1, 1));
    expect(huge).toHaveLength(800);
  });
});
