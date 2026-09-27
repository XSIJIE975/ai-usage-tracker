import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance } from "../types/ipc";
import {
  layerTasks,
  parseClaimReward,
  parseGrowthTasks,
  runWorkbuddyTask,
  fetchWorkbuddyTasks,
  deriveDeviceId,
  type WorkbuddyTask,
} from "./workbuddy-tasks";

const mockInvoke = vi.mocked(invoke);

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

const makeInstance = (): ProviderInstance => ({
  id: "wb-tasks-1",
  providerId: "workbuddy",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
  balanceThreshold: null,
  site: "china",
  tokenAutoRenew: true,
  createdAt: 0,
});

/** 任务域上下文（ADR-0037 起 GrowthContext 携带站点与能力位；测试默认国区全能力） */
const makeCtx = (channel: "token" | "cookie", account: { uid: string; nickname: string } | null = channel === "cookie" ? { uid: "uid-x", nickname: "nick" } : null) => ({
  instance: makeInstance(),
  channel,
  site: "china" as const,
  capabilities: { checkin: true, streak: true, travel: true, stats: true, tasks: true, butler: true, trial: false },
  account,
});

const task = (over: Partial<WorkbuddyTask>): WorkbuddyTask => ({
  taskCode: "chat_5",
  title: "",
  description: "",
  rewardCredit: 100,
  rewardEnergy: 0,
  target: 5,
  current: 0,
  acceptStatus: "",
  claimed: false,
  claimable: false,
  locked: false,
  isMp: false,
  ...over,
});

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("parseGrowthTasks", () => {
  it("解析平铺形状并本地推算 claimable", () => {
    const tasks = parseGrowthTasks(
      {
        tasks: [
          { task_code: "chat_5", title: "完成5次对话", reward_credit: 100, target: 5, current: 5, accept_status: "accepted" },
          { task_code: "first_buddy", reward_credit: 300, accept_status: "claimed" },
        ],
      },
      false,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].claimable).toBe(true);
    expect(tasks[0].claimed).toBe(false);
    expect(tasks[1].claimed).toBe(true);
    expect(tasks[1].claimable).toBe(false);
  });

  it("progress 对象形状覆盖平铺字段，缺 task_code 的条目丢弃", () => {
    const tasks = parseGrowthTasks(
      {
        tasks: [
          { task_code: "RichMeow_Chat", progress: { current: 1, target: 1 }, current: 0, target: 0 },
          { title: "无码条目" },
        ],
      },
      false,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskCode).toBe("RichMeow_Chat");
    expect(tasks[0].current).toBe(1);
    expect(tasks[0].target).toBe(1);
  });

  it("isMp 标记随口径传入", () => {
    const [mp] = parseGrowthTasks({ tasks: [{ task_code: "Sequential_Tasks_1" }] }, true);
    expect(mp.isMp).toBe(true);
  });
});

describe("layerTasks", () => {
  it("三层分层：可自动完成 / 可领取（含真实对话类达标未领）/ 已完成", () => {
    const layers = layerTasks([
      task({ taskCode: "chat_5", current: 0, target: 5 }),
      // 真实对话类达标未领 → 只进可领取层（不自动执行，ADR-0036）
      task({ taskCode: "Model_chat_GLM5.2", current: 1, target: 1 }),
      task({ taskCode: "first_buddy", claimed: true }),
      // 未登记的官方任务码（如补签/礼包类）不显示
      task({ taskCode: "backfill_card", current: 0, target: 1 }),
    ]);
    expect(layers.automatable.map((item) => item.taskCode)).toEqual(["chat_5"]);
    expect(layers.claimable.map((item) => item.taskCode)).toEqual(["Model_chat_GLM5.2"]);
    expect(layers.done.map((item) => item.taskCode)).toEqual(["first_buddy"]);
  });

  it("locked 不进可自动完成层（Sequential 链每日解锁，未解锁的扫进来只会失败）", () => {
    const layers = layerTasks([task({ taskCode: "create_canvas", locked: true })]);
    expect(layers.automatable).toHaveLength(0);
    expect(layers.claimable).toHaveLength(0);
    expect(layers.done).toHaveLength(0);
  });

  it("可自动完成层按动作表依赖序排列（领养链前置在前）", () => {
    const layers = layerTasks([
      task({ taskCode: "chat_5" }),
      task({ taskCode: "first_buddy", target: 1 }),
      task({ taskCode: "create_canvas", target: 1 }),
    ]);
    const codes = layers.automatable.map((item) => item.taskCode);
    expect(codes.indexOf("first_buddy")).toBeLessThan(codes.indexOf("create_canvas"));
  });
});

describe("fetchWorkbuddyTasks", () => {
  it("双口径合并：mp 列表按 task_code 去重、默认口径优先", async () => {
    mockInvoke
      // 默认口径：两个任务
      .mockResolvedValueOnce(
        httpResult({
          code: 0,
          data: {
            tasks: [
              { task_code: "chat_5", title: "默认口径对话" },
              { task_code: "first_buddy" },
            ],
          },
        }),
      )
      // mp 口径超集：多出 mp 专属任务 + 与默认重复的 chat_5（后者被去重丢弃）
      .mockResolvedValueOnce(
        httpResult({
          code: 0,
          data: {
            tasks: [
              { task_code: "chat_5", title: "mp 口径对话" },
              { task_code: "Sequential_Tasks_1" },
            ],
          },
        }),
      );
    const { tasks } = await fetchWorkbuddyTasks(makeCtx("token"));
    expect(tasks).toHaveLength(3);
    const chat5 = tasks.find((item) => item.taskCode === "chat_5");
    expect(chat5?.title).toBe("默认口径对话");
    expect(tasks.find((item) => item.taskCode === "Sequential_Tasks_1")?.isMp).toBe(true);
  });

  it("默认口径失败返回错误；mp 失败静默（默认口径结果照常返回）", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResult({ code: 12153, msg: "token expired" }, 200))
      .mockResolvedValueOnce(httpResult({ code: 0, data: { tasks: [] } }));
    const failed = await fetchWorkbuddyTasks(makeCtx("token"));
    expect(failed.error).toBe("任务列表获取失败：{detail}");
    expect(failed.errorParams).toEqual({ detail: "token expired" });

    mockInvoke
      .mockResolvedValueOnce(httpResult({ code: 0, data: { tasks: [{ task_code: "chat_5" }] } }))
      .mockRejectedValueOnce(new Error("network down"));
    const ok = await fetchWorkbuddyTasks(makeCtx("token"));
    expect(ok.tasks).toHaveLength(1);
    expect(ok.error).toBeUndefined();
  });
});

describe("runWorkbuddyTask", () => {
  it("Cookie 通道的事件上报走 codebuddy 域 + web 头族（copilot report 不认 Cookie 会话，真机 401）", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResult({ code: 0, msg: "OK" }))
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "RichMeow_Chat", target: 1, current: 1, accept_status: "claimed" }] } }),
      )
      .mockResolvedValueOnce(httpResult({ code: 0, data: { tasks: [] } }));
    await runWorkbuddyTask(
      makeCtx("cookie"),
      task({ taskCode: "RichMeow_Chat", target: 1, current: 0 }),
    );
    const reportCall = mockInvoke.mock.calls.find(([, args]) =>
      String((args as Record<string, unknown>)?.["url"]).endsWith("/v2/report"),
    );
    const args = reportCall?.[1] as Record<string, unknown>;
    expect(args?.["url"]).toBe("https://www.codebuddy.cn/v2/report");
    expect(args?.["auth"]).toBe("session_cookie");
    const headers = args?.["headers"] as Record<string, string>;
    expect(headers["x-client-platform"]).toBe("web");
    expect(headers["X-User-Id"]).toBe("uid-x");
    // 事件体占位符在前端替换（Cookie 通道）
    const body = String(args?.["bodyText"]);
    expect(body).toContain('"userId":"uid-x"');
    expect(body).not.toContain("{{WB_UID}}");
  });

  it("Cookie 通道的 growth 写动作走 workbuddy.cn 无 /v2（copilot 对 POST 一律要 Bearer，accept 真机 401）", async () => {
    // mp 任务 accept：cookie 通道 → workbuddy.cn/activity/growth/tasks/accept（无 /v2）。
    // 回读按 isMp 只拉 mp 口径（单口径），invoke 序列：
    // 1 前置读(mp 列表,not_accepted) → 2 accept → 3 回读(mp 列表,accepted) →
    // 4 专家市场列表 → 5 mp report → 6 回读(mp 列表,达标) → 7 web 域 claim
    mockInvoke
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "Sequential_Tasks_2", accept_status: "not_accepted" }] } }),
      )
      .mockResolvedValueOnce(httpResult({ code: 0, msg: "OK" }))
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "Sequential_Tasks_2", accept_status: "accepted" }] } }),
      )
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { experts: [{ expert_id: "ex_test", display_name_zh: "测试专家" }] } }),
      )
      .mockResolvedValueOnce(httpResult({ code: 0, msg: "OK" }))
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "Sequential_Tasks_2", target: 1, current: 1, accept_status: "accepted" }] } }),
      )
      .mockResolvedValueOnce(httpResult({ code: 0, data: { already_claimed: false, credit: 200 } }));
    const result = await runWorkbuddyTask(
      makeCtx("cookie"),
      task({ taskCode: "Sequential_Tasks_2", isMp: true, acceptStatus: "not_accepted", target: 1 }),
    );
    const urls = mockInvoke.mock.calls.map(([, args]) => String((args as Record<string, unknown>)?.["url"]));
    expect(urls).toContain("https://www.workbuddy.cn/activity/growth/tasks/accept");
    expect(urls).not.toContain("https://copilot.tencent.com/v2/activity/growth/tasks/accept");
    // mp claim 在 Cookie 通道直接走 web 域（spike 已证 Cookie 领奖）
    expect(urls).toContain("https://www.workbuddy.cn/activity/growth/tasks/Sequential_Tasks_2/claim");
    expect(result.credit).toBe(200);
    expect(result.message).toBe("{message}；已自动领取 +{credit} 分");
  });

  it("mp accept 的 HTTP 401 按凭据失效抛错，不混同「每日锁定窗口」", async () => {
    mockInvoke.mockResolvedValue(httpResult("<html>401 Authorization Required</html>", 401));
    await expect(
      runWorkbuddyTask(
        makeCtx("cookie"),
        task({ taskCode: "school_season", isMp: true, acceptStatus: "not_accepted" }),
      ),
    ).rejects.toMatchObject({
      message: "任务接受失败（HTTP {status}），请刷新登录状态后重试",
      params: { status: 401 },
    });
  });

  it("token 通道的事件上报保持 copilot 域 + Bearer（参考项目实证组合）", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResult({ code: 0, msg: "OK" }))
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "RichMeow_Chat", target: 1, current: 1, accept_status: "claimed" }] } }),
      )
      .mockResolvedValueOnce(httpResult({ code: 0, data: { tasks: [] } }));
    await runWorkbuddyTask(
      makeCtx("token"),
      task({ taskCode: "RichMeow_Chat", target: 1, current: 0 }),
    );
    const reportCall = mockInvoke.mock.calls.find(([, args]) =>
      String((args as Record<string, unknown>)?.["url"]).endsWith("/v2/report"),
    );
    const args = reportCall?.[1] as Record<string, unknown>;
    expect(args?.["url"]).toBe("https://copilot.tencent.com/v2/report");
    expect(args?.["auth"]).toBe("workbuddy_report");
  });

  it("mp 任务 accept 未生效时中断并说明（不盲目上报）", async () => {
    // 每次拉列表都返回 not_accepted：accept 两轮回读均未登记
    mockInvoke.mockResolvedValue(
      httpResult({ code: 0, data: { tasks: [{ task_code: "school_season", accept_status: "not_accepted" }] } }),
    );
    const result = await runWorkbuddyTask(
      makeCtx("token"),
      task({ taskCode: "school_season", isMp: true, acceptStatus: "not_accepted" }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("接受");
  });

  it("动作上报后达标 → 自动领奖并汇报到账", async () => {
    // invoke 序列（token 通道 RichMeow_Chat，回读按 isMp 只拉默认口径）：
    // 1 桌面指纹 report → 2 默认列表（首次回读即达标）→ 3 web 域 claim
    mockInvoke
      .mockResolvedValueOnce(httpResult({ code: 0, msg: "OK" }))
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "RichMeow_Chat", target: 1, current: 1, accept_status: "accepted" }] } }),
      )
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { already_claimed: false, credit: 100, energy: 5 } }),
      );
    const result = await runWorkbuddyTask(
      makeCtx("token"),
      task({ taskCode: "RichMeow_Chat", target: 1, current: 0 }),
    );
    expect(result.ok).toBe(true);
    expect(result.credit).toBe(100);
    expect(result.energy).toBe(5);
    // message 是嵌套模板（{message} 为动作消息参数位，credit/energy 由渲染层替换）
    expect(result.message).toBe("{message}；已自动领取 +{credit} 分 +{energy} 能量");
    // message 在 params 首位：applyParams 按插入序单遍替换，倒序会把动作文案里的
    // {name} 等占位符漏成字面量
    expect(Object.keys(result.params ?? {})[0]).toBe("message");
    expect(result.params).toMatchObject({ credit: 100, energy: 5 });
  });

  it("回读为 claimed → 返回「已领取」且 message 进 params（P1-3：字面 {message} 不再漏给用户）", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResult({ code: 0, msg: "OK" }))
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "automation_1", accept_status: "claimed" }] } }),
      );
    const result = await runWorkbuddyTask(
      makeCtx("token"),
      task({ taskCode: "automation_1", target: 1 }),
    );
    expect(result.message).toBe("{message}；已领取");
    expect(result.params?.["message"]).toBe("已上报定时任务创建事件");
  });

  it("轮询预算耗尽未归账 → 返回未归账模板且 message 进 params（P1-3）", async () => {
    vi.useFakeTimers();
    mockInvoke
      .mockResolvedValue(httpResult({ code: 0, msg: "OK" }))
      // 前置读 + 三轮轮询全部 0/1（异步计分一直没落账）
      .mockResolvedValue(
        httpResult({ code: 0, data: { tasks: [{ task_code: "automation_1", target: 1, current: 0 }] } }),
      );
    const promise = runWorkbuddyTask(
      makeCtx("token"),
      task({ taskCode: "automation_1", target: 1 }),
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    expect(result.message).toBe("{message}（进度未即时归账，稍后刷新查看）");
    expect(result.params?.["message"]).toBe("已上报定时任务创建事件");
  });

  it("mp 领奖 copilot 域 400 → 降级 web 域一次且不重复（token 通道）", async () => {
    mockInvoke
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "school_season", target: 1, current: 1, accept_status: "accepted" }] } }),
      )
      .mockResolvedValueOnce(httpResult({ code: 0, msg: "OK" })) // mp report
      .mockResolvedValueOnce(
        httpResult({ code: 0, data: { tasks: [{ task_code: "school_season", target: 1, current: 1, accept_status: "accepted" }] } }),
      )
      .mockResolvedValueOnce(httpResult({ code: 0 }, 400)) // copilot 域 claim 400
      .mockResolvedValueOnce(httpResult({ code: 0, data: { already_claimed: false, credit: 100 } }));
    const result = await runWorkbuddyTask(
      makeCtx("token"),
      task({ taskCode: "school_season", isMp: true, acceptStatus: "accepted", target: 1 }),
    );
    const claimUrls = mockInvoke.mock.calls
      .map(([, args]) => String((args as Record<string, unknown>)?.["url"]))
      .filter((url) => url.endsWith("/claim"));
    expect(claimUrls).toEqual([
      "https://copilot.tencent.com/activity/growth/tasks/school_season/claim",
      "https://www.workbuddy.cn/activity/growth/tasks/school_season/claim",
    ]);
    expect(result.credit).toBe(100);
  });
});

describe("deriveDeviceId", () => {
  it("与 Rust sha2 派生一致（已知向量：sha256(salt:uid) 前 18 字节小写 hex）", async () => {
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update("machine:uid-abc").digest("hex").slice(0, 36);
    await expect(deriveDeviceId("uid-abc", "machine")).resolves.toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{36}$/);
  });
});

describe("parseClaimReward", () => {
  it("already_claimed 与缺失字段安全解析", () => {
    expect(parseClaimReward({ already_claimed: true })).toEqual({
      credit: 0,
      energy: 0,
      alreadyClaimed: true,
    });
    expect(parseClaimReward(null)).toEqual({ credit: 0, energy: 0, alreadyClaimed: false });
  });
});
