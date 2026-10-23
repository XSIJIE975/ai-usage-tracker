import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, ProviderInstance } from "../types/ipc";
import { primaryProgressLine } from "../alerts/metric";
import {
  buildMimoLines,
  CREDENTIAL_EXPIRED_MESSAGE,
  formatMimoAmount,
  isValidMimoCredentialValue,
  mimoProvider,
  mimoRequestHeaders,
  mimoTimeZoneHeader,
  parseBalanceData,
  parseMimoPeriodEnd,
  parsePlanDetail,
  parseUsageWindow,
  PASS_EXPIRED_MESSAGE,
  readEnvelope,
  resolveMimoChannel,
  SERVICE_TOKEN_COOKIE_NAME,
  USER_ID_COOKIE_NAME,
} from "./mimo";
import type { MimoUsageWindow, PlanState } from "./mimo";

const mockInvoke = vi.mocked(invoke);

/** 真机 fixture（2026-10-03，未订阅 Token Plan 的账号） */
const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));

const httpResult = (body: unknown, status = 200): HttpResult => ({
  status,
  headers: {},
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

const makeInstance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "mimo-1",
  providerId: "mimo",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
  balanceThreshold: null,
  site: "china",
  tokenAutoRenew: true,
  createdAt: 0,
  ...overrides,
});

/** 合成样本的锚点：fixture 里的周期末（2026-11-01 23:59:59 CST）必须在它之后，
 *  否则「只认未来重置时刻」这条规则会让用例随日历腐烂 */
const NOW = Date.parse("2026-10-03T04:00:00Z");

const dataOf = (fixture: unknown) => (fixture as { data: unknown }).data;

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("凭据输入白名单", () => {
  it("只收该 Cookie 的值原文", () => {
    expect(isValidMimoCredentialValue("eyJhbGciOi.value_1", SERVICE_TOKEN_COOKIE_NAME)).toBe(true);
    expect(isValidMimoCredentialValue("1029384756", USER_ID_COOKIE_NAME)).toBe(true);
  });

  it("拒「Cookie:」前缀、连键名一起贴、以及整段 Cookie 头", () => {
    expect(isValidMimoCredentialValue("Cookie: userId=1", USER_ID_COOKIE_NAME)).toBe(false);
    expect(isValidMimoCredentialValue("userId=1", USER_ID_COOKIE_NAME)).toBe(false);
    expect(
      isValidMimoCredentialValue("api-platform_serviceToken=x; userId=1", SERVICE_TOKEN_COOKIE_NAME),
    ).toBe(false);
    // 另一格的键名前缀不该被自己那条规则挡掉，但整段头一定落在字符集上
    expect(isValidMimoCredentialValue("api-platform_serviceToken=x", USER_ID_COOKIE_NAME)).toBe(true);
    expect(isValidMimoCredentialValue("", USER_ID_COOKIE_NAME)).toBe(false);
  });

  it("拒 CRLF 头注入、空格与中文", () => {
    expect(isValidMimoCredentialValue("a\r\nX-Injected: 1", USER_ID_COOKIE_NAME)).toBe(false);
    expect(isValidMimoCredentialValue("a b", USER_ID_COOKIE_NAME)).toBe(false);
    expect(isValidMimoCredentialValue("值", USER_ID_COOKIE_NAME)).toBe(false);
  });
});

describe("请求头", () => {
  it("x-timeZone 是本机真实偏移，不是写死值", () => {
    const header = mimoTimeZoneHeader(new Date("2026-01-01T00:00:00Z"));
    expect(header).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
    // 与同一时刻的 getTimezoneOffset 口径一致（分钟 → ±hh:mm）
    const probe = new Date("2026-01-01T00:00:00Z");
    const minutes = -probe.getTimezoneOffset();
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    expect(header).toBe(
      `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`,
    );
  });

  it("Origin/Referer 指向控制台余额页", () => {
    const headers = mimoRequestHeaders(new Date("2026-01-01T00:00:00Z"));
    expect(headers.Origin).toBe("https://platform.xiaomimimo.com");
    expect(headers.Referer).toBe("https://platform.xiaomimimo.com/#/console/balance");
    // UA 不随前端传：它由 Rust 端的 mimo_cookie 通道按编译目标注入
    expect(headers["User-Agent"]).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
  });
});

describe("金额与币种", () => {
  it("余额读字符串金额，币种随接口下发", () => {
    const parsed = parseBalanceData(dataOf(readFixture("mimo-balance.json")) as never);
    expect(parsed).toEqual({ amount: 1, currency: "CNY" });
  });

  it("金额按币种格式化，非法币种退回拼串", () => {
    expect(formatMimoAmount(1, "CNY")).toBe("¥1.00");
    expect(formatMimoAmount(12.34, "usd")).toBe("US$12.34"); // zh-CN 下美元带国别前缀
    expect(formatMimoAmount(12.34, "CN")).toBe("12.34 CN");
    expect(formatMimoAmount(12.34, "")).toBe("12.34");
    expect(formatMimoAmount(12.34, null)).toBe("12.34");
  });

  it("读不出金额返回 null，不折算成 0（那会把「没数据」显示成「余额为零」）", () => {
    expect(parseBalanceData({ balance: "", currency: "CNY" })).toBeNull();
    expect(parseBalanceData({ balance: "abc", currency: "CNY" })).toBeNull();
    expect(parseBalanceData({ currency: "CNY" })).toBeNull();
    expect(parseBalanceData(undefined)).toBeNull();
  });
});

describe("周期末解析", () => {
  it("无时区串按 Asia/Shanghai 换算成绝对时刻", () => {
    // CodexBar 按 UTC 解析这同一个串，会得到晚 8 小时的时刻——那是错的（ADR-0038）
    expect(parseMimoPeriodEnd("2026-11-01 23:59:59", NOW)?.toISOString()).toBe(
      "2026-11-01T15:59:59.000Z",
    );
    expect(parseMimoPeriodEnd("2026-11-01T23:59:59", NOW)?.toISOString()).toBe(
      "2026-11-01T15:59:59.000Z",
    );
  });

  it("串里自带时区时按它说的算，不再叠 8 小时", () => {
    expect(parseMimoPeriodEnd("2026-11-01T23:59:59Z", NOW)?.toISOString()).toBe(
      "2026-11-01T23:59:59.000Z",
    );
  });

  it("已过期的时刻与缺失同处理（隐藏那一格），脏串返回 null", () => {
    expect(parseMimoPeriodEnd("2026-01-01 00:00:00", NOW)).toBeNull();
    expect(parseMimoPeriodEnd(null, NOW)).toBeNull();
    expect(parseMimoPeriodEnd("", NOW)).toBeNull();
    expect(parseMimoPeriodEnd("下个月吧", NOW)).toBeNull();
    expect(parseMimoPeriodEnd(1767708936459, NOW)).toBeNull();
  });
});

describe("订阅状态", () => {
  it("未订阅账号：planCode/planName 为 null、expired 为 null → 未订阅", () => {
    // 真机形状：expired 是 **null** 而不是 false。CodexBar 把它解码成必填布尔，
    // 对这类账号整个 detail 响应解码失败（它用 try? 吞掉了）
    const plan = parsePlanDetail(dataOf(readFixture("mimo-plan-detail.json")) as never, NOW);
    expect(plan.kind).toBe("unsubscribed");
  });

  it("已过期优先于一切：过期套餐的用量是历史数字，不该画成「重置前不可用」", () => {
    const plan = parsePlanDetail(
      { planCode: "pro", currentPeriodEnd: "2026-11-01 23:59:59", expired: true },
      NOW,
    );
    expect(plan.kind).toBe("expired");
  });

  it("在期内：档位取 planName（缺失回退 planCode），带未来周期末", () => {
    const plan = parsePlanDetail(dataOf(readFixture("mimo-plan-detail-subscribed.json")) as never, NOW);
    expect(plan).toEqual({
      kind: "active",
      tier: "MiMo Pro",
      resetsAt: new Date("2026-11-01T15:59:59.000Z"),
    });
    const byCode = parsePlanDetail(
      { planCode: "standard", planName: null, currentPeriodEnd: null, expired: false },
      NOW,
    );
    expect(byCode.kind === "active" && byCode.tier).toBe("standard");
    // expired=false 但周期末缺失/已过期：订阅仍在，只是没有可挂的重置时刻
    expect(byCode.kind === "active" && byCode.resetsAt).toBeNull();
  });

  it("detail 源没给数据时不断言未订阅", () => {
    expect(parsePlanDetail(undefined, NOW).kind).toBe("unknown");
    expect(parsePlanDetail(null, NOW).kind).toBe("unknown");
  });
});

describe("额度窗口", () => {
  it("未订阅时 items 是 null（不是空数组）→ 没有窗口", () => {
    expect(parseUsageWindow(dataOf(readFixture("mimo-plan-usage.json")) as never)).toBeNull();
  });

  it("只取 month_total_token 那一项，卡片上不漏接口内部标识符", () => {
    const window = parseUsageWindow(
      dataOf(readFixture("mimo-plan-usage-subscribed.json")) as never,
    );
    // fixture 里 month_total_token 故意不放第一位：选中它靠名字，不靠顺序
    expect(window).toEqual({ used: 6500, limit: 20000, remaining: 13500, percent: 32.5 });
  });

  it("没有 month_total_token 时退到第一条合法项，脏项跳过", () => {
    expect(
      parseUsageWindow({
        monthUsage: {
          percent: 10,
          items: [
            { name: "脏值", used: -1, limit: 100 },
            { name: "缺项", used: 5 },
            { name: "plan_total_token", used: 100, limit: 1000 },
          ],
        },
      }),
    ).toEqual({ used: 100, limit: 1000, remaining: 900, percent: 10 });
  });

  it("恒零的月总量是「这个月没分配」，不出行也不画 0%", () => {
    expect(parseUsageWindow({ monthUsage: { percent: 0, items: [{ used: 0, limit: 0 }] } })).toBeNull();
    expect(parseUsageWindow({ monthUsage: { percent: 0, items: [] } })).toBeNull();
    expect(parseUsageWindow(undefined)).toBeNull();
  });
});

describe("卡片行", () => {
  const balance = { amount: 1, currency: "CNY" };
  const window: MimoUsageWindow = { used: 6500, limit: 20000, remaining: 13500, percent: 32.5 };
  const plan = (state: PlanState): PlanState => state;

  it("未订阅：状态行在前，余额行在后", () => {
    const lines = buildMimoLines(plan({ kind: "unsubscribed" }), null, balance);
    expect(lines).toEqual([
      { type: "text", label: "Token Plan", value: "未订阅", status: true },
      { type: "text", label: "账户余额", value: "¥1.00", balance: true },
    ]);
    // 速览按 status 标记选状态行（即使有余额也显示），不再靠「第一条 text」启发式
    expect(lines.find((line) => line.type === "text")?.status).toBe(true);
    expect(primaryProgressLine(lines)).toBeNull();
  });

  it("已过期走状态行，不出进度行也不出倒计时", () => {
    const lines = buildMimoLines(plan({ kind: "expired" }), window, balance);
    expect(lines.some((line) => line.type === "progress")).toBe(false);
    expect(lines[0]).toEqual({ type: "text", label: "Token Plan", value: "已过期", status: true });
  });

  it("在期内：徽章 + 一条进度行（带重置时刻）+ 余额行", () => {
    const lines = buildMimoLines(
      plan({ kind: "active", tier: "MiMo Pro", resetsAt: new Date("2026-11-01T15:59:59.000Z") }),
      window,
      balance,
    );
    expect(lines[0]).toEqual({ type: "badge", label: "套餐档位", value: "MiMo Pro" });
    expect(lines[1]).toEqual({
      type: "progress",
      label: "Token Plan 额度",
      used: 6500,
      limit: 20000,
      percentUsed: 32.5,
      resetsAt: "2026-11-01T15:59:59.000Z",
    });
    expect(lines[2]).toEqual({ type: "text", label: "账户余额", value: "¥1.00", balance: true });
    // 周期时长不下发 → 不猜 windowPeriodMs（托盘环层序回退快照顺序）
    expect(lines[1].windowPeriodMs).toBeUndefined();
    // 余额标记只挂在金额行上，全快照只有一条
    expect(lines.filter((line) => line.balance === true)).toHaveLength(1);
  });

  it("没有 planName/planCode 时不出徽章行（无档位可说）", () => {
    const lines = buildMimoLines(
      plan({ kind: "active", tier: null, resetsAt: new Date("2026-11-01T15:59:59.000Z") }),
      window,
      balance,
    );
    expect(lines.some((line) => line.type === "badge")).toBe(false);
  });

  it("detail 源失败：进度行照出，只是没有倒计时", () => {
    const lines = buildMimoLines(plan({ kind: "unknown" }), window, balance);
    expect(lines[0]).toMatchObject({ type: "progress", label: "Token Plan 额度" });
    expect(lines[0].resetsAt).toBeUndefined();
  });

  it("订阅在期内但没有可画额度：说状态，不编一个 0%", () => {
    const lines = buildMimoLines(
      plan({ kind: "active", tier: "MiMo Pro", resetsAt: null }),
      null,
      balance,
    );
    expect(lines[1]).toEqual({ type: "text", label: "Token Plan", value: "暂无额度数据", status: true });
  });

  it("余额源失败时只剩额度行，不挤出一句「余额未知」", () => {
    const lines = buildMimoLines(plan({ kind: "unknown" }), window, null);
    expect(lines.map((line) => line.label)).toEqual(["Token Plan 额度"]);
  });
});

describe("信封读取", () => {
  it("401/403 与回登录页 HTML 统一映射为凭据失效，不区分成因", () => {
    for (const result of [
      httpResult("", 401),
      httpResult("", 403),
      httpResult("<html><body>登录</body></html>", 200),
      httpResult({ code: 401, message: "unauthorized" }),
      httpResult({ code: 403 }),
    ]) {
      const outcome = readEnvelope(result, "余额");
      expect(outcome.ok).toBe(false);
      expect(outcome.credentialExpired).toBe(true);
      expect(outcome.error).toBe(CREDENTIAL_EXPIRED_MESSAGE);
    }
  });

  it("业务码非零时透传 message，HTTP 非 200 时带状态码", () => {
    const business = readEnvelope(httpResult({ code: 500, message: "内部错误" }), "tokenPlan/detail");
    expect(business).toMatchObject({
      ok: false,
      error: "MiMo {api} 接口返回 code={code}{message}",
      errorParams: { api: "tokenPlan/detail", code: 500, message: "：内部错误" },
    });
    const http = readEnvelope(httpResult("boom", 502), "tokenPlan/usage");
    expect(http).toMatchObject({
      ok: false,
      errorParams: { api: "tokenPlan/usage", status: 502 },
    });
  });

  it("code 缺失/非数值算解析失败，不按 Number(null)===0 蒙成成功", () => {
    for (const body of [{}, { code: null }, { code: "x" }, "不是 JSON"]) {
      const outcome = readEnvelope(httpResult(body), "余额");
      expect(outcome.ok).toBe(false);
      expect(outcome.credentialExpired).toBeUndefined();
    }
  });

  it("code=0 即成功，data 为 null 也算（未订阅账号就是这样）", () => {
    expect(readEnvelope(httpResult({ code: 0, message: "", data: null }), "订阅")).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("快照", () => {
  const credentials = (slots: Record<string, boolean>) => ({
    serviceToken: false,
    userId: false,
    ...slots,
  });

  const mockRequests = (bodies: Record<string, unknown>) => {
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      const url = (args as { url?: string } | undefined)?.url ?? "";
      if (command === "vault_credential_status")
        return Promise.resolve(credentials({ serviceToken: true, userId: true }));
      if (command === "provider_request") {
        const match = Object.keys(bodies).find((key) => url.endsWith(key));
        if (!match) return Promise.reject(new Error(`未预期的端点 ${url}`));
        const body = bodies[match];
        // 已经是 HttpResult 的（测 401/500 那些）原样返回，不再包一层
        return Promise.resolve(
          body && typeof body === "object" && "status" in (body as HttpResult)
            ? (body as HttpResult)
            : httpResult(body),
        );
      }
      return Promise.reject(new Error(`未预期的命令 ${command}`));
    });
  };

  it("两格任一为空即 needs_config，并点名缺的那格", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "vault_credential_status"
        ? Promise.resolve(credentials({ serviceToken: true }))
        : Promise.reject(new Error("不该发请求")),
    );
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("needs_config");
    expect(snapshot.message).toBe("请在设置中扫码登录小米 MiMo，或填写 {slots}");
    expect(snapshot.messageParams).toEqual({ slots: "userId" });
    expect(mockInvoke.mock.calls.filter(([command]) => command === "provider_request")).toHaveLength(0);

    mockInvoke.mockImplementation((command: string) =>
      command === "vault_credential_status"
        ? Promise.resolve(credentials({}))
        : Promise.reject(new Error("不该发请求")),
    );
    const both = await mimoProvider.fetch(makeInstance());
    expect(both.messageParams).toEqual({
      slots: "api-platform_serviceToken / userId",
    });
  });

  it("未订阅账号（真机三份响应）：出状态行与余额行，不出进度行", async () => {
    mockRequests({
      "/balance": readFixture("mimo-balance.json"),
      "/tokenPlan/detail": readFixture("mimo-plan-detail.json"),
      "/tokenPlan/usage": readFixture("mimo-plan-usage.json"),
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("ok");
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.lines).toEqual([
      { type: "text", label: "Token Plan", value: "未订阅", status: true },
      { type: "text", label: "账户余额", value: "¥1.00", balance: true },
    ]);
  });

  it("三路并行、都走 mimo_cookie 通道与同一组静态头", async () => {
    mockRequests({
      "/balance": readFixture("mimo-balance.json"),
      "/tokenPlan/detail": readFixture("mimo-plan-detail.json"),
      "/tokenPlan/usage": readFixture("mimo-plan-usage.json"),
    });
    await mimoProvider.fetch(makeInstance());
    const calls = mockInvoke.mock.calls.filter(([command]) => command === "provider_request");
    expect(calls).toHaveLength(3);
    const urls = calls.map(([, args]) => (args as { url: string }).url);
    expect(urls.sort()).toEqual([
      "https://platform.xiaomimimo.com/api/v1/balance",
      "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail",
      "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
    ]);
    for (const [, args] of calls) {
      const options = args as { method: string; auth: string; headers: Record<string, string> };
      expect(options.method).toBe("GET");
      expect(options.auth).toBe("mimo_cookie");
      expect(options.headers.Origin).toBe("https://platform.xiaomimimo.com");
      expect(options.headers["x-timeZone"]).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
    }
  });

  it("订阅账号：徽章 + 进度行 + 余额行", async () => {
    mockRequests({
      "/balance": readFixture("mimo-balance.json"),
      "/tokenPlan/detail": readFixture("mimo-plan-detail-subscribed.json"),
      "/tokenPlan/usage": readFixture("mimo-plan-usage-subscribed.json"),
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.lines.map((line) => line.type)).toEqual(["badge", "progress", "text"]);
    expect(snapshot.lines[1]).toMatchObject({ percentUsed: 32.5, used: 6500, limit: 20000 });
  });

  it("单源失败出 ok 快照并把失败拼进 message（错误可见，ADR-0024）", async () => {
    mockRequests({
      "/balance": readFixture("mimo-balance.json"),
      "/tokenPlan/detail": readFixture("mimo-plan-detail-subscribed.json"),
      "/tokenPlan/usage": httpResult("boom", 500),
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("ok");
    expect(snapshot.message).toContain("MiMo {api} 接口返回 HTTP {status}{detail}");
    expect(snapshot.messageParams).toMatchObject({ api: "tokenPlan/usage", status: 500 });
    // 额度源挂了，但订阅与余额照出
    expect(snapshot.lines.map((line) => line.type)).toEqual(["badge", "text"]);
  });

  it("多源失败的占位符加序号后缀，不互相覆盖", async () => {
    mockRequests({
      "/balance": readFixture("mimo-balance.json"),
      "/tokenPlan/detail": httpResult("a", 500),
      "/tokenPlan/usage": httpResult("b", 502),
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.messageParams).toMatchObject({
      api: "tokenPlan/detail",
      status: 500,
      api2: "tokenPlan/usage",
      status2: 502,
    });
    expect(snapshot.message).toContain("{status2}");
  });

  it("任一源 401 即整卡报错并指引重贴，不用旧数据拼半张卡", async () => {
    mockRequests({
      "/balance": httpResult("", 401),
      "/tokenPlan/detail": readFixture("mimo-plan-detail-subscribed.json"),
      "/tokenPlan/usage": readFixture("mimo-plan-usage-subscribed.json"),
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe(CREDENTIAL_EXPIRED_MESSAGE);
    expect(snapshot.lines).toEqual([]);
  });

  it("三源全失败时错误快照把三段都拼上", async () => {
    mockRequests({
      "/balance": httpResult("x", 500),
      "/tokenPlan/detail": httpResult("y", 500),
      "/tokenPlan/usage": httpResult("z", 500),
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("error");
    expect(snapshot.message?.split("；")).toHaveLength(3);
  });

  it("请求抛错（断网/白名单拒绝）也表现为错误快照而非静默", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "vault_credential_status")
        return Promise.resolve(credentials({ serviceToken: true, userId: true }));
      return Promise.reject(new Error("拒绝向该主机发请求"));
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("error");
    // message 是模板串，实参在 messageParams 上（渲染端 t+params，ADR-0022）
    expect(snapshot.message).toContain("接口查询失败：{detail}");
    expect(snapshot.messageParams?.detail).toContain("拒绝向该主机发请求");
  });
});

// ─── 扫码通道（ADR-0042）：vault 存 passToken，serviceToken 每轮由 Rust 现铸 ───

describe("resolveMimoChannel", () => {
  it("passToken 非空即扫码通道；两格齐走 Cookie 通道；都缺为 null", () => {
    expect(resolveMimoChannel({ passToken: true, userId: true })).toBe("pass");
    // 两格同时在场时扫码优先：claim 会清掉手贴的 serviceToken，正常不会并存
    expect(resolveMimoChannel({ passToken: true, serviceToken: true, userId: true })).toBe("pass");
    expect(resolveMimoChannel({ serviceToken: true, userId: true })).toBe("cookie");
    expect(resolveMimoChannel({ serviceToken: true })).toBeNull();
    expect(resolveMimoChannel({})).toBeNull();
  });
});

describe("fetchMimoSnapshot 扫码通道", () => {
  // 合成信封：只用来把「通道选择」与「数据解析」这两件事分开测，不代表任何真机响应
  const okEnvelope = { code: 0, message: "", data: {} };
  // 「快照」那个 describe 里也有同名 helper：它带着默认 false 的两格，
  // 这里要能表达 passToken/deviceId，所以在本地再定义一份而不是搬上去
  const credentials = (slots: Record<string, boolean>) => ({
    serviceToken: false,
    userId: false,
    ...slots,
  });

  it("三个端点都走 mimo_pass（铸票在 Rust 侧，前端不拼 account 域的 URL）", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "vault_credential_status")
        return Promise.resolve(credentials({ passToken: true, userId: true, deviceId: true }));
      return Promise.resolve(httpResult(okEnvelope));
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    const requests = mockInvoke.mock.calls.filter(([command]) => command === "provider_request");
    expect(requests).toHaveLength(3);
    for (const [, options] of requests) {
      expect((options as Record<string, unknown>).auth).toBe("mimo_pass");
    }
    expect(snapshot.status).toBe("ok");
  });

  it("失效话术按通道给：扫码是重扫，Cookie 是重贴", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "vault_credential_status")
        return Promise.resolve(credentials({ passToken: true, userId: true, deviceId: true }));
      return Promise.resolve(httpResult({ code: 401 }, 401));
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe(PASS_EXPIRED_MESSAGE);
    expect(snapshot.message).not.toBe(CREDENTIAL_EXPIRED_MESSAGE);
  });

  it("Cookie 通道的失效话术不变（不让扫码的存在把老用户指到另一条出路）", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "vault_credential_status")
        return Promise.resolve(credentials({ serviceToken: true, userId: true }));
      return Promise.resolve(httpResult({ code: 401 }, 401));
    });
    const snapshot = await mimoProvider.fetch(makeInstance());
    expect(snapshot.message).toBe(CREDENTIAL_EXPIRED_MESSAGE);
  });
});
