import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance, ProviderSite } from "../types/ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { cstDateString } from "./workbuddy-channel";
import {
  fetchStreakFull,
  runGrowthButler,
  runTrialClaim,
  tierStatus,
  type GrowthContext,
} from "./workbuddy-growth";
import { GrowthNoticeDetector, buildButlerNoticeBody } from "../alerts/growth-notice-detector";
import { TrialDetector } from "../alerts/trial-detector";

const mockInvoke = vi.mocked(invoke);

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

/** 每个用例独立实例 id：growth 层的签到/管家/trial 幂等标记都按实例记录在模块级
 *  Map 里，同文件复用 id 会让后续用例被「当日已跑」短路 */
let nextId = 0;
const makeInstance = (site: ProviderSite = "china"): ProviderInstance => {
  nextId += 1;
  return {
    id: `wb-growth-${nextId}`,
    providerId: "workbuddy",
    note: "",
    sortOrder: 0,
    pinned: false,
    autoRefresh: true,
    threshold: null,
    balanceThreshold: null,
    site,
    tokenAutoRenew: true,
    createdAt: 0,
  };
};

const makeCtx = (channel: "token" | "cookie", site: ProviderSite = "china"): GrowthContext => ({
  instance: makeInstance(site),
  channel,
  site,
  capabilities:
    site === "china"
      ? { checkin: true, streak: true, travel: true, stats: true, tasks: true, butler: true, trial: false }
      : { checkin: false, streak: false, travel: false, stats: true, tasks: false, butler: false, trial: true },
  account: channel === "cookie" ? { uid: "uid-x", nickname: "nick" } : null,
});

/** 连登完整状态（参考 StreakFull 形状）：缺省 3 天、无卡、28d 档可兑、lottery 关闭 */
const streakPayload = (over: Record<string, unknown> = {}) =>
  httpResult({
    code: 0,
    msg: "OK",
    data: {
      streak: { days: 3, month_total_days: 3, next_tier: "7d", next_tier_remaining: 4 },
      makeup_cards: { balance: 0, max: 3 },
      redemption_status: {
        tiers: [{ tier: "7d", days: 7, credit: 100, energy: 5, cards: 1, chances: 1 }],
      },
      ...over,
    },
  });

/** 管家探测的按 URL 分发 mock（闭环节点固定响应；未声明的写动作请求直接抛错——
 *  用例没声明说明流程不该走到那里） */
const mockButler = (opts: {
  streak?: HttpResult[];
  heatmap?: HttpResult;
  makeupUse?: HttpResult;
  gift?: HttpResult;
  compensation?: HttpResult;
  redeem?: HttpResult[];
  lotterySummary?: HttpResult;
  lotteryDraw?: HttpResult[];
}) => {
  const streakQueue = [...(opts.streak ?? [])];
  const redeemQueue = [...(opts.redeem ?? [])];
  const drawQueue = [...(opts.lotteryDraw ?? [])];
  mockInvoke.mockImplementation(async (cmd: string, payload?: unknown) => {
    if (cmd !== "provider_request") throw new Error(`意外的命令：${cmd}`);
    const url =
      typeof payload === "object" && payload !== null
        ? String((payload as { url?: string }).url ?? "")
        : "";
    if (url.endsWith("/activity/growth/streak")) {
      return streakQueue.shift() ?? httpResult({ code: 0, msg: "OK", data: {} });
    }
    if (url.endsWith("/activity/growth/heatmap")) {
      return opts.heatmap ?? httpResult({ code: 0, msg: "OK", data: { cells: [] } });
    }
    if (url.endsWith("/makeup-cards/use")) {
      if (!opts.makeupUse) throw new Error(`意外的补签请求：${url}`);
      return opts.makeupUse;
    }
    if (url.endsWith("/claim-gift")) {
      return opts.gift ?? httpResult({ code: 9001, msg: "no gift" });
    }
    if (url.endsWith("/claim-compensation")) {
      return opts.compensation ?? httpResult({ code: 9002, msg: "no compensation" });
    }
    if (url.endsWith("/activity/growth/redeem")) {
      const next = redeemQueue.shift();
      if (next === undefined) throw new Error(`意外的兑换请求：${url}`);
      return next;
    }
    if (url.endsWith("/lottery/summary")) {
      return opts.lotterySummary ?? httpResult({ code: 0, msg: "OK", data: { chances: 0, module: { enabled: false } } });
    }
    if (url.endsWith("/lottery/draw")) {
      const next = drawQueue.shift();
      if (next === undefined) throw new Error(`意外的抽奖请求：${url}`);
      return next;
    }
    throw new Error(`意外的 provider_request：${url}`);
  });
  const callsOf = (suffix: string) =>
    mockInvoke.mock.calls
      .filter((call) => String((call[1] as { url?: string })?.url ?? "").endsWith(suffix))
      .map((call) => call[1] as { url: string; bodyText?: string; auth?: string });
  return { callsOf };
};

const today = cstDateString();

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("runGrowthButler（连登管家闭环，ADR-0037）", () => {
  it("完整闭环：昨日漏签+有卡→补签；礼包/补偿到账；档位兑换；抽完抽奖次数", async () => {
    const ctx = makeCtx("cookie");
    const yesterday = cstDateString(Date.now() - 86_400_000);
    mockButler({
      streak: [
        streakPayload({ makeup_cards: { balance: 2, max: 3 } }), // 兑换前（补签步消费）
        streakPayload({
          redemption_status: {
            tier_7d_status: "unlocked",
            tiers: [
              { tier: "7d", days: 7, credit: 100, energy: 5, cards: 1, chances: 1 },
              { tier: "14d", days: 14, credit: 200, energy: 10, cards: 2, chances: 2 },
            ],
          },
        }), // 兑换前
        streakPayload({ streak: { days: 4 } }), // 回读
      ],
      heatmap: httpResult({
        code: 0,
        msg: "OK",
        data: { cells: [{ date: yesterday, score: 0 }] },
      }),
      makeupUse: httpResult({ code: 0, msg: "OK" }),
      gift: httpResult({ code: 0, msg: "OK", data: { credit: 88 } }),
      compensation: httpResult({ code: 0, msg: "OK", data: { credit: 12 } }),
      redeem: [
        httpResult({ code: 0, msg: "OK" }),
        httpResult({ code: 0, msg: "OK" }),
      ],
      lotterySummary: httpResult({ code: 0, msg: "OK", data: { chances: 2, module: { enabled: true } } }),
      lotteryDraw: [
        httpResult({ code: 0, msg: "OK", data: { prize_name: "20 积分" } }),
        httpResult({ code: 0, msg: "OK", data: { name: "冰淇淋券" } }),
      ],
    });
    const outcome = await runGrowthButler(ctx, today);
    expect(outcome).not.toBeNull();
    expect(outcome!.makeupUsed).toBe(1);
    expect(outcome!.giftCredit).toBe(88);
    expect(outcome!.compensationCredit).toBe(12);
    expect(outcome!.redeemed).toEqual([
      { tier: "7d", credit: 100, energy: 5, cards: 1, chances: 1 },
      { tier: "14d", credit: 200, energy: 10, cards: 2, chances: 2 },
    ]);
    expect(outcome!.draws).toEqual(["20 积分", "冰淇淋券"]);
    expect(outcome!.streakDays).toBe(4);
    // 补签目标是昨天（CST）、兑换带 client_token 幂等令牌
    const makeupCalls = mockInvoke.mock.calls.filter((call) =>
      String((call[1] as { url?: string })?.url ?? "").endsWith("/makeup-cards/use"),
    );
    expect(JSON.parse((makeupCalls[0][1] as { bodyText: string }).bodyText)).toEqual({ target_date: yesterday });
    const redeemBody = JSON.parse(
      (mockInvoke.mock.calls.find((call) =>
        String((call[1] as { url?: string })?.url ?? "").endsWith("/activity/growth/redeem"),
      )?.[1] as { bodyText: string }).bodyText,
    );
    expect(redeemBody.tier).toBe("7d");
    expect(typeof redeemBody.client_token).toBe("string");
    expect(redeemBody.client_token.length).toBeGreaterThan(0);
  });

  it("当日标记：整轮无失败后当日重跑直接短路，不发任何请求", async () => {
    const ctx = makeCtx("cookie");
    mockButler({});
    const first = await runGrowthButler(ctx, today);
    expect(first!.makeupUsed).toBe(0);
    expect(first!.redeemed).toEqual([]);
    expect(first!.draws).toEqual([]);
    const callsAfterFirst = mockInvoke.mock.calls.length;
    const second = await runGrowthButler(ctx, today);
    expect(second).toBeNull();
    expect(mockInvoke.mock.calls.length).toBe(callsAfterFirst);
  });

  it("半失败不标记当日：礼包网络失败后重跑仍会发起请求（幂等补跑）", async () => {
    const ctx = makeCtx("cookie");
    mockButler({ gift: httpResult("network gone", 503) });
    const first = await runGrowthButler(ctx, today);
    expect(first!.giftCredit).toBe(0);
    mockInvoke.mockReset();
    mockButler({});
    const second = await runGrowthButler(ctx, today);
    expect(second).not.toBeNull();
  });

  it("locked/claimed 档位跳过，unlocked 才兑换；lottery 模块关闭不抽", async () => {
    const ctx = makeCtx("cookie");
    mockButler({
      streak: [
        streakPayload({
          redemption_status: {
            tier_7d_status: "claimed",
            tier_14d_status: "locked",
            tier_28d_status: "unlocked",
            tiers: [
              { tier: "7d", days: 7, credit: 100, energy: 5, cards: 1, chances: 1 },
              { tier: "14d", days: 14, credit: 200, energy: 10, cards: 2, chances: 2 },
              { tier: "28d", days: 28, credit: 400, energy: 20, cards: 3, chances: 3 },
            ],
          },
        }),
        streakPayload(),
      ],
      redeem: [httpResult({ code: 0, msg: "OK" })],
      lotterySummary: httpResult({ code: 0, msg: "OK", data: { chances: 3, module: { enabled: false } } }),
    });
    const outcome = await runGrowthButler(ctx, today);
    expect(outcome!.redeemed).toHaveLength(1);
    expect(outcome!.redeemed[0].tier).toBe("28d");
    expect(
      mockInvoke.mock.calls.some((call) =>
        String((call[1] as { url?: string })?.url ?? "").endsWith("/lottery/draw"),
      ),
    ).toBe(false);
  });

  it("域分流（ADR-0036 矩阵）：Cookie 通道 growth 写动作走 workbuddy.cn、礼包走 workbuddy.cn/billing/meter；token 通道走 copilot 与 codebuddy.cn/v2", async () => {
    const cookieCtx = makeCtx("cookie");
    mockButler({
      redeem: [httpResult({ code: 0, msg: "OK" })],
      streak: [
        streakPayload({
          redemption_status: { tiers: [{ tier: "7d", days: 7, credit: 100, energy: 5, cards: 0, chances: 0 }] },
        }),
        streakPayload(),
      ],
      lotterySummary: httpResult({ code: 0, msg: "OK", data: { chances: 0, module: { enabled: true } } }),
    });
    await runGrowthButler(cookieCtx, today);
    const urls = mockInvoke.mock.calls.map((call) => String((call[1] as { url?: string })?.url ?? ""));
    expect(urls).toContain("https://www.workbuddy.cn/activity/growth/redeem");
    expect(urls).toContain("https://www.workbuddy.cn/billing/meter/claim-gift");
    expect(urls).not.toContain("https://copilot.tencent.com/activity/growth/redeem");

    mockInvoke.mockReset();
    const tokenCtx = makeCtx("token");
    mockButler({
      redeem: [httpResult({ code: 0, msg: "OK" })],
      streak: [
        streakPayload({
          redemption_status: { tiers: [{ tier: "7d", days: 7, credit: 100, energy: 5, cards: 0, chances: 0 }] },
        }),
        streakPayload(),
      ],
      lotterySummary: httpResult({ code: 0, msg: "OK", data: { chances: 0, module: { enabled: true } } }),
    });
    await runGrowthButler(tokenCtx, today);
    const tokenUrls = mockInvoke.mock.calls.map((call) => String((call[1] as { url?: string })?.url ?? ""));
    expect(tokenUrls).toContain("https://copilot.tencent.com/activity/growth/redeem");
    expect(tokenUrls).toContain("https://www.codebuddy.cn/v2/billing/meter/claim-gift");
    expect(tokenUrls).not.toContain("https://www.workbuddy.cn/activity/growth/redeem");
  });

  it("无 butler 能力位（国际站）返回 null，不发任何请求", async () => {
    const ctx = makeCtx("cookie", "international");
    const outcome = await runGrowthButler(ctx, today);
    expect(outcome).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("tierStatus / fetchStreakFull", () => {
  it("顶层 tier_*_status 优先，tiers[] 条目兜底，未知档位按 locked", () => {
    const full = {
      redemption_status: {
        tier_7d_status: "claimed",
        tiers: [{ tier: "14d", days: 14, credit: 200, energy: 10, cards: 0, chances: 0 }],
      },
    };
    expect(tierStatus(full as never, "7d")).toBe("claimed");
    expect(tierStatus(full as never, "14d")).toBe("unlocked");
    expect(tierStatus(full as never, "28d")).toBe("locked");
  });

  it("fetchStreakFull：信封失败/非 200 返回 null（辅助源静默）", async () => {
    const ctx = makeCtx("cookie");
    mockInvoke.mockResolvedValueOnce(httpResult({ code: 500, msg: "error" }));
    expect(await fetchStreakFull(ctx)).toBeNull();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValueOnce(httpResult("gateway error", 502));
    expect(await fetchStreakFull(ctx)).toBeNull();
  });
});

describe("runTrialClaim（国际站试用加油包，ADR-0037）", () => {
  it("领取成功返回到账并永久标记；重启语义由调用方刷新体现", async () => {
    const ctx = makeCtx("token", "international");
    mockInvoke.mockResolvedValueOnce(httpResult({ code: 0, msg: "OK", data: { credit: 500 } }));
    const first = await runTrialClaim(ctx);
    expect(first).toEqual({ credit: 500 });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // 进程内标记：不再发第二次
    expect(await runTrialClaim(ctx)).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("已领取（幂等码 14051）与 4xx 都永久静默", async () => {
    const ctx = makeCtx("token", "international");
    mockInvoke.mockResolvedValueOnce(httpResult({ code: 14051, msg: "已领取过" }, 400));
    expect(await runTrialClaim(ctx)).toBeUndefined();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValueOnce(httpResult("not found", 404));
    expect(await runTrialClaim(makeCtx("token", "international"))).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("国区实例无 trial 能力位：不发请求", async () => {
    const ctx = makeCtx("cookie");
    expect(await runTrialClaim(ctx)).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("通知检测器", () => {
  it("buildButlerNoticeBody：积分能量/补签/纯抽奖的组合枚举", () => {
    expect(buildButlerNoticeBody(100, 5, 0)).toBe("成长中心到账 +{credit} 积分 +{energy} 能量");
    expect(buildButlerNoticeBody(100, 5, 1)).toBe(
      "成长中心到账 +{credit} 积分 +{energy} 能量；已用补签卡补签昨日",
    );
    expect(buildButlerNoticeBody(100, 0, 0)).toBe("成长中心到账 +{credit} 积分");
    expect(buildButlerNoticeBody(0, 0, 1)).toBe("已用补签卡补签昨日，连登已保住");
    // 纯抽奖有奖（奖品不含积分）：中性事实，不出「到账 +0 积分」
    expect(buildButlerNoticeBody(0, 0, 0)).toBe("成长中心奖励已领取");
  });

  it("GrowthNoticeDetector：同日重放跳过；prune 后重报（换实例场景）", () => {
    const arrivals: string[] = [];
    const detector = new GrowthNoticeDetector({
      notify: (arrival) => arrivals.push(arrival.body),
      onStateChange: () => undefined,
    });
    const instance = makeInstance();
    const snapshot = {
      status: "ok",
      growthNotice: {
        date: "2026-09-27",
        makeupUsed: 1,
        giftCredit: 0,
        compensationCredit: 0,
        redeemed: [{ tier: "7d", credit: 100, energy: 5, cards: 1, chances: 1 }],
        draws: [],
      },
    } as never;
    detector.observe(instance, snapshot);
    detector.observe(instance, snapshot);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toBe("成长中心到账 +{credit} 积分 +{energy} 能量；已用补签卡补签昨日");
    detector.hydrate([{ instance_id: instance.id, notified_date: "2026-09-27" }]);
    detector.observe(instance, snapshot);
    expect(arrivals).toHaveLength(1);
  });

  it("TrialDetector：实例级一次性判重，hydrate 播种后重放不再通知", () => {
    const arrivals: string[] = [];
    const detector = new TrialDetector({
      notify: (arrival) => arrivals.push(arrival.body),
      onStateChange: () => undefined,
    });
    const instance = makeInstance("international");
    const snapshot = { status: "ok", trial: { credit: 500 } } as never;
    detector.observe(instance, snapshot);
    detector.observe(instance, snapshot);
    expect(arrivals).toEqual(["试用加油包已领取（+{credit} 积分）"]);
    detector.hydrate([{ instance_id: instance.id, claimed: true }]);
    detector.observe(instance, snapshot);
    expect(arrivals).toHaveLength(1);
  });
});
