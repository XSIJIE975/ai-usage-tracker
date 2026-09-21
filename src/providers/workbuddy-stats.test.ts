import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance } from "../types/ipc";
import { aggregateWorkbuddyUsage, fetchWorkbuddyUsage, type WorkbuddyUsageRow } from "./workbuddy-stats";

const mockInvoke = vi.mocked(invoke);

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

const usagePayload = (rows: unknown[], total = rows.length) =>
  httpResult({ code: 0, msg: "OK", data: { total, data: rows } });

const usageRow = (over: Record<string, unknown> = {}) => ({
  requestId: "req-1",
  credit: 1.5,
  model: "deepseek-v4.1-flash",
  client: "WorkBuddy",
  requestTime: "2026-09-15 17:20:00",
  inputTrunc: "帮我提交然后继续执行",
  agentPurpose: "conversation",
  ...over,
});

const makeInstance = (): ProviderInstance => ({
  id: "wb-stats-1",
  providerId: "workbuddy",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
  balanceThreshold: null,
  createdAt: 0,
});

// 本地时区 2026-09-08 00:00:00 ～ 2026-09-16 00:00:00（8 个自然日，与 resolveRangeMs 同口径）
const range = () => ({
  startMs: new Date(2026, 8, 8).getTime(),
  endMs: new Date(2026, 8, 16).getTime(),
});

const row = (over: Partial<WorkbuddyUsageRow> = {}): WorkbuddyUsageRow => ({
  requestId: "req",
  time: "2026-09-10 12:00:00",
  credit: 2,
  model: "model-a",
  client: "WorkBuddy",
  purpose: "conversation",
  inputTrunc: "摘要",
  ...over,
});

describe("aggregateWorkbuddyUsage", () => {
  it("模型/用途聚合按积分降序，0 积分内部调用如实计入次数", () => {
    const agg = aggregateWorkbuddyUsage(
      [
        row({ model: "m-1", purpose: "conversation", credit: 10 }),
        row({ model: "m-2", purpose: "conversation_topic", credit: 0 }),
        row({ model: "m-1", purpose: "enhance-prompt", credit: 3.5 }),
        row({ model: "m-1", purpose: "conversation", credit: 2.5 }),
      ],
      range().startMs,
      range().endMs,
    );
    expect(agg.perModel).toEqual([
      { model: "m-1", requests: 3, credits: 16 },
      { model: "m-2", requests: 1, credits: 0 },
    ]);
    expect(agg.perPurpose).toEqual([
      { purpose: "conversation", requests: 2, credits: 12.5 },
      { purpose: "enhance-prompt", requests: 1, credits: 3.5 },
      { purpose: "conversation_topic", requests: 1, credits: 0 },
    ]);
    expect(agg.perPurpose[0].purpose).toBe("conversation");
    expect(agg.totalRequests).toBe(4);
    expect(agg.totalCredits).toBeCloseTo(16, 10);
  });

  it("日均消耗按范围自然日跨度（非活跃天数），单次均耗防除零", () => {
    const agg = aggregateWorkbuddyUsage(
      [row({ credit: 8 })],
      range().startMs,
      range().endMs,
    );
    expect(agg.days).toBe(8);
    expect(agg.dailyAvgCredits).toBeCloseTo(1, 10);
    expect(agg.avgPerRequest).toBeCloseTo(8, 10);
    expect(aggregateWorkbuddyUsage([], range().startMs, range().endMs).avgPerRequest).toBe(0);
  });

  it("每日标签连续补零，堆叠序列与 perModel 同序且模型×天对齐", () => {
    const agg = aggregateWorkbuddyUsage(
      [
        row({ time: "2026-09-09 10:00:00", model: "m-1", credit: 3 }),
        row({ time: "2026-09-09 11:00:00", model: "m-2", credit: 1 }),
        row({ time: "2026-09-11 09:00:00", model: "m-1", credit: 5 }),
      ],
      range().startMs,
      range().endMs,
    );
    expect(agg.dayLabels).toEqual([
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
    ]);
    expect(agg.daily["2026-09-09"]).toEqual({ credits: 4, requests: 2 });
    expect(agg.daily["2026-09-08"]).toEqual({ credits: 0, requests: 0 });
    // perModel 降序：m-1(8) 在前
    expect(agg.dailyCreditsSeries[0].name).toBe("m-1");
    expect(agg.dailyCreditsSeries[0].values).toEqual([0, 3, 0, 5, 0, 0, 0, 0]);
    expect(agg.dailyCreditsSeries[1].values).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    expect(agg.dailyRequestsSeries[0].values).toEqual([0, 1, 0, 1, 0, 0, 0, 0]);
  });
});

describe("fetchWorkbuddyUsage", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("无 Cookie → needs_config，不发请求", async () => {
    mockInvoke.mockResolvedValueOnce({ cookie: false });
    const result = await fetchWorkbuddyUsage(makeInstance(), range().startMs, range().endMs);
    expect(result.status).toBe("needs_config");
    if (result.status !== "needs_config") return;
    expect(result.message).toBe("请在设置中填写 WorkBuddy 登录 Cookie");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("单页收口：行字段映射正确，请求体带本地时间区间与 UA（WAF 硬规则）", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(
        usagePayload([
          usageRow({ credit: 18.31, agentPurpose: "conversation" }),
          usageRow({ requestId: "req-2", credit: "0.03", agentPurpose: "enhance-prompt" }),
        ]),
      );
    const result = await fetchWorkbuddyUsage(makeInstance(), range().startMs, range().endMs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.total).toBe(2);
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows[0]).toMatchObject({
      requestId: "req-1",
      time: "2026-09-15 17:20:00",
      credit: 18.31,
      model: "deepseek-v4.1-flash",
      purpose: "conversation",
      inputTrunc: "帮我提交然后继续执行",
    });
    // 字符串 credit 也归一为数值
    expect(result.data.rows[1].credit).toBe(0.03);

    const request = mockInvoke.mock.calls[1]?.[1] as {
      url: string;
      method: string;
      headers: Record<string, string>;
      bodyText: string;
    };
    expect(request.url).toBe("https://www.workbuddy.cn/billing/meter/get-user-request-usage");
    expect(request.method).toBe("POST");
    expect(request.headers["User-Agent"]).toContain("Edg/");
    expect(JSON.parse(request.bodyText)).toEqual({
      startTime: "2026-09-08 00:00:00",
      endTime: "2026-09-15 23:59:59",
      pageNum: 1,
      pageSize: 100,
    });
  });

  it("多页拉全：total 250 → 3 页，pageNum 递增", async () => {
    const page = (count: number) =>
      usagePayload(
        Array.from({ length: count }, (_, i) => usageRow({ requestId: `req-${i}` })),
        250,
      );
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(50));
    const result = await fetchWorkbuddyUsage(makeInstance(), range().startMs, range().endMs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.rows).toHaveLength(250);
    const pageParams = mockInvoke.mock.calls
      .slice(1)
      .map((call) => (JSON.parse((call[1] as { bodyText: string }).bodyText) as { pageNum: number }).pageNum);
    expect(pageParams).toEqual([1, 2, 3]);
  });

  it("分页防御上限：total 虚高时最多 20 页按已得数据收口", async () => {
    mockInvoke.mockResolvedValueOnce({ cookie: true });
    for (let i = 0; i < 20; i += 1) {
      mockInvoke.mockResolvedValueOnce(
        usagePayload(Array.from({ length: 100 }, (_, j) => usageRow({ requestId: `r${i}-${j}` })), 100_000),
      );
    }
    const result = await fetchWorkbuddyUsage(makeInstance(), range().startMs, range().endMs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.rows).toHaveLength(2000);
    expect(mockInvoke.mock.calls).toHaveLength(21);
  });

  it("401 / 登录页 HTML → 登录已过期指引", async () => {
    mockInvoke.mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(httpResult("unauthorized", 401));
    const expired = await fetchWorkbuddyUsage(makeInstance(), range().startMs, range().endMs);
    expect(expired.status).toBe("error");
    if (expired.status !== "error") return;
    expect(expired.message).toBe("WorkBuddy 登录已过期，请重新复制 Cookie");

    mockInvoke.mockReset().mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(httpResult("<html>"));
    const html = await fetchWorkbuddyUsage(makeInstance(), range().startMs, range().endMs);
    expect(html.status).toBe("error");
    if (html.status !== "error") return;
    expect(html.message).toBe("WorkBuddy 登录已过期，请重新复制 Cookie");
  });

  it("业务失败 / 非 200 → 模板错误带实参", async () => {
    mockInvoke
      .mockResolvedValueOnce({ cookie: true })
      .mockResolvedValueOnce(httpResult({ code: 500, msg: "内部错误" }));
    const biz = await fetchWorkbuddyUsage(makeInstance(), range().startMs, range().endMs);
    expect(biz.status).toBe("error");
    if (biz.status !== "error") return;
    expect(biz.message).toBe("积分明细查询失败：{detail}");
    expect(biz.params).toMatchObject({ detail: "code=500 msg=内部错误" });

    mockInvoke.mockReset().mockResolvedValueOnce({ cookie: true }).mockResolvedValueOnce(httpResult("oops", 502));
    const http = await fetchWorkbuddyUsage(makeInstance(), range().startMs, range().endMs);
    expect(http.status).toBe("error");
    if (http.status !== "error") return;
    expect(http.message).toBe("积分明细接口返回 HTTP {status}");
    expect(http.params).toMatchObject({ status: 502 });
  });
});
