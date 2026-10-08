import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance, ProviderSite } from "../types/ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { wbStateKind, type WorkbuddyStateRecord } from "../lib/workbuddy-states";
import { cstDateString } from "./workbuddy-channel";
import {
  createGrowthContext,
  fetchStreakFull,
  loadActivityStatus,
  loadLastButlerRecord,
  runDailyActivityReport,
  runGrowthButler,
  runTrialClaim,
  tierStatus,
  type GrowthContext,
} from "./workbuddy-growth";
import { GrowthNoticeDetector, buildButlerNoticeBody } from "../alerts/growth-notice-detector";
import { TrialDetector } from "../alerts/trial-detector";

const mockInvoke = vi.mocked(invoke);

/** workbuddy_states 的测试替身（ADR-0039）：一张 Map 充当表。
 *  「当日已跑就短路」「trial 永久静默」这些用例判的就是格子里的值，替身必须真的
 *  存得下、读得回，否则用例通过只证明了读不到格子时的兜底路径 */
const states = new Map<string, string>();

const stateKey = (instanceId: string, kind: string): string => `${instanceId}:${kind}`;

/** 拦下两个判据命令并给出返回值；handled=false 表示这条 invoke 不是判据命令 */
const handleStateCommand = (
  cmd: string,
  payload?: unknown,
): { handled: true; value: string | null } | { handled: false } => {
  if (cmd === "get_workbuddy_state") {
    const { instanceId, kind } = payload as { instanceId: string; kind: string };
    return { handled: true, value: states.get(stateKey(instanceId, kind)) ?? null };
  }
  if (cmd === "save_workbuddy_state") {
    const { record } = payload as {
      record: { instance_id: string; kind: string; value: string };
    };
    states.set(stateKey(record.instance_id, record.kind), record.value);
    return { handled: true, value: null };
  }
  return { handled: false };
};

/** 只统计真实 HTTP 出站（provider_request）——判据读写也是 invoke，
 *  「发了几次请求」的断言不能被格子操作污染 */
const httpCalls = () => mockInvoke.mock.calls.filter((call) => call[0] === "provider_request");

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

/** 每个用例独立实例 id：growth 层的签到/管家/trial 判据都按 (实例, 格子) 记在
 *  workbuddy_states，同文件复用 id 会让后续用例被「当日已跑」短路 */
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
      ? { checkin: true, streak: true, activity: true, travel: true, stats: true, tasks: true, butler: true, trial: false }
      : { checkin: false, streak: true, activity: true, travel: false, stats: true, tasks: false, butler: false, trial: true },
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
    const state = handleStateCommand(cmd, payload);
    if (state.handled) return state.value;
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
  // 判据表按用例清空：格子按 (实例, kind) 存，用例之间即使用了独立实例 id，
  // 也不该被上一个用例写过的「当日已跑」之类的判据影响
  states.clear();
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
    expect(states.get(stateKey(ctx.instance.id, "butler_acted"))).toBe(today);
    const callsAfterFirst = httpCalls().length;
    const second = await runGrowthButler(ctx, today);
    expect(second).toBeNull();
    expect(httpCalls().length).toBe(callsAfterFirst);
  });

  it("force（抽屉「领取全部奖励」）：当日标记已打也照跑，返回可显示的空结果", async () => {
    const ctx = makeCtx("cookie");
    mockButler({});
    expect(await runGrowthButler(ctx, today)).not.toBeNull();
    // 无 force 已被短路；带 force 必须真跑一遍，返回全零字段而非 null（抽屉才有东西可显示）
    mockInvoke.mockReset();
    mockButler({});
    const forced = await runGrowthButler(ctx, today, null, { force: true });
    expect(forced).not.toBeNull();
    expect(forced!.date).toBe(today);
    expect(forced!.makeupUsed).toBe(0);
    expect(forced!.giftCredit).toBe(0);
    expect(forced!.compensationCredit).toBe(0);
    expect(forced!.redeemed).toEqual([]);
    expect(forced!.draws).toEqual([]);
    expect(mockInvoke.mock.calls.length).toBeGreaterThan(0);
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

describe("loadLastButlerRecord（抽屉「最近一次领取」读 butler_detail 格）", () => {
  it("格里有明细 → 解析成明细；无格 / JSON 坏 / 读失败 → null（辅助源静默）", async () => {
    const detail = {
      date: "2026-09-27",
      makeupUsed: 1,
      giftCredit: 0,
      compensationCredit: 0,
      redeemed: [{ tier: "7d", credit: 100, energy: 5, cards: 1, chances: 1 }],
      draws: ["20 积分"],
    };
    mockInvoke.mockImplementation(async (cmd: string, payload?: unknown) => {
      const state = handleStateCommand(cmd, payload);
      if (state.handled) return state.value;
      throw new Error(`意外的命令：${cmd}`);
    });
    states.set(stateKey("x", "butler_detail"), JSON.stringify(detail));
    expect(await loadLastButlerRecord("x")).toEqual(detail);

    // 从没写过这格（新实例、或升级当天旧留档不搬）：抽屉那段照旧不显示
    states.clear();
    expect(await loadLastButlerRecord("x")).toBeNull();

    states.set(stateKey("x", "butler_detail"), "{坏");
    expect(await loadLastButlerRecord("x")).toBeNull();

    // 读库本身失败（凭据库锁定等）：留档是展示辅助源，不报错、不阻断抽屉其余部分
    states.clear();
    mockInvoke.mockImplementation(async () => {
      throw new Error("db locked");
    });
    expect(await loadLastButlerRecord("x")).toBeNull();
  });
});

describe("runTrialClaim（国际站试用加油包，ADR-0037）", () => {
  /** trial 用例的出站替身：判据读写落到 states 表，provider_request 单独计数 */
  const mockTrial = (respond: () => HttpResult) => {
    let requests = 0;
    mockInvoke.mockImplementation(async (cmd: string, payload?: unknown) => {
      const state = handleStateCommand(cmd, payload);
      if (state.handled) return state.value;
      if (cmd !== "provider_request") throw new Error(`意外的命令：${cmd}`);
      requests += 1;
      return respond();
    });
    return () => requests;
  };

  it("领取成功返回到账并永久写格；同实例不再发第二次请求（重启后读库同样短路）", async () => {
    const ctx = makeCtx("token", "international");
    const requests = mockTrial(() => httpResult({ code: 0, msg: "OK", data: { credit: 500 } }));
    const first = await runTrialClaim(ctx);
    expect(first).toEqual({ credit: 500 });
    expect(requests()).toBe(1);
    expect(states.get(stateKey(ctx.instance.id, "trial_acted"))).toBe("1");
    expect(await runTrialClaim(ctx)).toBeUndefined();
    expect(requests()).toBe(1);
  });

  it("已领取（幂等码 14051）与 4xx 都永久写格静默", async () => {
    const ctx = makeCtx("token", "international");
    const requests = mockTrial(() => httpResult({ code: 14051, msg: "已领取过" }, 400));
    expect(await runTrialClaim(ctx)).toBeUndefined();
    expect(requests()).toBe(1);
    expect(states.get(stateKey(ctx.instance.id, "trial_acted"))).toBe("1");
    // 端点 404（该站根本没这个福利）同样写格——反复试探没有意义
    const other = makeCtx("token", "international");
    const otherRequests = mockTrial(() => httpResult("not found", 404));
    expect(await runTrialClaim(other)).toBeUndefined();
    expect(otherRequests()).toBe(1);
    expect(states.get(stateKey(other.instance.id, "trial_acted"))).toBe("1");
  });

  it("网络/5xx 失败不写格：下轮刷新还会再试一次", async () => {
    const ctx = makeCtx("token", "international");
    const requests = mockTrial(() => httpResult("gateway down", 503));
    expect(await runTrialClaim(ctx)).toBeUndefined();
    expect(states.get(stateKey(ctx.instance.id, "trial_acted"))).toBeUndefined();
    expect(await runTrialClaim(ctx)).toBeUndefined();
    expect(requests()).toBe(2);
  });

  it("国区实例无 trial 能力位：不发请求", async () => {
    const ctx = makeCtx("cookie");
    expect(await runTrialClaim(ctx)).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("runDailyActivityReport（活跃上报点亮连登，ADR-0039）", () => {
  /** 活跃上报的出站替身：判据落到 states 表，report 族请求记录下来供断言 */
  const mockReport = (opts: { report?: HttpResult; account?: HttpResult } = {}) => {
    const sent: { url: string; bodyText: string; headers: Record<string, string>; auth: string }[] = [];
    mockInvoke.mockImplementation(async (cmd: string, payload?: unknown) => {
      const state = handleStateCommand(cmd, payload);
      if (state.handled) return state.value;
      if (cmd === "vault_credential_status") {
        return { session: true, session2: true, userAgent: true };
      }
      if (cmd !== "provider_request") throw new Error(`意外的命令：${cmd}`);
      const args = payload as {
        url: string;
        bodyText?: string;
        headers?: Record<string, string>;
        auth?: string;
      };
      if (args.url.endsWith("/v2/report")) {
        sent.push({
          url: args.url,
          bodyText: args.bodyText ?? "",
          headers: args.headers ?? {},
          auth: args.auth ?? "",
        });
        return opts.report ?? httpResult({ code: 0, msg: "OK" });
      }
      if (args.url.endsWith("/console/account")) {
        return (
          opts.account ??
          httpResult({ code: 0, msg: "OK", data: { uid: "u-live", nickname: "nick" } })
        );
      }
      throw new Error(`意外的 provider_request：${args.url}`);
    });
    return sent;
  };

  const readStatus = (instanceId: string) =>
    JSON.parse(String(states.get(stateKey(instanceId, "activity_status"))));

  it("token 通道：一条 chat_request_send 打 codebuddy.cn/v2/report，uid 留占位符交 Rust 替换", async () => {
    const ctx = makeCtx("token");
    const sent = mockReport();
    expect(await runDailyActivityReport(ctx, today)).toEqual({ status: "reported" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://www.codebuddy.cn/v2/report");
    expect(sent[0].auth).toBe("workbuddy_report");
    const event = JSON.parse(sent[0].bodyText)[0];
    expect(event.eventCode).toBe("chat_request_send");
    expect(event.userId).toBe("{{WB_UID}}");
    expect(states.get(stateKey(ctx.instance.id, "activity_acted"))).toBe(today);
    expect(readStatus(ctx.instance.id)).toEqual({ date: today, status: "reported" });
  });

  it("Cookie 通道：前端把 uid 替进事件体，走 web 头族（ADR-0036 spike 实证组合）", async () => {
    const ctx = makeCtx("cookie");
    const sent = mockReport();
    expect(await runDailyActivityReport(ctx, today)).toEqual({ status: "reported" });
    const event = JSON.parse(sent[0].bodyText)[0];
    expect(event.userId).toBe("uid-x");
    expect(sent[0].auth).toBe("session_cookie");
    expect(sent[0].headers["x-client-platform"]).toBe("web");
  });

  it("拿不到 uid 就不发：不发出站、记 skipped、不写 acted（缺 uid 的上报不计分，白发）", async () => {
    const ctx = { ...makeCtx("cookie"), account: null };
    const sent = mockReport();
    expect(await runDailyActivityReport(ctx, today)).toEqual({ status: "skipped" });
    expect(sent).toHaveLength(0);
    expect(states.get(stateKey(ctx.instance.id, "activity_acted"))).toBeUndefined();
    expect(readStatus(ctx.instance.id).status).toBe("skipped");
  });

  it("同一天再刷短路：每号每天 1 次的风控口径跨重启成立", async () => {
    const ctx = makeCtx("token");
    const sent = mockReport();
    await runDailyActivityReport(ctx, today);
    expect(await runDailyActivityReport(ctx, today)).toEqual({ status: "already" });
    expect(sent).toHaveLength(1);
  });

  it("上报失败：不写 acted（下轮真的重试），上游原文进 activity_status 格给抽屉看", async () => {
    const ctx = makeCtx("token");
    const sent = mockReport({ report: httpResult("unauthorized", 401) });
    expect(await runDailyActivityReport(ctx, today)).toEqual({
      status: "failed",
      detail: "HTTP 401",
    });
    expect(states.get(stateKey(ctx.instance.id, "activity_acted"))).toBeUndefined();
    expect(readStatus(ctx.instance.id)).toEqual({
      date: today,
      status: "failed",
      detail: "HTTP 401",
    });
    await runDailyActivityReport(ctx, today);
    expect(sent).toHaveLength(2);
  });

  it("事件体保持参考实现的完整形状（三十余字段一个不删，防上游加严）", async () => {
    const ctx = makeCtx("token");
    const sent = mockReport();
    await runDailyActivityReport(ctx, today);
    const event = JSON.parse(sent[0].bodyText)[0];
    for (const field of [
      "mode",
      "conversationId",
      "requestId",
      "inputLength",
      "requestModelId",
      "requestModelName",
      "isPlan",
      "isAutoExecuteTerminal",
      "mentionContexts",
      "knowledgeId",
      "skillCount",
      "agentName",
      "agentType",
      "presentAt",
      "rootRequestId",
      "parentConversationId",
      "userId",
    ]) {
      expect(event, field).toHaveProperty(field);
    }
    expect(Object.keys(event).length).toBeGreaterThanOrEqual(30);
  });

  it("loadActivityStatus：今天的格子读回；昨天/坏 JSON/无格都不算今天的状态", async () => {
    const instance = makeInstance();
    mockReport();
    states.set(
      stateKey(instance.id, "activity_status"),
      JSON.stringify({ date: today, status: "failed", detail: "HTTP 401" }),
    );
    expect(await loadActivityStatus(instance.id, today)).toEqual({
      date: today,
      status: "failed",
      detail: "HTTP 401",
    });
    states.set(
      stateKey(instance.id, "activity_status"),
      JSON.stringify({ date: "2026-01-01", status: "reported" }),
    );
    expect(await loadActivityStatus(instance.id, today)).toBeNull();
    states.set(stateKey(instance.id, "activity_status"), "{坏");
    expect(await loadActivityStatus(instance.id, today)).toBeNull();
    states.clear();
    expect(await loadActivityStatus(instance.id, today)).toBeNull();
  });

  it("Cookie 通道 console/account 失败时回落 cookie_account 格：uid 取到过一次就复用", async () => {
    const instance = makeInstance();
    states.set(stateKey(instance.id, "cookie_account"), JSON.stringify({ uid: "u-stored", nickname: "旧昵称" }));
    mockReport({ account: httpResult("gateway down", 503) });
    const ctx = await createGrowthContext(instance);
    expect(ctx?.channel).toBe("cookie");
    expect(ctx?.account).toEqual({ uid: "u-stored", nickname: "旧昵称" });
    // 回落成功不等于覆盖：本轮没取到新值，格子里还是原来那一份
    expect(JSON.parse(String(states.get(stateKey(instance.id, "cookie_account")))).uid).toBe(
      "u-stored",
    );
  });

  it("Cookie 通道取到 uid 即落格：下一次刷新不再依赖 console/account 活着", async () => {
    const instance = makeInstance();
    mockReport();
    const ctx = await createGrowthContext(instance);
    expect(ctx?.account?.uid).toBe("u-live");
    expect(JSON.parse(String(states.get(stateKey(instance.id, "cookie_account")))).uid).toBe(
      "u-live",
    );
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

  it("GrowthNoticeDetector：同日重放跳过；通知判重与留档明细各写一格", () => {
    const arrivals: string[] = [];
    const records: WorkbuddyStateRecord[] = [];
    const detector = new GrowthNoticeDetector({
      notify: (arrival) => arrivals.push(arrival.body),
      onStateChange: (written) => records.push(...written),
    });
    const instance = makeInstance();
    const notice = {
      date: "2026-09-27",
      makeupUsed: 1,
      giftCredit: 0,
      compensationCredit: 0,
      redeemed: [{ tier: "7d", credit: 100, energy: 5, cards: 1, chances: 1 }],
      draws: [],
    };
    const snapshot = { status: "ok", growthNotice: notice } as never;
    detector.observe(instance, snapshot);
    detector.observe(instance, snapshot);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toBe("成长中心到账 +{credit} 积分 +{energy} 能量；已用补签卡补签昨日");
    // 两格一起回写：butler_notified（按日通知判重）+ butler_detail（抽屉「最近一次领取」
    // 的唯一持久留档——快照上的 growthNotice 会被下轮刷新覆盖）
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      instance_id: instance.id,
      kind: wbStateKind.butlerNotified,
      value: "2026-09-27",
    });
    expect(records[1].kind).toBe(wbStateKind.butlerDetail);
    expect(JSON.parse(records[1].value)).toEqual(notice);
    detector.hydrate([{ instance_id: instance.id, kind: wbStateKind.butlerNotified, value: "2026-09-27" }]);
    detector.observe(instance, snapshot);
    expect(arrivals).toHaveLength(1);
  });

  it("TrialDetector：实例级一次性判重，hydrate 播种后重放不再通知", () => {
    const arrivals: string[] = [];
    const records: WorkbuddyStateRecord[] = [];
    const detector = new TrialDetector({
      notify: (arrival) => arrivals.push(arrival.body),
      onStateChange: (record) => records.push(record),
    });
    const instance = makeInstance("international");
    const snapshot = { status: "ok", trial: { credit: 500 } } as never;
    detector.observe(instance, snapshot);
    detector.observe(instance, snapshot);
    expect(arrivals).toEqual(["试用加油包已领取（+{credit} 积分）"]);
    expect(records).toEqual([
      { instance_id: instance.id, kind: wbStateKind.trialNotified, value: "1" },
    ]);
    detector.hydrate([{ instance_id: instance.id, kind: wbStateKind.trialNotified, value: "1" }]);
    detector.observe(instance, snapshot);
    expect(arrivals).toHaveLength(1);
  });
});
