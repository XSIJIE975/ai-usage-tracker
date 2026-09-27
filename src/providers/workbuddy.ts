import { invoke } from "@tauri-apps/api/core";
import type {
  HttpResult,
  InstanceCredentialStatus,
  MetricLine,
  ProviderInstance,
  ProviderSnapshot,
} from "../types/ipc";
import type { ProviderModule } from "./types";
import {
  cstDateString,
  isEnvelopeOk,
  parseStreakLine,
  resolveWorkbuddyChannel,
  toCount,
  RESOURCE_BODY,
  workbuddyApi,
  workbuddyTokenApi,
  WORKBUDDY_NEEDS_CONFIG_MESSAGE,
  WORKBUDDY_TOKEN_EXPIRED_MESSAGE,
  type WorkbuddyEnvelope,
} from "./workbuddy-channel";
import {
  createGrowthContext,
  fetchStreakFull,
  runDailyCheckin,
  runGrowthButler,
  runTravelMachine,
  runTrialClaim,
  type GrowthButlerOutcome,
} from "./workbuddy-growth";

// WorkBuddy 取数链（ADR-0037 薄壳化）：通道判定 → 成长中心上下文 → 并行
// （余额/套餐主源 + 成长例程包）。签到/旅行/连登/管家的请求、解析、幂等标记
// 全部收敛在 workbuddy-growth.ts 的统一例程里，双通道（Cookie/token，ADR-0034/0035）
// 差异由 ctx 内化——本文件只保留余额主源的解析与两通道各自的容错策略。
// 端点与响应结构依据两个社区实现的交叉验证 + 用户浏览器实测请求（2026-09-21，
// 非公开 web 接口、随官方改版需跟随维护，接入边界见 ADR-0029）：
// - 余额/套餐：POST /billing/meter/get-user-resource（与两个社区实现同端点同主机；
//   响应 data.Accounts[] 或 data.Response.Data.Accounts[] 为套餐级明细，无调用级用量）
// - 每日签到：POST /billing/meter/daily-checkin（空 body，幂等；code=10001/14001 当日已签）
// - 成长体系（旅行/连登/管家）与 trial 见 workbuddy-growth.ts 文件头注释
const PROVIDER_NAME = "腾讯 WorkBuddy";

// 通道与站点原语（能力位/域名/头族/信封工具/签到旅行解析）下沉在 workbuddy-channel.ts，
// 这里 re-export 维持既有 import 面（测试与视图层零改动）
export {
  cstDateString,
  isEnvelopeOk,
  isValidCookiePartValue,
  isValidUserAgentValue,
  parseCheckinResult,
  parseClaimResult,
  parseStreakLine,
  parseTravelLine,
  resolveWorkbuddyChannel,
  toCount,
  workbuddyApi,
  workbuddySiteOf,
  workbuddyTokenApi,
  WORKBUDDY_NEEDS_CONFIG_MESSAGE,
  WORKBUDDY_TOKEN_EXPIRED_MESSAGE,
} from "./workbuddy-channel";
export type {
  WorkbuddyApi,
  WorkbuddyCapabilities,
  WorkbuddyTokenApi,
  WorkbuddyTravelStatus,
} from "./workbuddy-channel";

/** 单个套餐（字段名为服务端 PascalCase 原样；Precise 系为高精度数值，
 *  整数返回 number、小数可能返回字符串）。周期制套餐（Cycle 系）优先于总量制（Capacity 系） */
export interface WorkbuddyPackage {
  PackageName?: string;
  Status?: number;
  /** 套餐到期时刻（服务端本地时间 "YYYY-MM-DD HH:mm:ss"）；到期未用完的积分作废 */
  CycleEndTime?: string | number;
  CapacityRemainPrecise?: number | string;
  CapacityUsedPrecise?: number | string;
  CapacitySizePrecise?: number | string;
  CycleCapacityRemainPrecise?: number | string;
  CycleCapacitySizePrecise?: number | string;
}

export interface WorkbuddyResourceData {
  /** get-user-resource 的形态是 data.Response.Data.Accounts 包裹（CodeBuddy-Usage 同端点
   *  解析）；同族 -free-packages 端点 2026-09-21 实测为 data.Accounts 直挂。
   *  两种都容——取先命中的 */
  Accounts?: WorkbuddyPackage[];
  Response?: { Data?: { Accounts?: WorkbuddyPackage[] } };
}

/** 每实例「今日已续期」内存标记：每日一刷挂每天第一次刷新链（签到同位置，ADR-0034）。
 *  失败不设标记——旧 token 原样保留，下轮再试。续期/扫码授权三端点不在前端拼 URL：
 *  由 Rust 侧 workbuddy_token_refresh / workbuddy_qr_* 直连授权域
 *  （国区 https://copilot.tencent.com，国际站 https://www.workbuddy.ai） */
const tokenRenewedToday = new Map<string, string>();

async function renewTokenOnce(instance: ProviderInstance, today: string): Promise<void> {
  // 实例级开关默认开；关掉即「token 用到失效为止」，只有 401 即时救仍会尝试
  if (instance.tokenAutoRenew === false) return;
  if (tokenRenewedToday.get(instance.id) === today) return;
  try {
    await invoke("workbuddy_token_refresh", { instanceId: instance.id });
    tokenRenewedToday.set(instance.id, today);
  } catch {
    // 静默：续期失败不阻断取数（accessToken 仍可能有效），下轮刷新再试
  }
}

const positiveOrZero = (value: number | null): number => (value != null && value > 0 ? value : 0);

/** remain 钳到 [0, size]：负余量、超总量的脏数据会把聚合 used 算成负值/虚高百分比
 *  （workbuddy2api packageRemainUsed 同款钳制）；size 缺失时只钳非负 */
function clampRemain(remain: number, size: number | null): number {
  const value = Math.max(0, remain);
  return size != null && size > 0 ? Math.min(value, size) : value;
}

/** 单套餐余量/总量：周期制（Cycle 系）以 CycleCapacitySize>0 为门槛**整组采用**
 *  （缺失的余量按 0，不与总量制跨制混搭——workbuddy2api packageRemainUsed 与
 *  CodeBuddy-Usage fetchUsage 同口径，周期制包只看本周期可用，未发放的未来额度不计入）；
 *  否则回退总量制（Capacity 系） */
function packageUsage(pkg: WorkbuddyPackage): { remain: number; size: number } {
  const cycleSize = toCount(pkg.CycleCapacitySizePrecise);
  if (cycleSize != null && cycleSize > 0) {
    return {
      remain: clampRemain(toCount(pkg.CycleCapacityRemainPrecise) ?? 0, cycleSize),
      size: cycleSize,
    };
  }
  const remain = positiveOrZero(toCount(pkg.CapacityRemainPrecise));
  const size = positiveOrZero(toCount(pkg.CapacitySizePrecise));
  return { remain: clampRemain(remain, size), size };
}

/** 到期时刻解析：服务端本地时间串按本地时区解释（用户与服务端同为 CST 时无偏差）；
 *  秒/毫秒 epoch 亦兼容，解析不出返回 null（该套餐不显示到期日） */
export function parseExpiry(raw: string | number | undefined): Date | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const date = new Date(raw > 1e12 ? raw : raw * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = raw.trim();
  if (!text) return null;
  // "YYYY-MM-DD HH:mm:ss" 不是合法 ISO，替换空格后按本地时区解析
  const ms = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
  if (Number.isFinite(ms)) return new Date(ms);
  const epoch = Number(text);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch > 1e12 ? epoch : epoch * 1000);
  return null;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("zh-CN") : value.toFixed(2);
}

/** 卡片指标行：主行 = 全部有效套餐聚合的积分余量（progress，喂托盘与告警；
 *  已耗尽/已用完的套餐同样计入分母——累计已用口径，与 workbuddy2api ResourceSummary
 *  一致，见 ADR-0029），明细行 = 按套餐名合并（同名套餐是同一包的不同发放周期，
 *  逐行展示会刷爆卡片——2026-09-21 实测单账号 15 条 Account 同名），到期时间取组内
 *  最早（最紧急先显示）；超过 3 组合并为一行 */
export function parseResourceLines(data: WorkbuddyResourceData | undefined): MetricLine[] {
  const accounts = data?.Accounts ?? data?.Response?.Data?.Accounts ?? [];
  const packages = accounts
    .map((pkg) => ({ pkg, usage: packageUsage(pkg) }))
    .filter(({ usage }) => usage.remain > 0 || usage.size > 0);
  if (packages.length === 0) {
    return [{ type: "text", label: "积分余量", value: "暂无有效套餐" }];
  }

  let totalRemain = 0;
  let totalSize = 0;
  for (const { usage } of packages) {
    totalRemain += usage.remain;
    totalSize += usage.size;
  }
  const lines: MetricLine[] = [];
  if (totalSize > 0) {
    lines.push({
      type: "progress",
      label: "积分余量",
      used: totalSize - totalRemain,
      limit: totalSize,
      percentUsed: ((totalSize - totalRemain) / totalSize) * 100,
      // 余额位数值（速览按 balance 标记选行）：纯数字，卡片进度分支不渲染 value
      value: formatCount(totalRemain),
      balance: true,
    });
  } else {
    // 只有余量没有总量：出不了百分比，退化为文本行（主指标回退余额数值的口径不适用，
    // workbuddy 没有金额量纲，该实例不参与托盘环与阈值告警）
    lines.push({
      type: "text",
      label: "积分余量",
      value: "余 {remain}",
      valueParams: { remain: formatCount(totalRemain) },
      balance: true,
    });
  }

  interface PackageGroup {
    name: string;
    remain: number;
    size: number;
    expiry: Date | null;
  }
  const groups = new Map<string, PackageGroup>();
  for (const { pkg, usage } of packages) {
    const name = pkg.PackageName?.trim() || "套餐";
    const group = groups.get(name) ?? { name, remain: 0, size: 0, expiry: null };
    group.remain += usage.remain;
    group.size += usage.size;
    const expiry = parseExpiry(pkg.CycleEndTime);
    if (expiry && (!group.expiry || expiry < group.expiry)) group.expiry = expiry;
    groups.set(name, group);
  }
  const sortedGroups = [...groups.values()].sort((a, b) => {
    const ea = a.expiry?.getTime() ?? Number.POSITIVE_INFINITY;
    const eb = b.expiry?.getTime() ?? Number.POSITIVE_INFINITY;
    return ea - eb;
  });
  const MAX_PACKAGE_LINES = 3;
  for (const group of sortedGroups.slice(0, MAX_PACKAGE_LINES)) {
    const remain = { remain: formatCount(group.remain) };
    lines.push(
      group.expiry
        ? {
            type: "text",
            label: group.name,
            value: "余 {remain} · {expiresAt}到期",
            valueParams: { ...remain, expiresAt: group.expiry.toISOString() },
          }
        : { type: "text", label: group.name, value: "余 {remain}", valueParams: remain },
    );
  }
  if (sortedGroups.length > MAX_PACKAGE_LINES) {
    const rest = sortedGroups.slice(MAX_PACKAGE_LINES);
    const restRemain = rest.reduce((sum, group) => sum + group.remain, 0);
    lines.push({
      type: "text",
      label: "其余 {count} 个套餐",
      params: { count: rest.length },
      value: "余 {remain}",
      valueParams: { remain: formatCount(restRemain) },
    });
  }
  return lines;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ResourceOutcome {
  ok: boolean;
  lines: MetricLine[];
  error?: string;
  errorParams?: Record<string, string | number>;
}

/** 余额/套餐响应整体处理：401/403 或返回登录页 HTML 映射为「凭据无效或已过期」——
 *  网关对 session 成对与 UA 一致性任一不满足都回 401，出路同为重填三项凭据 */
function processResource(result: HttpResult): ResourceOutcome {
  const looksHtml = result.bodyText.trimStart().startsWith("<");
  if (result.status === 401 || result.status === 403 || (result.status === 200 && looksHtml)) {
    return {
      ok: false,
      lines: [],
      error: "WorkBuddy 登录凭据无效或已过期，请在设置中重新填写三项凭据",
    };
  }
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return {
      ok: false,
      lines: [],
      error: "积分套餐接口返回 HTTP {status}{detail}",
      errorParams: { status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyEnvelope<WorkbuddyResourceData>;
    if (!isEnvelopeOk(json)) {
      return {
        ok: false,
        lines: [],
        error: "积分套餐查询失败：{detail}",
        errorParams: {
          detail: `code=${json.code ?? "unknown"}${json.msg ? ` msg=${truncate(json.msg, 120)}` : ""}`,
        },
      };
    }
    return { ok: true, lines: parseResourceLines(json.data) };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: "积分套餐返回数据解析失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }
}

/** 余额/套餐主源（两通道合一）：国际站 404 时按双试序换 /v2 备选路径重发；token 通道
 *  401/403 先即时续期救一次（ADR-0034），救不活按 token 失效报错。Cookie 通道的
 *  401/403 直接进 processResource（网关语义：凭据三要素不齐） */
async function runResource(ctx: NonNullable<Awaited<ReturnType<typeof createGrowthContext>>>): Promise<ResourceOutcome> {
  const isToken = ctx.channel === "token";
  const tokenConfig = isToken ? workbuddyTokenApi(ctx.site) : null;
  const cookieConfig = isToken ? null : workbuddyApi(ctx.site);
  const headers = (isToken ? tokenConfig!.headers.billing : cookieConfig!.headers.billing);
  const resourceUrl = isToken ? tokenConfig!.urls.resource : cookieConfig!.urls.resource;
  const resourceAlt = isToken ? tokenConfig!.urls.resourceAlt : null;
  const requestResource = (url: string) =>
    invoke<HttpResult>("provider_request", {
      instanceId: ctx.instance.id,
      url,
      method: "POST",
      auth: isToken ? "workbuddy_token" : "session_cookie",
      headers,
      bodyText: RESOURCE_BODY,
    });
  let result = await requestResource(resourceUrl);
  if (result.status === 404 && resourceAlt) {
    result = await requestResource(resourceAlt);
  }
  if (!isToken || (result.status !== 401 && result.status !== 403)) {
    return processResource(result);
  }
  try {
    await invoke("workbuddy_token_refresh", { instanceId: ctx.instance.id });
    const retried = await requestResource(resourceUrl);
    const outcome = processResource(retried);
    if (!outcome.ok && (retried.status === 401 || retried.status === 403)) {
      return { ok: false, lines: [], error: WORKBUDDY_TOKEN_EXPIRED_MESSAGE };
    }
    return outcome;
  } catch {
    return { ok: false, lines: [], error: WORKBUDDY_TOKEN_EXPIRED_MESSAGE };
  }
}

/** 管家事件汇总是否值得进快照/通知（全零=无事件，静默） */
function butlerHasEvents(butler: GrowthButlerOutcome): boolean {
  return (
    butler.makeupUsed > 0 ||
    butler.giftCredit > 0 ||
    butler.compensationCredit > 0 ||
    butler.redeemed.length > 0 ||
    butler.draws.length > 0
  );
}

/** 成长例程包（签到 → 旅行 → 连登 → 管家 → trial）：每步独立容错，任何失败静默——
 *  余额主源才是快照成败的判定者。返回值喂快照瞬时字段（checkin/travel 喂各自检测器、
 *  growthNotice 喂管家通知、trial 喂试用通知）与连登卡片行 */
async function runGrowthRituals(ctx: NonNullable<Awaited<ReturnType<typeof createGrowthContext>>>, today: string) {
  // 先签到后取数（ADR-0029）：签到到账的积分当轮即可见
  const checkin = await runDailyCheckin(ctx, today);
  // 旅行（领奖 → 出发 → 回查）：领到的积分当轮余额可见
  const { travel, travelLine } = await runTravelMachine(ctx);
  // 连登完整状态（辅助源：失败无行）；管家闭环消费同一份数据省一次 GET
  let streakFull = await fetchStreakFull(ctx);
  let streakLine = parseStreakLine(streakFull ?? undefined);
  // 管家闭环（自动跟随刷新，ADR-0037）：当日已完整跑过/能力位门控返回 null
  const butler = await runGrowthButler(ctx, today, streakFull);
  if (butler?.streakFull) {
    streakFull = butler.streakFull;
    streakLine = parseStreakLine(streakFull ?? undefined);
  }
  // 国际站试用加油包（一次性，已领永久静默）
  const trial = await runTrialClaim(ctx);
  return { checkin, travel, travelLine, streakLine, butler, trial };
}

async function fetchWorkbuddySnapshot(instance: ProviderInstance): Promise<ProviderSnapshot> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  const updatedAt = Date.now();
  // 双凭据通道（ADR-0034）：token 非空优先走 token 通道；三格齐走 Cookie；都缺才
  // needs_config——文案同时给出两种出路，扫码是首选（免 F12）
  const channel = resolveWorkbuddyChannel(status);
  if (!channel) {
    return {
      instanceId: instance.id,
      providerId: "workbuddy",
      providerName: PROVIDER_NAME,
      status: "needs_config",
      updatedAt,
      message: WORKBUDDY_NEEDS_CONFIG_MESSAGE,
      lines: [],
    };
  }
  const ctx = await createGrowthContext(instance);
  // channel 已判定非 null，ctx 理论上必非 null（vault 状态同源）；防御性兜底按通道失联处理
  if (!ctx) {
    return {
      instanceId: instance.id,
      providerId: "workbuddy",
      providerName: PROVIDER_NAME,
      status: "error",
      updatedAt,
      message: "WorkBuddy 登录凭据无效或已过期，请在设置中重新填写三项凭据",
      lines: [],
    };
  }
  const today = cstDateString(updatedAt);
  if (ctx.channel === "token") {
    await renewTokenOnce(instance, today);
  }

  // 成长例程与余额主源并行：辅助源（签到/旅行/连登/管家/trial）失败静默不拖累快照，
  // 余额才是快照成败的判定者；写动作（签到→旅行→管家）串行执行对齐参考排程序
  const [resourceSettled, ritualsSettled] = await Promise.allSettled([
    runResource(ctx),
    runGrowthRituals(ctx, today),
  ]);
  const rituals =
    ritualsSettled.status === "fulfilled"
      ? ritualsSettled.value
      : { checkin: undefined, travel: undefined, travelLine: null as MetricLine | null, streakLine: null as MetricLine | null, butler: null as GrowthButlerOutcome | null, trial: undefined };

  const { checkin, travel, travelLine, streakLine, butler, trial } = rituals;
  const growthNotice =
    butler && butlerHasEvents(butler)
      ? {
          date: butler.date,
          makeupUsed: butler.makeupUsed,
          giftCredit: butler.giftCredit,
          compensationCredit: butler.compensationCredit,
          redeemed: butler.redeemed,
          draws: butler.draws,
        }
      : undefined;
  // 瞬时事件字段只在真实发生时填充（签到 done/travel 领到/管家有事件/trial 领取）——
  // 通知判重权威在 Rust 端对应事实源行，错误快照也携带（取数失败不吞掉已发生的事件）
  const eventFields = {
    ...(checkin ? { checkin } : {}),
    ...(travel ? { travel } : {}),
    ...(growthNotice ? { growthNotice } : {}),
    ...(trial ? { trial } : {}),
  };

  let resourceOutcome: ResourceOutcome;
  if (resourceSettled.status === "fulfilled") {
    resourceOutcome = resourceSettled.value;
  } else {
    resourceOutcome = {
      ok: false,
      lines: [],
      error: "积分套餐查询失败：{detail}",
      errorParams: { detail: toErrorText(resourceSettled.reason) },
    };
  }

  if (!resourceOutcome.ok) {
    return {
      instanceId: instance.id,
      providerId: "workbuddy",
      providerName: PROVIDER_NAME,
      status: "error",
      updatedAt,
      message: resourceOutcome.error,
      messageParams: resourceOutcome.errorParams,
      lines: [],
      ...eventFields,
    };
  }

  return {
    instanceId: instance.id,
    providerId: "workbuddy",
    providerName: PROVIDER_NAME,
    status: "ok",
    updatedAt,
    lines: [
      ...resourceOutcome.lines,
      ...(travelLine ? [travelLine] : []),
      ...(streakLine ? [streakLine] : []),
    ],
    ...eventFields,
  };
}

export const workbuddyProvider: ProviderModule = {
  id: "workbuddy",
  name: "腾讯 WorkBuddy",
  description: "查询 WorkBuddy 积分余量、套餐明细、连登天数、签到与喵喵旅行",
  fetch: fetchWorkbuddySnapshot,
};
