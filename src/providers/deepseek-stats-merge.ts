export interface DeepSeekKeyInfo {
  readonly id: string;
  readonly name: string;
}

export interface DeepSeekDailyRow {
  readonly day: string;
  readonly model: string;
  readonly keyId: string;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
  readonly costCny: number;
}

export interface DeepSeekUsageBundle {
  readonly apiKeys: DeepSeekKeyInfo[];
  readonly rows: DeepSeekDailyRow[];
  readonly currency: string;
}

interface UsageQuery {
  readonly start: number;
  readonly end: number;
  readonly tz: number;
}

interface DeepSeekApiKeyRef {
  readonly tracking_id?: string;
  readonly name?: string;
}

interface DeepSeekUsageCounters {
  readonly RESPONSE_TOKEN?: number;
  readonly REQUEST?: number;
  readonly PROMPT_CACHE_HIT_TOKEN?: number;
  readonly PROMPT_CACHE_MISS_TOKEN?: number;
}

interface DeepSeekAmountBucket {
  readonly time: number;
  readonly usage?: DeepSeekUsageCounters;
}

interface DeepSeekAmountSeries {
  readonly api_key?: DeepSeekApiKeyRef;
  readonly model?: string;
  readonly buckets?: readonly DeepSeekAmountBucket[];
}

interface DeepSeekBizEnvelope<TBody> {
  readonly biz_code?: number;
  readonly biz_msg?: string;
  readonly biz_data?: TBody;
}

export interface DeepSeekAmountResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: DeepSeekBizEnvelope<{ readonly series?: readonly DeepSeekAmountSeries[] }>;
}

interface DeepSeekCostBucket {
  readonly time: number;
  readonly cost?: string | number;
}

interface DeepSeekCostSeries {
  readonly api_key?: DeepSeekApiKeyRef;
  readonly model?: string;
  readonly buckets?: readonly DeepSeekCostBucket[];
}

export interface DeepSeekCostResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: DeepSeekBizEnvelope<{ readonly data?: readonly { readonly currency?: string; readonly series?: readonly DeepSeekCostSeries[] }[] }>;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 按本地时区把 Date 格式化为 "YYYY-MM-DD"。 */
export const dayLabelFromDate = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

type PlatformEnvelope = Pick<DeepSeekAmountResponse, "code" | "msg"> & {
  readonly data?: { readonly biz_code?: number; readonly biz_msg?: string };
};

/** code/biz_code 非 0 时返回错误消息，健康包裹层返回 null。 */
export const platformErrorMessage = (envelope: PlatformEnvelope): string | null => {
  if ((envelope.code ?? 0) !== 0) {
    return `DeepSeek 平台返回错误：${envelope.msg || "未知错误"}`;
  }
  if ((envelope.data?.biz_code ?? 0) !== 0) {
    return `DeepSeek 平台返回错误：${envelope.data?.biz_msg || "未知错误"}`;
  }
  return null;
};

const costLookupKey = (keyId: string, model: string, timeSec: number): string =>
  `${keyId}|${model}|${timeSec}`;

const collectCostBuckets = (lookup: Map<string, number>, series: DeepSeekCostSeries): void => {
  const keyId = series.api_key?.tracking_id ?? "";
  const model = series.model ?? "";
  for (const bucket of series.buckets ?? []) {
    const parsed = Number(bucket.cost ?? 0);
    lookup.set(costLookupKey(keyId, model, bucket.time), Number.isFinite(parsed) ? parsed : 0);
  }
};

const createCostLookup = (cost: DeepSeekCostResponse): Map<string, number> => {
  const lookup = new Map<string, number>();
  for (const group of cost.data?.biz_data?.data ?? []) {
    for (const series of group.series ?? []) {
      collectCostBuckets(lookup, series);
    }
  }
  return lookup;
};

const collectApiKeys = (amount: DeepSeekAmountResponse): DeepSeekKeyInfo[] => {
  const seen = new Map<string, DeepSeekKeyInfo>();
  for (const series of amount.data?.biz_data?.series ?? []) {
    const id = series.api_key?.tracking_id;
    if (!id || seen.has(id)) continue;
    seen.set(id, { id, name: series.api_key?.name ?? "" });
  }
  return [...seen.values()];
};

const buildSeriesRows = (
  series: DeepSeekAmountSeries,
  costLookup: Map<string, number>,
  dayLabel: (timeSec: number) => string,
): DeepSeekDailyRow[] => {
  const keyId = series.api_key?.tracking_id ?? "";
  const model = series.model ?? "";
  const rows: DeepSeekDailyRow[] = [];
  for (const bucket of series.buckets ?? []) {
    const usage = bucket.usage ?? {};
    rows.push({
      day: dayLabel(bucket.time),
      model,
      keyId,
      cacheHitTokens: usage.PROMPT_CACHE_HIT_TOKEN ?? 0,
      cacheMissTokens: usage.PROMPT_CACHE_MISS_TOKEN ?? 0,
      outputTokens: usage.RESPONSE_TOKEN ?? 0,
      requests: usage.REQUEST ?? 0,
      costCny: costLookup.get(costLookupKey(keyId, model, bucket.time)) ?? 0,
    });
  }
  return rows;
};

/** 以 amount 的每条 (series × bucket) 为一行，按 (密钥, 模型, 天) 关联合并 cost。 */
export const mergeDeepSeekUsage = (
  amount: DeepSeekAmountResponse,
  cost: DeepSeekCostResponse,
  dayLabel: (timeSec: number) => string = (timeSec) => dayLabelFromDate(new Date(timeSec * 1000)),
): DeepSeekUsageBundle => {
  const costLookup = createCostLookup(cost);
  const rows = (amount.data?.biz_data?.series ?? []).flatMap((series) =>
    buildSeriesRows(series, costLookup, dayLabel),
  );
  return {
    apiKeys: collectApiKeys(amount),
    rows,
    currency: cost.data?.biz_data?.data?.[0]?.currency ?? "CNY",
  };
};

export type { UsageQuery };
