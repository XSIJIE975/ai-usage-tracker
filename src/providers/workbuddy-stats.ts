import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, InstanceCredentialStatus, ProviderInstance } from "../types/ipc";
import type { StatsResult } from "./stats-result";
import { EDGE_UA } from "./workbuddy";

// 接口与响应结构依据 2026-09-21 官网控制台实测（workbuddy.cn 登录会话页内直连验证）：
// - 消耗明细：POST /billing/meter/get-user-request-usage
//   入参 {startTime, endTime, pageNum, pageSize}，时间为本地时区 "YYYY-MM-DD HH:mm:ss"
//   （结束日 23:59:59，与官网控制台的区间口径一致）；响应 data { total, data[] }，
//   行字段 requestId/credit/model/client/requestTime/inputTrunc/input/agentPurpose，
//   按 requestTime 倒序。30 天 ≈ 273 条（3 页）。
//   input 全文刻意不取，只取截断版 inputTrunc——统计页的隐私面和内存都更小。
// - get-user-resource-summary / get-user-resource-paid-packages 仅记录于 ADR-0029，
//   本期不做 UI（套餐明细已在卡片常驻，购买积分免费账号为空）。
const USAGE_URL = "https://www.workbuddy.cn/billing/meter/get-user-request-usage";

const PAGE_SIZE = 100;
/** 分页防御上限：20 页 ×100 条；正常 30 天 ≈3 页，越界视为异常按已得数据收口 */
const MAX_PAGES = 20;
const DAY_MS = 86_400_000;

/** 消耗明细的单行（仅统计页用得到的字段；input 全文不落内存） */
export interface WorkbuddyUsageRow {
  readonly requestId: string;
  /** 服务端本地时间 "YYYY-MM-DD HH:mm:ss"（精度到分钟） */
  readonly time: string;
  readonly credit: number;
  readonly model: string;
  readonly client: string;
  /** agentPurpose 原文（conversation、enhance-prompt、subagent:XXX、webfetch 等） */
  readonly purpose: string;
  readonly inputTrunc: string;
}

export interface WorkbuddyUsageBundle {
  readonly rows: WorkbuddyUsageRow[];
  /** 区间内总条数（服务端 total；与 rows.length 一致——取数总是拉全量分页） */
  readonly total: number;
}

interface WorkbuddyUsageEnvelope {
  code?: number | string;
  msg?: string;
  data?: {
    total?: number;
    data?: Array<{
      requestId?: string;
      credit?: number | string;
      model?: string;
      client?: string;
      requestTime?: string;
      inputTrunc?: string;
      agentPurpose?: string;
    }>;
  };
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 毫秒 → 本地时区 "YYYY-MM-DD HH:mm:ss"；endOf 卡到当日 23:59:59（resolveRangeMs 的
 *  endMs 是结束日次日本地零点，减一毫秒即末日的最后一刻） */
export const formatUsageTime = (ms: number, endOf = false): string => {
  const date = new Date(endOf ? ms - 1 : ms);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${endOf ? "23:59:59" : "00:00:00"}`
  );
};

const parseCount = (raw: number | string | null | undefined): number => {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const parseUsageEnvelope = (result: HttpResult):
  | { kind: "ok"; rows: WorkbuddyUsageRow[]; total: number }
  | { kind: "expired" }
  | { kind: "http"; status: number }
  | { kind: "biz"; detail: string }
  | { kind: "parse"; detail: string } => {
  // 401/403 与「200 + 登录页 HTML」同义：Cookie 会话失效（与 providers/workbuddy.ts 的
  // processResource 同判据），重贴 Cookie 即恢复
  if (result.status === 401 || result.status === 403) return { kind: "expired" };
  if (result.status !== 200) return { kind: "http", status: result.status };
  if (result.bodyText.trimStart().startsWith("<")) return { kind: "expired" };
  try {
    const json = JSON.parse(result.bodyText) as WorkbuddyUsageEnvelope;
    const code = json.code == null ? "" : String(json.code);
    if (code !== "0" && code !== "200") {
      return { kind: "biz", detail: `code=${json.code ?? "unknown"}${json.msg ? ` msg=${json.msg}` : ""}` };
    }
    const rows = (json.data?.data ?? []).map((row) => ({
      requestId: row.requestId ?? "",
      time: row.requestTime ?? "",
      credit: parseCount(row.credit),
      model: row.model ?? "",
      client: row.client ?? "",
      purpose: row.agentPurpose ?? "",
      inputTrunc: row.inputTrunc ?? "",
    }));
    return { kind: "ok", rows, total: parseCount(json.data?.total) };
  } catch (error) {
    return { kind: "parse", detail: error instanceof Error ? error.message : String(error) };
  }
};

const usageError = (
  message: string,
  params?: Record<string, string | number>,
): StatsResult<WorkbuddyUsageBundle> => ({ status: "error", message, ...(params ? { params } : {}) });

/** 拉取时间范围内的全部消耗明细（分页拉全，供前端聚合）。
 *  401/403 或返回登录页 HTML → 与卡片同款「登录已过期」指引（重贴 Cookie 即恢复） */
export const fetchWorkbuddyUsage = async (
  instance: ProviderInstance,
  startMs: number,
  endMs: number,
): Promise<StatsResult<WorkbuddyUsageBundle>> => {
  try {
    const credentialStatus = await invoke<InstanceCredentialStatus>("vault_credential_status", {
      instanceId: instance.id,
    });
    if (!credentialStatus.cookie) {
      return { status: "needs_config", message: "请在设置中填写 WorkBuddy 登录 Cookie" };
    }

    const body = {
      startTime: formatUsageTime(startMs),
      endTime: formatUsageTime(endMs, true),
      pageSize: PAGE_SIZE,
    };
    const rows: WorkbuddyUsageRow[] = [];
    let total = 0;
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
      const result = await invoke<HttpResult>("provider_request", {
        instanceId: instance.id,
        url: USAGE_URL,
        method: "POST",
        auth: "cookie_header",
        credentialSlot: "cookie",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": EDGE_UA,
          Origin: "https://www.workbuddy.cn",
          Referer: "https://www.workbuddy.cn/profile/plans-usage",
          "x-client-platform": "web",
        },
        bodyText: JSON.stringify({ ...body, pageNum }),
      });
      const parsed = parseUsageEnvelope(result);
      if (parsed.kind === "expired") {
        return usageError("WorkBuddy 登录已过期，请重新复制 Cookie");
      }
      if (parsed.kind === "http") {
        return usageError("积分明细接口返回 HTTP {status}", { status: parsed.status });
      }
      if (parsed.kind === "biz") {
        return usageError("积分明细查询失败：{detail}", { detail: parsed.detail });
      }
      if (parsed.kind === "parse") {
        return usageError("积分明细返回数据解析失败：{detail}", { detail: parsed.detail });
      }
      rows.push(...parsed.rows);
      total = parsed.total;
      if (rows.length >= total || parsed.rows.length === 0) break;
    }
    return { status: "ok", data: { rows, total: total || rows.length } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return usageError("积分明细查询失败：{detail}", { detail });
  }
};

// ─── 聚合（纯函数） ───

export interface WorkbuddyModelUsage {
  readonly model: string;
  readonly requests: number;
  readonly credits: number;
}

export interface WorkbuddyPurposeUsage {
  readonly purpose: string;
  readonly requests: number;
  readonly credits: number;
}

export interface WorkbuddyDailyUsage {
  readonly credits: number;
  readonly requests: number;
}

export interface WorkbuddyUsageAggregates {
  /** 按积分消耗降序 */
  readonly perModel: WorkbuddyModelUsage[];
  /** 按积分消耗降序 */
  readonly perPurpose: WorkbuddyPurposeUsage[];
  /** 连续自然日标签（本地时区 "YYYY-MM-DD"，与所选范围对齐；每日 {credits, requests}） */
  readonly dayLabels: string[];
  readonly daily: Record<string, WorkbuddyDailyUsage>;
  /** 每日按模型堆叠（积分消耗）：模型按总消耗降序，与 perModel 同序 */
  readonly dailyCreditsSeries: { name: string; values: number[] }[];
  /** 每日按模型堆叠（请求次数）：同上排序 */
  readonly dailyRequestsSeries: { name: string; values: number[] }[];
  readonly totalRequests: number;
  readonly totalCredits: number;
  /** 所选范围的自然日跨度（与 DeepSeek 统计的 days 口径一致），日均/单次均耗的分母 */
  readonly days: number;
  readonly dailyAvgCredits: number;
  readonly avgPerRequest: number;
}

/** 行时间 "YYYY-MM-DD HH:mm:ss" → 本地日标签（服务端与用户同为 CST 时无偏差） */
const dayLabelOf = (time: string): string => time.slice(0, 10);

/** 聚合消耗明细：模型/用途/每日三维度 + 合计。0 积分的内部调用（如 hy3 会话摘要）
 *  如实计入次数——平均单次消耗因此被拉低是真实构成，不做过滤 */
export const aggregateWorkbuddyUsage = (
  rows: WorkbuddyUsageRow[],
  startMs: number,
  endMs: number,
): WorkbuddyUsageAggregates => {
  const modelMap = new Map<string, { requests: number; credits: number }>();
  const purposeMap = new Map<string, { requests: number; credits: number }>();
  const dailyMap = new Map<string, { credits: number; requests: number }>();
  /** 模型×天 的积分/次数（堆叠图用）：键 `${model}\u0000${day}` */
  const modelDayCredits = new Map<string, number>();
  const modelDayRequests = new Map<string, number>();
  let totalRequests = 0;
  let totalCredits = 0;

  for (const row of rows) {
    const credit = Number.isFinite(row.credit) ? row.credit : 0;
    const day = dayLabelOf(row.time);
    totalRequests += 1;
    totalCredits += credit;

    const model = modelMap.get(row.model) ?? { requests: 0, credits: 0 };
    model.requests += 1;
    model.credits += credit;
    modelMap.set(row.model, model);

    const purpose = purposeMap.get(row.purpose) ?? { requests: 0, credits: 0 };
    purpose.requests += 1;
    purpose.credits += credit;
    purposeMap.set(row.purpose, purpose);

    const daily = dailyMap.get(day) ?? { credits: 0, requests: 0 };
    daily.credits += credit;
    daily.requests += 1;
    dailyMap.set(day, daily);

    const modelDay = `${row.model}\u0000${day}`;
    modelDayCredits.set(modelDay, (modelDayCredits.get(modelDay) ?? 0) + credit);
    modelDayRequests.set(modelDay, (modelDayRequests.get(modelDay) ?? 0) + 1);
  }

  const perModel = [...modelMap.entries()]
    .map(([model, usage]) => ({ model, ...usage }))
    .sort((a, b) => b.credits - a.credits || b.requests - a.requests);
  const perPurpose = [...purposeMap.entries()]
    .map(([purpose, usage]) => ({ purpose, ...usage }))
    .sort((a, b) => b.credits - a.credits || b.requests - a.requests);

  // 连续自然日标签（本地时区）：与所选范围对齐，无请求的天补零
  const dayLabels: string[] = [];
  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < endMs) {
    dayLabels.push(
      `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`,
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  const daily: Record<string, WorkbuddyDailyUsage> = {};
  for (const label of dayLabels) {
    const usage = dailyMap.get(label);
    daily[label] = { credits: usage?.credits ?? 0, requests: usage?.requests ?? 0 };
  }
  const buildSeries = (
    lookup: Map<string, number>,
  ): { name: string; values: number[] }[] =>
    perModel.map((model) => ({
      name: model.model,
      values: dayLabels.map((label) => lookup.get(`${model.model}\u0000${label}`) ?? 0),
    }));

  const days = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
  return {
    perModel,
    perPurpose,
    dayLabels,
    daily,
    dailyCreditsSeries: buildSeries(modelDayCredits),
    dailyRequestsSeries: buildSeries(modelDayRequests),
    totalRequests,
    totalCredits,
    days,
    dailyAvgCredits: totalCredits / days,
    avgPerRequest: totalRequests > 0 ? totalCredits / totalRequests : 0,
  };
};
