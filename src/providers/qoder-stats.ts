import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, InstanceCredentialStatus, ProviderInstance } from "../types/ipc";
import type { StatsResult } from "./stats-result";
import {
  CREDENTIAL_EXPIRED_MESSAGE,
  CREDENTIAL_MISSING_MESSAGE,
  CREDENTIAL_SLOT,
  qoderSiteConfig,
  qoderSiteOf,
  qoderUsageHeaders,
} from "./qoder";

// 统计页的三个端点与契约来自 2026-09-24/25 两站真机 DevTools 实测（记录见 ADR-0030）：
// - 明细 GET /api/v1/me/usages/big_model_credits/histories
//       ?page&page_size&start_time&end_time&order_by=begin_at&order=-1
//   响应 `{ data[], page_result }`，page_result 带 `last_page`/`total_size`；参数名是 snake_case
//   （猜的 limit/size/pageSize/pageNum/offset/skip/days/period/range 全部无效）
// - 身份 GET /api/v1/me → **只取 `id`**。响应里还有 name/username/email/avatar，一个都不进模型、
//   不进日志、错误文案里也不回显响应体（隐私面，ADR-0030）
// - 热力图 GET /api/v1/me/ai-conversations/credits-heatmap?userId=&days=
//   响应 `{ year, unit, levels[4], items[{date,value}], total }`；levels 是官方算好的分档阈值
// - `cost-center/credits/daily-trend` 实测有区间上限（92 天报 INVALID_TIME_RANGE）且不比本地聚合
//   省什么，**不接**；每日趋势由明细按自然日聚合
//
// 一条已知的口径差异（别当 bug 查）：histories 的 `credits` 服务端已按 2 位小数舍入
// （实测 06-23 那条 = 1.44），heatmap 同一天给的是原值 1.4547109588 —— 两处数字天生不完全相等。

/** 单页条数：实测 page_size=1000 时 535 条的号一次回全（last_page=1） */
const PAGE_SIZE = 1000;
/** 分页防御上限：10 页 ×1000 条，越界按已得数据收口（与 workbuddy-stats 同策略） */
const MAX_PAGES = 10;
const DAY_MS = 86_400_000;

/** 逐条消耗明细的一行。刻意不取的字段：`name`（两站 562 条样本恒为空串）、
 *  `discount_visible`（恒 true）、`original_cost`（折前金额没有展示位） */
export interface QoderUsageRow {
  /** 记录时刻（毫秒 epoch，等于 begin_at） */
  readonly time: number;
  readonly beginAt: number;
  readonly finishAt: number;
  /** IDE / CLI / Qoder（官网原样，不翻译） */
  readonly source: string;
  /** Agent / Quest Mode / Repo Wiki / Security Scan / Voice Input / Experts / Optimize Input / Ask
   *  —— 官网 UI 上直接露出的功能名，翻译会让统计页与官网按钮对不上，故原样显示 */
  readonly operation: string;
  /** Charged / Not Charged */
  readonly kind: string;
  /** 折后实扣积分（服务端 2 位小数），一切聚合都用它 */
  readonly credits: number;
  readonly originalCredits: number;
  /** 模型名随官方上新无限增长，原样显示、不做映射 */
  readonly modelCategory: string;
  /** 官网自己给的 USD 金额：只在明细里原样列一列，不进图、不进汇总、不参与余额逻辑 */
  readonly cost: number;
  readonly discountFactor: number;
}

export interface QoderUsageBundle {
  readonly rows: QoderUsageRow[];
  /** 区间内总条数（服务端 total_size） */
  readonly total: number;
}

export interface QoderHeatmapDay {
  readonly date: string;
  readonly value: number;
}

export interface QoderHeatmap {
  readonly unit: string;
  /** 官方分档阈值（升序 4 档），配色档位直接用它，不自己发明分位数 */
  readonly levels: number[];
  readonly items: QoderHeatmapDay[];
  readonly total: number;
}

interface PageResultRaw {
  last_page?: unknown;
  total_size?: unknown;
}

interface HistoriesEnvelope {
  data?: Array<Record<string, unknown>>;
  page_result?: PageResultRaw;
}

interface MeEnvelope {
  id?: unknown;
}

interface HeatmapEnvelope {
  unit?: unknown;
  levels?: unknown;
  items?: unknown;
  total?: unknown;
}

/** 数值字段：非有限数按 0（明细里缺一个数字不该让整页失败） */
const num = (raw: unknown): number => (typeof raw === "number" && Number.isFinite(raw) ? raw : 0);
const str = (raw: unknown): string => (typeof raw === "string" ? raw : "");

/** 响应体分类：401/403 与「200 + 登录页 HTML」同义，出路都是重贴 Cookie */
function classify(result: HttpResult): { kind: "ok" } | { kind: "expired" } | { kind: "http"; status: number } {
  if (result.status === 401 || result.status === 403) return { kind: "expired" };
  if (result.status !== 200) return { kind: "http", status: result.status };
  if (result.bodyText.trimStart().startsWith("<")) return { kind: "expired" };
  return { kind: "ok" };
}

/** 明细响应 → 行数组（字段名只有 snake_case 一套，两站实测如此，不做没证据的双兼容） */
export function parseHistories(
  bodyText: string,
): { kind: "ok"; value: { rows: QoderUsageRow[]; total: number; lastPage: number } } | { kind: "parse"; detail: string } {
  try {
    const json = JSON.parse(bodyText) as HistoriesEnvelope;
    const rows = (json.data ?? []).map((row) => ({
      time: num(row.time),
      beginAt: num(row.begin_at),
      finishAt: num(row.finish_at),
      source: str(row.source),
      operation: str(row.operation),
      kind: str(row.kind),
      credits: num(row.credits),
      originalCredits: num(row.original_credits),
      modelCategory: str(row.model_category),
      cost: num(row.cost),
      discountFactor: row.discount_factor == null ? 1 : num(row.discount_factor),
    }));
    return {
      kind: "ok",
      value: { rows, total: num(json.page_result?.total_size), lastPage: num(json.page_result?.last_page) },
    };
  } catch (error) {
    return { kind: "parse", detail: error instanceof Error ? error.message : String(error) };
  }
}

const statsError = <T>(message: string, params?: Record<string, string | number>): StatsResult<T> => ({
  status: "error",
  message,
  ...(params ? { params } : {}),
});

async function requestQoder(instance: ProviderInstance, url: string): Promise<HttpResult> {
  return invoke<HttpResult>("provider_request", {
    instanceId: instance.id,
    url,
    method: "GET",
    auth: "qoder_cookie",
    credentialSlot: CREDENTIAL_SLOT,
    headers: qoderUsageHeaders(qoderSiteOf(instance)),
  });
}

/** 凭据槽状态：缺失时统计页与卡片给同一句话 */
async function hasCredential(instance: ProviderInstance): Promise<boolean> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  return Boolean(status[CREDENTIAL_SLOT]);
}

/** 拉取区间内的全部消耗明细（分页拉全，供本地聚合）。始终显式传 start/end，
 *  不依赖服务端「默认从本积分周期起」那个推断口径 */
export async function fetchQoderUsage(
  instance: ProviderInstance,
  startMs: number,
  endMs: number,
): Promise<StatsResult<QoderUsageBundle>> {
  try {
    if (!(await hasCredential(instance))) {
      return { status: "needs_config", message: CREDENTIAL_MISSING_MESSAGE };
    }
    const { historiesUrl } = qoderSiteConfig(qoderSiteOf(instance));
    const rows: QoderUsageRow[] = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        page: String(page),
        page_size: String(PAGE_SIZE),
        start_time: String(startMs),
        // 区间的 endMs 是结束日次日零点，服务端按含边界算，退一秒取回末日最后一刻
        end_time: String(endMs - 1),
        order_by: "begin_at",
        order: "-1",
      });
      const result = await requestQoder(instance, `${historiesUrl}?${query.toString()}`);
      const status = classify(result);
      if (status.kind === "expired") return statsError<QoderUsageBundle>(CREDENTIAL_EXPIRED_MESSAGE);
      if (status.kind === "http") {
        return statsError<QoderUsageBundle>("消耗明细接口返回 HTTP {status}", { status: status.status });
      }
      const parsed = parseHistories(result.bodyText);
      if (parsed.kind === "parse") {
        return statsError<QoderUsageBundle>("消耗明细返回数据解析失败：{detail}", { detail: parsed.detail });
      }
      rows.push(...parsed.value.rows);
      total = parsed.value.total;
      if (parsed.value.rows.length === 0 || rows.length >= total || page >= parsed.value.lastPage) break;
    }
    return { status: "ok", data: { rows, total: total || rows.length } };
  } catch (error) {
    return statsError<QoderUsageBundle>("消耗明细查询失败：{detail}", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** userId 是个人信息：只在内存里按实例缓存，不落盘、不进日志（重贴凭据后随进程重启失效） */
const userIdCache = new Map<string, string>();

/** 热力图要 userId 入参，而我们的凭据只有 Cookie 值 → 先打一次身份端点，只取 id */
export async function fetchQoderUserId(instance: ProviderInstance): Promise<StatsResult<string>> {
  const cached = userIdCache.get(instance.id);
  if (cached) return { status: "ok", data: cached };
  if (!(await hasCredential(instance))) {
    return { status: "needs_config", message: CREDENTIAL_MISSING_MESSAGE };
  }
  const { meUrl } = qoderSiteConfig(qoderSiteOf(instance));
  const result = await requestQoder(instance, meUrl);
  const status = classify(result);
  if (status.kind === "expired") return statsError<string>(CREDENTIAL_EXPIRED_MESSAGE);
  if (status.kind === "http") {
    return statsError<string>("身份接口返回 HTTP {status}", { status: status.status });
  }
  try {
    const id = str((JSON.parse(result.bodyText) as MeEnvelope).id);
    if (!id) return statsError<string>("身份接口未返回账号标识，无法取近一年消耗分布");
    userIdCache.set(instance.id, id);
    return { status: "ok", data: id };
  } catch (error) {
    return statsError<string>("身份接口返回数据解析失败：{detail}", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 近一年每日消耗分布（days 默认 366，与官网的「近一年」同口径） */
export async function fetchQoderHeatmap(
  instance: ProviderInstance,
  days = 366,
): Promise<StatsResult<QoderHeatmap>> {
  try {
    const me = await fetchQoderUserId(instance);
    if (me.status !== "ok") return me;
    const { heatmapUrl } = qoderSiteConfig(qoderSiteOf(instance));
    const query = new URLSearchParams({ userId: me.data, days: String(days) });
    const result = await requestQoder(instance, `${heatmapUrl}?${query.toString()}`);
    const status = classify(result);
    if (status.kind === "expired") return statsError<QoderHeatmap>(CREDENTIAL_EXPIRED_MESSAGE);
    if (status.kind === "http") {
      return statsError<QoderHeatmap>("消耗分布接口返回 HTTP {status}", { status: status.status });
    }
    try {
      const json = JSON.parse(result.bodyText) as HeatmapEnvelope;
      const items = Array.isArray(json.items)
        ? json.items.map((item: Record<string, unknown>) => ({
            date: str(item?.date),
            value: num(item?.value),
          }))
        : [];
      return {
        status: "ok",
        data: {
          unit: str(json.unit) || "credits",
          levels: Array.isArray(json.levels) ? json.levels.map(num) : [],
          items,
          total: num(json.total),
        },
      };
    } catch (error) {
      return statsError<QoderHeatmap>("消耗分布返回数据解析失败：{detail}", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (error) {
    return statsError<QoderHeatmap>("消耗分布查询失败：{detail}", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── 聚合（纯函数） ───

export interface QoderGroupUsage {
  readonly name: string;
  readonly requests: number;
  readonly credits: number;
}

export interface QoderDailyUsage {
  readonly credits: number;
  readonly requests: number;
}

export interface QoderUsageAggregates {
  /** 按用途（operation）消耗降序 */
  readonly perOperation: QoderGroupUsage[];
  /** 按模型类别消耗降序 */
  readonly perModel: QoderGroupUsage[];
  /** 连续自然日标签（本地时区 "YYYY-MM-DD"，与所选区间口径一致） */
  readonly dayLabels: string[];
  readonly daily: Record<string, QoderDailyUsage>;
  /** 每日按用途堆叠的积分系列（与 perOperation 同序） */
  readonly dailyCreditsSeries: { name: string; values: number[] }[];
  /** 每日按用途堆叠的次数系列 */
  readonly dailyRequestsSeries: { name: string; values: number[] }[];
  readonly totalRequests: number;
  readonly totalCredits: number;
  /** 所选区间的自然日跨度（日均的分母） */
  readonly days: number;
  readonly dailyAvgCredits: number;
  /** 折前合计与实扣的差 = 活动/折扣省下的积分（明细里逐行也有折扣，这里只给总和） */
  readonly savedCredits: number;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 毫秒 → 本地时区 "YYYY-MM-DD"（与 resolveRangeMs 的本地零点是同一口径） */
export const qoderDayKey = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

/** 区间内的连续日标签（含首尾）；endMs 是结束日次日零点，故减一毫秒再取日 */
export function qoderDayLabels(startMs: number, endMs: number): string[] {
  const first = new Date(startMs);
  const labels: string[] = [];
  const lastMs = endMs - 1;
  for (let cursor = first.getTime(); cursor <= lastMs; cursor += DAY_MS) {
    labels.push(qoderDayKey(cursor));
  }
  return labels;
}

const pushGroup = (
  map: Map<string, { requests: number; credits: number }>,
  key: string,
  credits: number,
): void => {
  const group = map.get(key) ?? { requests: 0, credits: 0 };
  group.requests += 1;
  group.credits += credits;
  map.set(key, group);
};

const toSortedGroups = (
  map: Map<string, { requests: number; credits: number }>,
): QoderGroupUsage[] =>
  [...map.entries()]
    .map(([name, group]) => ({ name, requests: group.requests, credits: group.credits }))
    .sort((a, b) => b.credits - a.credits);

/** 聚合明细：用途 / 模型 / 每日三维度 + 合计。Not Charged 的记录 credits 为 0，
 *  如实计入次数（活动免费调用是真实构成，过滤掉会让「日均消耗」虚高） */
export function aggregateQoderUsage(
  rows: QoderUsageRow[],
  startMs: number,
  endMs: number,
): QoderUsageAggregates {
  const modelMap = new Map<string, { requests: number; credits: number }>();
  const operationMap = new Map<string, { requests: number; credits: number }>();
  const dailyMap = new Map<string, { credits: number; requests: number }>();
  const operationDayCredits = new Map<string, number>();
  const operationDayRequests = new Map<string, number>();
  let totalCredits = 0;
  let originalCredits = 0;

  for (const row of rows) {
    const day = qoderDayKey(row.time);
    pushGroup(modelMap, row.modelCategory || "未知模型", row.credits);
    pushGroup(operationMap, row.operation || "未知用途", row.credits);
    const daily = dailyMap.get(day) ?? { credits: 0, requests: 0 };
    daily.credits += row.credits;
    daily.requests += 1;
    dailyMap.set(day, daily);
    const creditKey = `${row.operation}\u0000${day}`;
    operationDayCredits.set(creditKey, (operationDayCredits.get(creditKey) ?? 0) + row.credits);
    operationDayRequests.set(creditKey, (operationDayRequests.get(creditKey) ?? 0) + 1);
    totalCredits += row.credits;
    originalCredits += row.originalCredits;
  }

  const perOperation = toSortedGroups(operationMap);
  const dayLabels = qoderDayLabels(startMs, endMs);
  const seriesFor = (source: Map<string, number>) =>
    perOperation.map((group) => ({
      name: group.name,
      values: dayLabels.map((day) => source.get(`${group.name}\u0000${day}`) ?? 0),
    }));

  return {
    perOperation,
    perModel: toSortedGroups(modelMap),
    dayLabels,
    daily: Object.fromEntries(dayLabels.map((day) => [day, dailyMap.get(day) ?? { credits: 0, requests: 0 }])),
    dailyCreditsSeries: seriesFor(operationDayCredits),
    dailyRequestsSeries: seriesFor(operationDayRequests),
    totalRequests: rows.length,
    totalCredits,
    days: dayLabels.length,
    dailyAvgCredits: dayLabels.length > 0 ? totalCredits / dayLabels.length : 0,
    savedCredits: Math.max(0, originalCredits - totalCredits),
  };
}
