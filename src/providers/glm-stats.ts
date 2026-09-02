import { invoke } from "@tauri-apps/api/core";
import type { CredentialStatus, HttpResult } from "../types/ipc";
import type { StatsResult } from "./stats-result";

// 端点与响应结构以 2026-09-02 实测为准（GLM_PROVIDER_PLAN.md 第 0 节 Spike 回填）：
// - model-usage / tool-usage 均带 startTime/endTime（本地时区 "yyyy-MM-dd HH:mm:ss"，URL 编码），
//   Coding Plan API Key 鉴权（Bearer），granularity 随跨度自动切换（短窗 hourly、长窗 daily）
// - x_time 为桶起点（本地时间），各序列按 x_time 对齐（列式结构）
// - 按模型仅提供 Token 序列（modelDataList）；请求次数只有全模型合计（modelCallCount）；无费用字段
// - tool-usage 固定三序列（联网搜索/网页阅读 MCP/Zread MCP）+ 动态 toolDataList
//   （实测账号无工具调用，toolDataList 为空，动态字段名按 modelDataList 同构容错）
const MODEL_USAGE_URL = "https://open.bigmodel.cn/api/monitor/usage/model-usage";
const TOOL_USAGE_URL = "https://open.bigmodel.cn/api/monitor/usage/tool-usage";

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
  toolName?: string;
  name?: string;
  count?: number[];
  usage?: number[];
  totalCount?: number;
  totalUsage?: number;
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
  /** 固定序列为中文词条 key（渲染端 t() 翻译）；动态序列为服务端工具名 */
  name: string;
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

const toSeries = (
  raw: { name?: string; counts?: number[]; total?: number } | undefined,
  size: number,
): GlmToolSeries | null => {
  if (!raw) return null;
  const name = raw.name?.trim();
  if (!name) return null;
  const counts = align(raw.counts, size);
  return { name, counts, total: raw.total ?? sum(counts) };
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

/** 固定工具序列的中文词条 key（en.ts 提供对照） */
const FIXED_TOOL_KEYS = ["联网搜索", "网页阅读（MCP）", "Zread（MCP）"] as const;

/**
 * 解析 tool-usage 响应：固定三序列 + 动态 toolDataList（容错：字段名按 modelDataList 同构猜测，
 * 实测样本 toolDataList 为空，无法核验字段名，解析不出即忽略该条目）。
 */
export function parseToolUsage(data: GlmToolUsageRaw | undefined): GlmToolUsage {
  const buckets = data?.x_time ?? [];
  const size = buckets.length;
  const rawCounts = [data?.networkSearchCount, data?.webReadMcpCount, data?.zreadMcpCount];
  const fixed = rawCounts.map((counts, index) => {
    const series = align(counts, size);
    return { name: FIXED_TOOL_KEYS[index], counts: series, total: sum(series) };
  });
  const totals = {
    networkSearch: data?.totalUsage?.totalNetworkSearchCount ?? fixed[0].total,
    webReadMcp: data?.totalUsage?.totalWebReadMcpCount ?? fixed[1].total,
    zreadMcp: data?.totalUsage?.totalZreadMcpCount ?? fixed[2].total,
  };
  const tools = (data?.toolDataList ?? [])
    .map((entry) =>
      toSeries(
        {
          name: entry.toolName ?? entry.name,
          counts: entry.count ?? entry.usage,
          total: entry.totalCount ?? entry.totalUsage,
        },
        size,
      ),
    )
    .filter((entry): entry is GlmToolSeries => entry !== null)
    .sort((a, b) => b.total - a.total);
  const totalCalls =
    totals.networkSearch + totals.webReadMcp + totals.zreadMcp + sum(tools.map((tool) => tool.total));
  return { buckets, granularity: data?.granularity ?? "", fixed, tools, totals, totalCalls };
}

const requestGlm = (url: string): Promise<HttpResult> =>
  invoke<HttpResult>("provider_request", {
    providerId: "glm",
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
  startMs: number,
  endMs: number,
): Promise<StatsResult<GlmUsageBundle>> => {
  try {
    const status = await invoke<CredentialStatus>("vault_credential_status");
    if (!status.glmCodingPlanKey) {
      return { status: "needs_config", message: "请在设置中填写智谱 Coding Plan API Key" };
    }

    const query = buildGlmUsageQuery(startMs, endMs);
    const [modelHttp, toolHttp] = await Promise.all([
      requestGlm(queryUrl(MODEL_USAGE_URL, query)),
      requestGlm(queryUrl(TOOL_USAGE_URL, query)),
    ]);

    if (modelHttp.status !== 200) {
      return { status: "error", message: `智谱用量接口返回 HTTP ${modelHttp.status}` };
    }
    const modelJson = JSON.parse(modelHttp.bodyText) as GlmStatsEnvelope<GlmModelUsageRaw>;
    if (modelJson.success === false) {
      return {
        status: "error",
        message: `智谱用量查询失败：code=${modelJson.code ?? "未知"}${modelJson.msg ? ` msg=${modelJson.msg}` : ""}`,
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
    return { status: "error", message: `智谱用量查询失败：${detail}` };
  }
};
