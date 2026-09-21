import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance } from "../types/ipc";
import {
  cstDateString,
  parseCheckinResult,
  parseClaimResult,
  parseExpiry,
  parseResourceLines,
  parseStreakLine,
  parseTravelLine,
  workbuddyProvider,
} from "./workbuddy";
import type { WorkbuddyPackage, WorkbuddyResourceData } from "./workbuddy";

const mockInvoke = vi.mocked(invoke);

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

/** 每个用例独立实例 id：provider 模块的「今日已签」内存标记按实例记录，
 *  同文件内复用 id 会让后续用例跳过签到调用，污染调用次数断言 */
let nextId = 0;
const makeInstance = (): ProviderInstance => {
  nextId += 1;
  return {
    id: `wb-${nextId}`,
    providerId: "workbuddy",
    note: "",
    sortOrder: 0,
    pinned: false,
    autoRefresh: true,
    threshold: null,
    balanceThreshold: null,
    createdAt: 0,
  };
};

const resourcePayload = (accounts: unknown[]) => ({
  code: 0,
  msg: "success",
  data: { Response: { Data: { Accounts: accounts } } },
});

/** parseResourceLines 的入参形态。两种都解析：data.Response.Data.Accounts（社区文档形态）
 *  与 data.Accounts 直挂（2026-09-21 get-user-resource-free-packages 实测形态） */
const resourceData = (accounts: unknown[]): WorkbuddyResourceData =>
  resourcePayload(accounts).data as WorkbuddyResourceData;

const flatData = (accounts: unknown[]): WorkbuddyResourceData =>
  ({ Accounts: accounts }) as unknown as WorkbuddyResourceData;

const totalPackage = (over: Record<string, unknown> = {}) => ({
  PackageName: "月度套餐",
  Status: 0,
  CycleEndTime: "2026-10-01 10:00:00",
  CapacityRemainPrecise: 1500,
  CapacityUsedPrecise: 500,
  CapacitySizePrecise: 2000,
  ...over,
});

const cyclePackage = (over: Record<string, unknown> = {}) => ({
  PackageName: "周期包",
  Status: 3,
  CycleEndTime: "2026-09-30 10:00:00",
  CycleCapacityRemainPrecise: "800.5",
  CycleCapacitySizePrecise: "1000",
  ...over,
});

const streakPayload = (days: number) => ({ code: 0, msg: "success", data: { streak: { days } } });

/** travel/status 的到站形态（2026-09-21 用户实测响应裁剪） */
const travelStatusPayload = (over: Record<string, unknown> = {}) =>
  httpResult({
    code: 0,
    msg: "OK",
    data: {
      state: "arrived",
      record_id: 5068662,
      depart_at: 1789370635,
      arrive_at: 1789381435,
      daily_limit_reached: false,
      reward_credit: 9,
      location: { name: "咖啡馆" },
      ...over,
    },
  });

const travelOk = httpResult({ code: 0, msg: "OK" });

const credentialStatus = (fields: { cookie?: boolean }) => ({
  cookie: fields.cookie ?? false,
});

/** 快照轮询的调用次序：凭据 → （每日首次）签到 → 旅行状态机 → 余额套餐 → 连登。
 *  travelStatus 缺省给空 data（state 缺失 → 状态机整体跳过）；要驱动领奖/出发的用例
 *  显式传 travelStatus/travelClaim/travelDepart/travelRecheck */
const mockFetchSequence = (opts: {
  cookie?: boolean;
  checkin?: HttpResult;
  travelStatus?: HttpResult;
  travelClaim?: HttpResult;
  travelDepart?: HttpResult;
  travelRecheck?: HttpResult;
  resource: HttpResult;
  streak?: HttpResult;
}) => {
  mockInvoke.mockResolvedValueOnce(credentialStatus({ cookie: opts.cookie ?? true }));
  if (opts.checkin) mockInvoke.mockResolvedValueOnce(opts.checkin);
  mockInvoke.mockResolvedValueOnce(opts.travelStatus ?? httpResult({ code: 0, msg: "OK", data: {} }));
  if (opts.travelClaim) mockInvoke.mockResolvedValueOnce(opts.travelClaim);
  if (opts.travelDepart) mockInvoke.mockResolvedValueOnce(opts.travelDepart);
  if (opts.travelRecheck) mockInvoke.mockResolvedValueOnce(opts.travelRecheck);
  mockInvoke.mockResolvedValueOnce(opts.resource);
  if (opts.streak) mockInvoke.mockResolvedValueOnce(opts.streak);
};

describe("parseResourceLines", () => {
  it("聚合全部套餐为主进度行，周期制字段优先于总量制", () => {
    const lines = parseResourceLines(
      resourceData([totalPackage(), cyclePackage()]),
    );
    expect(lines).toHaveLength(3);
    const main = lines[0];
    expect(main.type).toBe("progress");
    expect(main.label).toBe("积分余量");
    // 余 1500+800.5=2300.5，总 2000+1000=3000，已用 699.5 → 23.316..%
    expect(main.used).toBeCloseTo(699.5, 5);
    expect(main.limit).toBe(3000);
    expect(main.percentUsed).toBeCloseTo(((3000 - 2300.5) / 3000) * 100, 5);
  });

  it("明细行按到期时间升序排列（最紧急在前），行内带余量与到期日", () => {
    const lines = parseResourceLines(
      resourceData([totalPackage(), cyclePackage()]),
    );
    // 周期包 9-30 到期在前，月度套餐 10-1 在后
    expect(lines[1]).toMatchObject({ type: "text", label: "周期包" });
    expect(lines[1].value).toBe("余 800.50 · 9月30日到期");
    expect(lines[2]).toMatchObject({ type: "text", label: "月度套餐" });
    expect(lines[2].value).toBe("余 1,500 · 10月1日到期");
  });

  it("超过 3 份套餐时前 3 行逐条展示，其余合并为一行", () => {
    const packages = [
      cyclePackage({ PackageName: "A", CycleEndTime: "2026-09-25 00:00:00" }),
      cyclePackage({ PackageName: "B", CycleEndTime: "2026-09-26 00:00:00" }),
      cyclePackage({ PackageName: "C", CycleEndTime: "2026-09-27 00:00:00" }),
      cyclePackage({ PackageName: "D", CycleEndTime: "2026-09-28 00:00:00", CycleCapacityRemainPrecise: 100 }),
      cyclePackage({ PackageName: "E", CycleEndTime: "2026-09-29 00:00:00", CycleCapacityRemainPrecise: 200 }),
    ];
    const lines = parseResourceLines(resourceData(packages));
    // 主行 + 3 行明细 + 1 行合并
    expect(lines).toHaveLength(5);
    expect(lines[1].label).toBe("A");
    expect(lines[3].label).toBe("C");
    expect(lines[4]).toMatchObject({ label: "其余 {count} 个套餐", params: { count: 2 }, value: "余 300" });
  });

  it("无有效套餐时出中性事实行，不出空快照", () => {
    const lines = parseResourceLines(resourceData([]));
    expect(lines).toEqual([{ type: "text", label: "积分余量", value: "暂无有效套餐" }]);
    expect(parseResourceLines(undefined)).toEqual([{ type: "text", label: "积分余量", value: "暂无有效套餐" }]);
  });

  it("只有余量没有总量时退化为文本行（出不了百分比不进托盘）", () => {
    const lines = parseResourceLines(
      resourceData([{ PackageName: "残缺包", CapacityRemainPrecise: 42 } as WorkbuddyPackage]),
    );
    expect(lines[0]).toEqual({ type: "text", label: "积分余量", value: "余 42" });
  });

  it("脏数据钳制：remain 超总量取总量、负值取 0，不出负 used 或虚高百分比", () => {
    const lines = parseResourceLines(
      resourceData([
        {
          PackageName: "超量包",
          CapacityRemainPrecise: 3000,
          CapacitySizePrecise: 2000,
          CycleEndTime: "2026-10-01 10:00:00",
        },
        {
          PackageName: "负值包",
          CapacityRemainPrecise: -5,
          CapacitySizePrecise: 100,
          CycleEndTime: "2026-10-02 10:00:00",
        },
      ]),
    );
    // 余 2000+0=2000，总 2000+100=2100，已用 100
    expect(lines[0]).toMatchObject({ type: "progress", used: 100, limit: 2100 });
    expect(lines[1]).toMatchObject({ label: "超量包", value: "余 2,000 · 10月1日到期" });
    expect(lines[2]).toMatchObject({ label: "负值包", value: "余 0 · 10月2日到期" });
  });

  it("周期制整组采用：缺 Cycle 总量时整组回退总量制，不跨制拼接字段", () => {
    // workbuddy2api packageRemainUsed 同门槛（CycleCapacitySize>0 才用周期制）：
    // 孤立的 CycleCapacityRemainPrecise 不得与 Capacity 系拼接（旧逻辑会算出负 used）
    const lines = parseResourceLines(
      resourceData([
        {
          PackageName: "孤立周期余量",
          CycleCapacityRemainPrecise: 500,
          CapacityRemainPrecise: 100,
          CapacitySizePrecise: 200,
          CycleEndTime: "2026-10-03 10:00:00",
        },
      ]),
    );
    expect(lines[0]).toMatchObject({ type: "progress", used: 100, limit: 200 });
    expect(lines[1]).toMatchObject({ label: "孤立周期余量", value: "余 100 · 10月3日到期" });
  });

  it("2026-09-21 实测形态：data.Accounts 直挂 + 空串总量字段 + 同名套餐合并为一行", () => {
    // 真实响应形态：CapacitySizePrecise 为空串，余量/总量都在 Cycle 系字段；
    // 14 条同名「裂变包」（同一包的不同发放周期）+ 1 条已用尽的体验版
    const accounts: unknown[] = [
      {
        PackageName: "CodeBuddy个人版国内运营裂变包",
        CycleEndTime: "2026-10-09 09:01:56",
        CapacityRemainPrecise: "",
        CapacitySizePrecise: "",
        CycleCapacityRemainPrecise: "10.26000142",
        CycleCapacitySizePrecise: "100",
      },
      {
        PackageName: "CodeBuddy个人版国内运营裂变包",
        CycleEndTime: "2026-10-20 08:46:17",
        CapacityRemainPrecise: "",
        CapacitySizePrecise: "",
        CycleCapacityRemainPrecise: "100",
        CycleCapacitySizePrecise: "100",
      },
      {
        PackageName: "CodeBuddy个人体验版",
        CycleEndTime: "2026-09-30 23:59:59",
        CycleCapacityRemainPrecise: "0",
        CycleCapacitySizePrecise: "500",
        InUsage: true,
      },
    ];
    const lines = parseResourceLines(flatData(accounts));
    // 主行：余 110.26 / 700，已用 589.74
    expect(lines[0]).toMatchObject({ type: "progress", label: "积分余量" });
    expect(lines[0]!.used).toBeCloseTo(589.74, 5);
    expect(lines[0]!.limit).toBe(700);
    // 两个分组，按最早到期升序：体验版 9月30日（已用尽）在前，裂变包 10月9日在后
    expect(lines[1]).toEqual({
      type: "text",
      label: "CodeBuddy个人体验版",
      value: "余 0 · 9月30日到期",
    });
    expect(lines[2]).toEqual({
      type: "text",
      label: "CodeBuddy个人版国内运营裂变包",
      value: "余 110.26 · 10月9日到期",
    });
  });

  it("社区文档的 Response 包裹形态同样可解析（兼容另一端点）", () => {
    const lines = parseResourceLines(
      resourceData([totalPackage(), cyclePackage()]),
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]!.limit).toBe(3000);
  });
});

describe("parseStreakLine", () => {
  it("连登行：days≤0 或缺失不渲染", () => {
    expect(parseStreakLine({ streak: { days: 3 } })).toEqual({ type: "text", label: "连登", value: "3 天" });
    expect(parseStreakLine({ streak: { days: 0 } })).toBeNull();
    expect(parseStreakLine(undefined)).toBeNull();
  });
});

describe("parseExpiry / cstDateString", () => {
  it("服务端本地时间串按本地时区解析，秒/毫秒 epoch 亦兼容", () => {
    expect(parseExpiry("2026-10-01 10:00:00")?.getMinutes()).toBe(0);
    expect(parseExpiry(1_789_000_000)?.getTime()).toBe(1_789_000_000 * 1000);
    expect(parseExpiry("")).toBeNull();
    expect(parseExpiry(undefined)).toBeNull();
  });

  it("签到日界按 CST（UTC+8）计算：UTC 23 点已是次日", () => {
    // 2026-09-19T17:30:00Z → CST 2026-09-20 01:30
    expect(cstDateString(Date.UTC(2026, 8, 19, 17, 30))).toBe("2026-09-20");
    // 2026-09-19T15:59:00Z → CST 2026-09-19 23:59
    expect(cstDateString(Date.UTC(2026, 8, 19, 15, 59))).toBe("2026-09-19");
  });
});

describe("parseCheckinResult", () => {
  it("code=0 且带 credit → done", () => {
    expect(parseCheckinResult(httpResult({ code: 0, msg: "success", data: { credit: 30 } }))).toEqual({
      kind: "done",
      credit: 30,
    });
    // credit 缺失按 0 记（不因响应形态小差异丢通知）
    expect(parseCheckinResult(httpResult({ code: 0, msg: "success" }))).toEqual({ kind: "done", credit: 0 });
  });

  it("10001/14001 当日已签 → already（幂等）；实测走 HTTP 400 + 业务码，不能按状态码先拦", () => {
    expect(parseCheckinResult(httpResult({ code: 10001, msg: "今天已签到，请明天再来" }))).toEqual({
      kind: "already",
    });
    expect(parseCheckinResult(httpResult({ code: 10001, msg: "今天已签到，请明天再来" }, 400))).toEqual({
      kind: "already",
    });
    expect(parseCheckinResult(httpResult({ code: 14001, msg: "已签到" }))).toEqual({ kind: "already" });
  });

  it("无签到体系（未开启/inactive 等措辞）→ already，当日不再重试", () => {
    expect(parseCheckinResult(httpResult({ code: 1, msg: "活动未开启" }))).toEqual({ kind: "already" });
    expect(parseCheckinResult(httpResult({ code: 1, msg: "inactive" }))).toEqual({ kind: "already" });
  });

  it("HTTP 非 200 / 非 business 错误 / 解析失败 → fail（可重试）", () => {
    expect(parseCheckinResult(httpResult("unauthorized", 401))).toEqual({ kind: "fail" });
    expect(parseCheckinResult(httpResult({ code: 500, msg: "服务器内部错误" }))).toEqual({ kind: "fail" });
    expect(parseCheckinResult({ status: 200, headers: {}, bodyText: "<html>" })).toEqual({ kind: "fail" });
  });
});

describe("parseClaimResult", () => {
  it("code=0 → claimed；credit 与 reward_credit 字段都容（两家参考实现各实测其一）", () => {
    expect(parseClaimResult(httpResult({ code: 0, msg: "OK", data: { credit: 9 } }))).toEqual({
      kind: "claimed",
      credit: 9,
    });
    expect(parseClaimResult(httpResult({ code: 0, msg: "OK", data: { reward_credit: "12" } }))).toEqual({
      kind: "claimed",
      credit: 12,
    });
    // 到账数缺失按 0 记（照发通知，只是不带数量）
    expect(parseClaimResult(httpResult({ code: 0, msg: "OK" }))).toEqual({ kind: "claimed", credit: 0 });
  });

  it("无可领取（已领过/无到站记录）→ none，静默；其余可重试 → fail", () => {
    expect(parseClaimResult(httpResult({ code: 1, msg: "no unclaimed travel credits" }))).toEqual({ kind: "none" });
    expect(parseClaimResult(httpResult({ code: 500, msg: "no unclaimed travel credits" }, 400))).toEqual({
      kind: "none",
    });
    expect(parseClaimResult(httpResult({ code: 500, msg: "内部错误" }))).toEqual({ kind: "fail" });
    expect(parseClaimResult(httpResult("unauthorized", 401))).toEqual({ kind: "fail" });
  });
});

describe("parseTravelLine", () => {
  it("旅行中出目的地与预计回来时刻（本地墙钟）；到站/空闲/缺数据不出行", () => {
    const line = parseTravelLine({
      state: "traveling",
      location: { name: "咖啡馆" },
      arrive_at: 1789381435,
    });
    expect(line).toMatchObject({ type: "text", label: "喵喵旅行" });
    // 时刻随测试机时区变化，只锚定结构与固定段
    expect(line!.value).toMatch(/^旅行中 · 咖啡馆 · \d{2}:\d{2} 回来$/);
    expect(parseTravelLine({ state: "traveling" })!.value).toBe("旅行中");
    expect(parseTravelLine({ state: "arrived", location: { name: "咖啡馆" } })).toBeNull();
    expect(parseTravelLine({ state: "idle" })).toBeNull();
    expect(parseTravelLine(undefined)).toBeNull();
  });
});

describe("workbuddyProvider.fetch", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("无 Cookie 时快照为 needs_config，不发任何请求", async () => {
    const instance = makeInstance();
    mockInvoke.mockResolvedValueOnce(credentialStatus({ cookie: false }));
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("needs_config");
    expect(snapshot.message).toBe("请在设置中填写 WorkBuddy 登录 Cookie");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("每日首次刷新先签到后取数；新签成功时快照携带 checkin 字段", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 0, msg: "success", data: { credit: 30 } }),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult(streakPayload(3)),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.checkin).toEqual({ date: cstDateString(), credited: 30 });
    // 调用次序：凭据 → 签到 → 旅行状态 → 余额 → 连登
    const urls = mockInvoke.mock.calls.map((call) => (call[1] as { url?: string }).url);
    expect(urls).toEqual([
      undefined, // vault_credential_status 无 url 参数
      "https://www.workbuddy.cn/billing/meter/daily-checkin",
      "https://www.workbuddy.cn/activity/growth/buddy/travel/status",
      "https://www.workbuddy.cn/billing/meter/get-user-resource",
      "https://www.workbuddy.cn/activity/growth/streak",
    ]);
    // 请求体/头与参考实现对齐（审查修正）：通用端点 + Status [0,3] + 服务端滤过期 +
    // 显式 Content-Type（Rust body() 不自动补）
    const resourceCall = mockInvoke.mock.calls.find(
      (call) => (call[1] as { url?: string }).url === "https://www.workbuddy.cn/billing/meter/get-user-resource",
    )?.[1] as { headers?: Record<string, string>; bodyText?: string };
    expect(JSON.parse(resourceCall.bodyText!)).toMatchObject({
      PageNumber: 1,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      OnlyValidPeriod: true,
      NeedInUsage: true,
    });
    expect(resourceCall.headers).toMatchObject({ "Content-Type": "application/json" });
    // 卡片行：主行 + 明细 + 连登
    expect(snapshot.lines.map((line) => line.label)).toEqual(["积分余量", "月度套餐", "连登"]);
  });

  it("当日已签（10001）→ 不携带 checkin 字段、不发通知事件，同日再刷跳过签到调用", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "今天已签到" }),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult(streakPayload(2)),
    });
    const first = await workbuddyProvider.fetch(instance);
    expect(first.checkin).toBeUndefined();

    // 同一实例第二次刷新：内存标记生效，不再调用签到接口
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ cookie: true }))
      .mockResolvedValueOnce(httpResult({ code: 0, msg: "OK", data: {} }))
      .mockResolvedValueOnce(httpResult(resourcePayload([totalPackage()])))
      .mockResolvedValueOnce(httpResult(streakPayload(2)));
    await workbuddyProvider.fetch(instance);
    const checkinCalls = mockInvoke.mock.calls.filter(
      (call) => (call[1] as { url?: string }).url === "https://www.workbuddy.cn/billing/meter/daily-checkin",
    );
    expect(checkinCalls).toHaveLength(1);
  });

  it("签到失败不拖垮快照：不设标记，余额照常出 ok", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 500, msg: "服务器内部错误" }),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult(streakPayload(1)),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.checkin).toBeUndefined();
    expect(snapshot.lines.length).toBe(3);
  });

  it("连登源失败静默：无行、无 message，快照仍 ok", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "已签到" }),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult({ code: 500, msg: "error" }),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.lines.map((line) => line.label)).toEqual(["积分余量", "月度套餐"]);
  });

  it("余额 401 → 错误快照，message 指引重贴 Cookie", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "已签到" }),
      resource: httpResult("unauthorized", 401),
      streak: httpResult(streakPayload(1)),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("WorkBuddy 登录已过期，请重新复制 Cookie");
    expect(snapshot.lines).toHaveLength(0);
  });

  it("余额接口业务失败 → 错误快照带 code/msg 详情", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "已签到" }),
      resource: httpResult({ code: 500, msg: "内部错误" }),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("积分套餐查询失败：{detail}");
    expect(snapshot.messageParams).toMatchObject({ detail: "code=500 msg=内部错误" });
  });
});

describe("workbuddyProvider.fetch 喵喵旅行", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("到站自动领奖并出发：快照携带 travel 字段与旅行行，claim 带 record_id", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "今天已签到" }),
      travelStatus: travelStatusPayload(),
      travelClaim: httpResult({ code: 0, msg: "OK", data: { credit: 9 } }),
      travelDepart: travelOk,
      travelRecheck: travelStatusPayload({ state: "traveling" }),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult(streakPayload(1)),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.travel).toEqual({ tripKey: "1789370635", credited: 9 });
    expect(snapshot.lines.map((line) => line.label)).toEqual(["积分余量", "月度套餐", "喵喵旅行", "连登"]);
    // claim 带 record_id、depart 固定 location_id 1（两家参考实现交叉验证）
    const callOf = (url: string) =>
      mockInvoke.mock.calls.find((call) => (call[1] as { url?: string }).url === url)?.[1] as {
        bodyText?: string;
      };
    expect(JSON.parse(callOf("https://www.workbuddy.cn/activity/growth/buddy/travel/claim").bodyText!)).toEqual({
      record_id: 5068662,
    });
    expect(JSON.parse(callOf("https://www.workbuddy.cn/activity/growth/buddy/travel/depart").bodyText!)).toEqual({
      location_id: 1,
    });
  });

  it("同一行程跨刷新只领一次（内存行程键），但名额未用尽会继续出发", async () => {
    const instance = makeInstance();
    const firstMocks = {
      checkin: httpResult({ code: 10001, msg: "已签到" }),
      travelStatus: travelStatusPayload(),
      travelClaim: httpResult({ code: 0, msg: "OK", data: { credit: 9 } }),
      travelDepart: travelOk,
      travelRecheck: travelStatusPayload({ state: "traveling" }),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult(streakPayload(1)),
    };
    mockFetchSequence(firstMocks);
    await workbuddyProvider.fetch(instance);
    // 第二轮：同样的到站状态（同 depart_at）——claim 不再发起；出发照常（服务端节流兜底）
    mockInvoke
      .mockResolvedValueOnce(credentialStatus({ cookie: true }))
      .mockResolvedValueOnce(travelStatusPayload())
      .mockResolvedValueOnce(travelOk)
      .mockResolvedValueOnce(travelStatusPayload({ state: "traveling" }))
      .mockResolvedValueOnce(httpResult(resourcePayload([totalPackage()])))
      .mockResolvedValueOnce(httpResult(streakPayload(1)));
    await workbuddyProvider.fetch(instance);
    const claimCalls = mockInvoke.mock.calls.filter(
      (call) => (call[1] as { url?: string }).url?.endsWith("/travel/claim"),
    );
    expect(claimCalls).toHaveLength(1);
  });

  it("名额已用尽（daily_limit_reached）不出发，领奖照常", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "已签到" }),
      travelStatus: travelStatusPayload({ daily_limit_reached: true }),
      travelClaim: httpResult({ code: 0, msg: "OK", data: { reward_credit: 9 } }),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult(streakPayload(1)),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.travel).toEqual({ tripKey: "1789370635", credited: 9 });
    expect(snapshot.lines.map((line) => line.label)).toEqual(["积分余量", "月度套餐", "连登"]);
    expect(mockInvoke.mock.calls.some((call) => (call[1] as { url?: string }).url?.endsWith("/travel/depart"))).toBe(
      false,
    );
  });

  it("领奖失败静默：不写 travel 字段，快照仍 ok，下轮可重试", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "已签到" }),
      travelStatus: travelStatusPayload(),
      travelClaim: httpResult({ code: 500, msg: "内部错误" }),
      travelDepart: travelOk,
      travelRecheck: travelStatusPayload({ state: "traveling" }),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult(streakPayload(1)),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.travel).toBeUndefined();
  });

  it("旅行源整体失败静默：状态取不到就跳过状态机，不拖累快照", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "已签到" }),
      travelStatus: httpResult("unauthorized", 401),
      resource: httpResult(resourcePayload([totalPackage()])),
      streak: httpResult(streakPayload(1)),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.travel).toBeUndefined();
    expect(mockInvoke.mock.calls.some((call) => (call[1] as { url?: string }).url?.endsWith("/travel/claim"))).toBe(
      false,
    );
  });

  it("取数失败（401）的错误快照仍携带本轮已发生的领奖", async () => {
    const instance = makeInstance();
    mockFetchSequence({
      checkin: httpResult({ code: 10001, msg: "已签到" }),
      travelStatus: travelStatusPayload({ daily_limit_reached: true }),
      travelClaim: httpResult({ code: 0, msg: "OK", data: { credit: 9 } }),
      resource: httpResult("unauthorized", 401),
    });
    const snapshot = await workbuddyProvider.fetch(instance);
    expect(snapshot.status).toBe("error");
    expect(snapshot.travel).toEqual({ tripKey: "1789370635", credited: 9 });
  });
});
