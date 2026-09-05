import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, InstanceCredentialStatus, ProviderInstance } from "../types/ipc";
import type { StatsResult } from "./stats-result";
import {
  countAvailableResets,
  parseGlmBalance,
  toAmount,
  type GlmBalanceData,
  type GlmPackageResetData,
  type GlmResetCardRaw,
} from "./glm";

// 端点与响应结构以 2026-09-02 实测为准（ADR-0009/0010， Spike 回填）：
// - model-usage / tool-usage 均带 startTime/endTime（本地时区 "yyyy-MM-dd HH:mm:ss"，URL 编码），
//   Coding Plan API Key 鉴权（Bearer），granularity 随跨度自动切换（短窗 hourly、长窗 daily）
// - x_time 为桶起点（本地时间），各序列按 x_time 对齐（列式结构）
// - 按模型仅提供 Token 序列（modelDataList）；请求次数只有全模型合计（modelCallCount）；无费用字段
// - tool-usage 展示序列以动态 toolDataList 为权威（服务端只下发有调用的工具，自带双语名）；
//   字段名 2026-09-04 实测确认（usageCount 次数序列 / totalUsageCount 合计），固定三序列
//   （networkSearchCount 等）是同一批数据的旧形态别名，仅在动态列表为空时兜底。
//   接口只提供调用次数：官网「积分消耗」为前端按单价折算，单价不在接口响应中。
const MODEL_USAGE_URL = "https://open.bigmodel.cn/api/monitor/usage/model-usage";
const TOOL_USAGE_URL = "https://open.bigmodel.cn/api/monitor/usage/tool-usage";
// 账户余额 / 重置卡：与配额同一枚 Coding Plan Key 鉴权（ADR-0013/0014）
const BALANCE_URL = "https://www.bigmodel.cn/api/biz/account/query-customer-account-report";
const RESET_URL = "https://www.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL";
// 使用重置卡（官网前端源码 claude-usage bundle，2026-09-05 静态分析固化）：
// resetType 枚举 FIVE_HOUR/WEEK；requestId 由客户端生成的幂等 UUID，失败后官网会换 ID 重试
const RESET_USE_URL = "https://www.bigmodel.cn/api/biz/customer-package-reset/use";
/** 官网对该错误会自动刷新列表（卡已不可用：被用掉/过期） */
export const RESET_CARD_UNAVAILABLE_MSG = "指定的重置次数不可用，请刷新后重试";

/** resetType 取值与 list 响应字段/窗口的对应关系（官网 w 映射表） */
export type GlmResetType = "FIVE_HOUR" | "WEEK";

export interface GlmUsageQuery {
  startTime: string;
  endTime: string;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 毫秒时间戳 → 本地时区 "yyyy-MM-dd HH:mm:ss"（官方 glm-plan-usage 插件同款格式） */
const toLocalDateTime = (ms: number): string => {
  const date = new Date(ms);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
};

/**
 * 取数区间 → 查询参数：startMs 为起始日零点、endMs 为结束日次日零点（与 DeepSeek 统计约定一致）。
 * endTime 回退 1 毫秒落到结束日 23:59:59——接口的桶边界含首尾，直接传次日零点会多出一天空桶。
 */
export const buildGlmUsageQuery = (startMs: number, endMs: number): GlmUsageQuery => ({
  startTime: toLocalDateTime(startMs),
  endTime: toLocalDateTime(endMs - 1),
});

interface GlmStatsEnvelope<T> {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: T;
}

interface GlmModelEntryRaw {
  modelName?: string;
  sortOrder?: number;
  tokensUsage?: number[];
  totalTokens?: number;
}

interface GlmModelUsageRaw {
  x_time?: string[];
  modelCallCount?: number[];
  tokensUsage?: number[];
  totalUsage?: {
    totalModelCallCount?: number;
    totalTokensUsage?: number;
  };
  modelDataList?: GlmModelEntryRaw[];
  granularity?: string;
}

interface GlmToolEntryRaw {
  toolCode?: string;
  /** 服务端中文名（如 "联网搜索 MCP"） */
  toolName?: string;
  /** 服务端英文名（如 "Web Search MCP"） */
  toolNameI18n?: string;
  sortOrder?: number;
  /** 按桶对齐的调用次数序列（2026-09-04 实测确认） */
  usageCount?: number[];
  totalUsageCount?: number;
}

interface GlmToolUsageRaw {
  x_time?: string[];
  networkSearchCount?: number[];
  webReadMcpCount?: number[];
  zreadMcpCount?: number[];
  totalUsage?: {
    totalNetworkSearchCount?: number;
    totalWebReadMcpCount?: number;
    totalZreadMcpCount?: number;
  };
  toolDataList?: GlmToolEntryRaw[];
  granularity?: string;
}

export interface GlmModelSeries {
  name: string;
  /** 与 buckets 对齐的逐桶 Token 数 */
  tokens: number[];
  totalTokens: number;
}

export interface GlmModelUsage {
  /** 桶起点（本地时间）：daily 为 "YYYY-MM-DD"，hourly 为 "YYYY-MM-DD HH:mm" */
  buckets: string[];
  granularity: string;
  /** 全模型合计的逐桶请求数（接口不提供按模型的请求数） */
  callCount: number[];
  /** 全模型合计的逐桶 Token 数 */
  tokens: number[];
  totals: { calls: number; tokens: number };
  models: GlmModelSeries[];
}

export interface GlmToolSeries {
  /** 动态序列为服务端中文名原样展示；固定序列为中文词条 key（渲染端 t() 翻译） */
  name: string;
  /** 服务端英文名（仅动态序列下发），英文界面优先于 t(name) */
  i18nName?: string;
  counts: number[];
  total: number;
}

export interface GlmToolUsage {
  buckets: string[];
  granularity: string;
  fixed: GlmToolSeries[];
  tools: GlmToolSeries[];
  totals: { networkSearch: number; webReadMcp: number; zreadMcp: number };
  totalCalls: number;
}

export interface GlmUsageBundle {
  models: GlmModelUsage;
  tools: GlmToolUsage;
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

/** 序列按桶数对齐：缺失位补 0，超长截断 */
const align = (values: number[] | undefined, size: number): number[] => {
  const source = values ?? [];
  return Array.from({ length: size }, (_, index) => {
    const value = source[index];
    return typeof value === "number" ? value : 0;
  });
};

/** 解析 model-usage 响应：模型按 Token 合计降序（与 DeepSeek 统计的展示顺序一致） */
export function parseModelUsage(data: GlmModelUsageRaw | undefined): GlmModelUsage {
  const buckets = data?.x_time ?? [];
  const size = buckets.length;
  const callCount = align(data?.modelCallCount, size);
  const tokens = align(data?.tokensUsage, size);
  const models = (data?.modelDataList ?? [])
    .map((entry) => {
      const name = entry.modelName?.trim();
      if (!name) return null;
      const series = align(entry.tokensUsage, size);
      return { name, tokens: series, totalTokens: entry.totalTokens ?? sum(series) };
    })
    .filter((entry): entry is GlmModelSeries => entry !== null)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    buckets,
    granularity: data?.granularity ?? "",
    callCount,
    tokens,
    totals: {
      calls: data?.totalUsage?.totalModelCallCount ?? sum(callCount),
      tokens: data?.totalUsage?.totalTokensUsage ?? sum(tokens),
    },
    models,
  };
}

/** 固定序列的中文词条 key（en.ts 提供对照）；动态列表为空时兜底展示 */
const FIXED_TOOL_KEYS = ["联网搜索", "网页阅读（MCP）", "Zread（MCP）"] as const;

/**
 * 解析 tool-usage 响应：动态 toolDataList 为权威展示源（自带双语名、只含有调用的工具，
 * 字段名 2026-09-04 实测确认），为空时回退固定三序列（旧形态/全零兼容）。
 * 固定序列不再与动态列表拼接展示——它们是同一批数据的两份别名（实测序列值完全一致）。
 */
export function parseToolUsage(data: GlmToolUsageRaw | undefined): GlmToolUsage {
  const buckets = data?.x_time ?? [];
  const size = buckets.length;
  const rawFixedCounts = [data?.networkSearchCount, data?.webReadMcpCount, data?.zreadMcpCount];
  const fixed = rawFixedCounts.map((counts, index) => {
    const series = align(counts, size);
    return { name: FIXED_TOOL_KEYS[index], counts: series, total: sum(series) };
  });
  const totals = {
    networkSearch: data?.totalUsage?.totalNetworkSearchCount ?? fixed[0].total,
    webReadMcp: data?.totalUsage?.totalWebReadMcpCount ?? fixed[1].total,
    zreadMcp: data?.totalUsage?.totalZreadMcpCount ?? fixed[2].total,
  };

  const dynamic = (data?.toolDataList ?? [])
    .map((entry) => {
      const name = (entry.toolName ?? entry.toolCode)?.trim();
      if (!name) return null;
      const counts = align(entry.usageCount, size);
      const i18nName = entry.toolNameI18n?.trim();
      return {
        name,
        ...(i18nName ? { i18nName } : {}),
        counts,
        total: entry.totalUsageCount ?? sum(counts),
        order: entry.sortOrder ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .filter((entry): entry is (typeof entry) & {} => entry !== null)
    .sort((a, b) => a.order - b.order || b.total - a.total);

  const tools: GlmToolSeries[] =
    dynamic.length > 0
      ? dynamic.map(({ name, i18nName, counts, total }) => ({
          name,
          ...(i18nName ? { i18nName } : {}),
          counts,
          total,
        }))
      : fixed.filter((series) => series.total > 0);
  const totalCalls = sum(tools.map((tool) => tool.total));
  return { buckets, granularity: data?.granularity ?? "", fixed, tools, totals, totalCalls };
}

const requestGlm = (instanceId: string, url: string): Promise<HttpResult> =>
  invoke<HttpResult>("provider_request", {
    instanceId,
    url,
    method: "GET",
    auth: "bearer",
    headers: { Accept: "application/json" },
  });

const queryUrl = (base: string, query: GlmUsageQuery): string =>
  `${base}?startTime=${encodeURIComponent(query.startTime)}&endTime=${encodeURIComponent(query.endTime)}`;

const emptyToolUsage = (): GlmToolUsage => ({
  buckets: [],
  granularity: "",
  fixed: [],
  tools: [],
  totals: { networkSearch: 0, webReadMcp: 0, zreadMcp: 0 },
  totalCalls: 0,
});

/**
 * 拉取智谱用量统计：model-usage 为主（失败即整体失败），tool-usage 为辅
 * （失败降级为空工具数据，不拖垮模型统计）。
 */
export const fetchGlmUsage = async (
  instance: ProviderInstance,
  startMs: number,
  endMs: number,
): Promise<StatsResult<GlmUsageBundle>> => {
  try {
    const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
      instanceId: instance.id,
    });
    if (!status.planKey) {
      return { status: "needs_config", message: "请在设置中填写智谱 Coding Plan API Key" };
    }

    const query = buildGlmUsageQuery(startMs, endMs);
    const [modelHttp, toolHttp] = await Promise.all([
      requestGlm(instance.id, queryUrl(MODEL_USAGE_URL, query)),
      requestGlm(instance.id, queryUrl(TOOL_USAGE_URL, query)),
    ]);

    if (modelHttp.status !== 200) {
      return { status: "error", message: "智谱用量接口返回 HTTP {status}", params: { status: modelHttp.status } };
    }
    const modelJson = JSON.parse(modelHttp.bodyText) as GlmStatsEnvelope<GlmModelUsageRaw>;
    if (modelJson.success === false) {
      return {
        status: "error",
        message: "智谱用量查询失败：{detail}",
        params: {
          detail: `code=${modelJson.code ?? "unknown"}${modelJson.msg ? ` msg=${modelJson.msg}` : ""}`,
        },
      };
    }

    let tools = emptyToolUsage();
    if (toolHttp.status === 200) {
      try {
        const toolJson = JSON.parse(toolHttp.bodyText) as GlmStatsEnvelope<GlmToolUsageRaw>;
        if (toolJson.success !== false) tools = parseToolUsage(toolJson.data);
      } catch {
        // 工具端点响应异常：降级为空工具数据，模型统计不受影响
      }
    }

    return { status: "ok", data: { models: parseModelUsage(modelJson.data), tools } };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: "error", message: "智谱用量响应无法解析" };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "error", message: "智谱用量查询失败：{detail}", params: { detail } };
  }
};

/** 统计抽屉「账户」卡片区所需的余额明细（卡片快照只带当前余额，明细在抽屉展开） */
export interface GlmAccountBalance {
  /** 当前余额（元） */
  balance: number;
  /** 可用余额（元）；缺失回退当前余额 */
  availableBalance: number;
  rechargeAmount: number | null;
  giveAmount: number | null;
  totalSpendAmount: number | null;
  frozenBalance: number | null;
  /** 信用余额（元）；未开通为 null */
  creditBalance: number | null;
}

/** 解析余额响应为明细（当前余额解析不出时返回 null：纯订阅账户可能无现金数据） */
export function parseGlmAccountBalance(data: GlmBalanceData | undefined): GlmAccountBalance | null {
  const balance = parseGlmBalance(data);
  if (balance == null) return null;
  return {
    balance,
    availableBalance: toAmount(data?.availableBalance) ?? balance,
    rechargeAmount: toAmount(data?.rechargeAmount),
    giveAmount: toAmount(data?.giveAmount),
    totalSpendAmount: toAmount(data?.totalSpendAmount),
    frozenBalance: toAmount(data?.frozenBalance),
    creditBalance: toAmount(data?.creditBalance),
  };
}

/** 拉取智谱账户余额明细（统计抽屉用；与卡片快照的余额行同源、独立请求） */
export const fetchGlmAccountBalance = async (
  instanceId: string,
): Promise<StatsResult<GlmAccountBalance>> => {
  try {
    const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
      instanceId,
    });
    if (!status.planKey) {
      return { status: "needs_config", message: "请在设置中填写智谱 Coding Plan API Key" };
    }
    const http = await requestGlm(instanceId, BALANCE_URL);
    if (http.status !== 200) {
      return {
        status: "error",
        message: "智谱余额接口返回 HTTP {status}",
        params: { status: http.status },
      };
    }
    const json = JSON.parse(http.bodyText) as GlmStatsEnvelope<GlmBalanceData>;
    if (json.success === false) {
      return {
        status: "error",
        message: "智谱余额查询失败：{detail}",
        params: {
          detail: `code=${json.code ?? "unknown"}${json.msg ? ` msg=${json.msg}` : ""}`,
        },
      };
    }
    const balance = parseGlmAccountBalance(json.data);
    if (!balance) {
      return { status: "error", message: "智谱余额接口未返回可用数据" };
    }
    return { status: "ok", data: balance };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: "error", message: "智谱余额响应无法解析" };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "error", message: "智谱余额查询失败：{detail}", params: { detail } };
  }
};

/** 单张重置卡的展示态：available 即可用；不可用且已过期=已过期，不可用但未过期=已使用 */
export interface GlmResetCardItem {
  recordId: number | null;
  expireTime: string;
  status: "available" | "expired" | "used";
}

/** 统计抽屉「重置卡」卡片所需明细（官网「用量重置额度」，仅展示未使用或近 7 天已过期的记录） */
export interface GlmResetCardList {
  fiveHour: { available: number; items: GlmResetCardItem[] };
  week: { available: number; items: GlmResetCardItem[] };
}

/** "YYYY-MM-DD HH:mm:ss"（服务端本地时间）→ Date；与 toLocalDateTime 互逆 */
export function parseLocalDateTime(text: string | null | undefined): Date | null {
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(+year, +month - 1, +day, +hour, +minute, +second);
}

export function parseResetCardItem(card: GlmResetCardRaw, now: number): GlmResetCardItem {
  const expireTime = card.expireTime ?? "";
  if (card.available === true) return { recordId: card.recordId ?? null, expireTime, status: "available" };
  const expire = parseLocalDateTime(expireTime);
  return {
    recordId: card.recordId ?? null,
    expireTime,
    status: expire !== null && expire.getTime() < now ? "expired" : "used",
  };
}

/** 展示排序（官网同款）：可用卡置顶按到期时间升序（最先用完的排最前），已使用/已过期按到期时间降序（最近失效的在前） */
const sortResetItems = (items: GlmResetCardItem[]): GlmResetCardItem[] => {
  const expireAt = (item: GlmResetCardItem) =>
    parseLocalDateTime(item.expireTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return [...items].sort((a, b) => {
    if ((a.status === "available") !== (b.status === "available")) {
      return a.status === "available" ? -1 : 1;
    }
    return a.status === "available" ? expireAt(a) - expireAt(b) : expireAt(b) - expireAt(a);
  });
};

/** 解析重置额度响应为分组明细 */
export function parseGlmResetCards(
  data: GlmPackageResetData | undefined,
  now = Date.now(),
): GlmResetCardList {
  const group = (cards: GlmResetCardRaw[] | undefined) => ({
    available: countAvailableResets(cards),
    items: sortResetItems((cards ?? []).map((card) => parseResetCardItem(card, now))),
  });
  return { fiveHour: group(data?.fiveHourResets), week: group(data?.weekResets) };
}

/** 拉取智谱重置卡明细（统计抽屉用；与卡片快照的重置卡行同源、独立请求） */
export const fetchGlmResetCards = async (
  instanceId: string,
): Promise<StatsResult<GlmResetCardList>> => {
  try {
    const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
      instanceId,
    });
    if (!status.planKey) {
      return { status: "needs_config", message: "请在设置中填写智谱 Coding Plan API Key" };
    }
    const http = await requestGlm(instanceId, RESET_URL);
    if (http.status !== 200) {
      return {
        status: "error",
        message: "智谱重置卡接口返回 HTTP {status}",
        params: { status: http.status },
      };
    }
    const json = JSON.parse(http.bodyText) as GlmStatsEnvelope<GlmPackageResetData>;
    if (json.success === false) {
      return {
        status: "error",
        message: "智谱重置卡查询失败：{detail}",
        params: {
          detail: `code=${json.code ?? "unknown"}${json.msg ? ` msg=${json.msg}` : ""}`,
        },
      };
    }
    return { status: "ok", data: parseGlmResetCards(json.data) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: "error", message: "智谱重置卡响应无法解析" };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "error", message: "智谱重置卡查询失败：{detail}", params: { detail } };
  }
};

/**
 * 使用一张重置卡（不可逆，调用方需先经用户确认）。官网同款参数与幂等约定：
 * requestId 由客户端生成，成功后卡被消耗；「指定的重置次数不可用」错误时调用方应刷新列表。
 */
export const useGlmResetCard = async (
  instanceId: string,
  resetType: GlmResetType,
  recordId: number,
  requestId: string,
): Promise<StatsResult<true>> => {
  try {
    const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
      instanceId,
    });
    if (!status.planKey) {
      return { status: "needs_config", message: "请在设置中填写智谱 Coding Plan API Key" };
    }
    const http = await invoke<HttpResult>("provider_request", {
      instanceId,
      url: RESET_USE_URL,
      method: "POST",
      auth: "bearer",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      bodyText: JSON.stringify({ targetType: "PERSONAL", resetType, recordId, requestId }),
    });
    // 业务错误可能以非 200 的 HTTP 状态返回（2026-09-05 实测：过期卡 → HTTP 400 + code=400
    // + msg「指定的重置次数不可用，请刷新后重试」），能解析出业务 msg 就优先透出
    let json: GlmStatsEnvelope<unknown> | null = null;
    try {
      json = JSON.parse(http.bodyText) as GlmStatsEnvelope<unknown>;
    } catch {
      // 非 JSON 错误体（如网关错误页）：按 HTTP 状态处理
    }
    if (json && json.success === false) {
      return {
        status: "error",
        message: "使用重置卡失败：{detail}",
        params: { detail: json.msg ?? `code=${json.code ?? "unknown"}` },
      };
    }
    if (json === null && http.status === 200) {
      return { status: "error", message: "智谱重置卡响应无法解析" };
    }
    if (http.status !== 200 || json === null) {
      return {
        status: "error",
        message: "智谱重置卡接口返回 HTTP {status}",
        params: { status: http.status },
      };
    }
    return { status: "ok", data: true };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: "error", message: "智谱重置卡响应无法解析" };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "error", message: "使用重置卡失败：{detail}", params: { detail } };
  }
};
