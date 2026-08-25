/**
 * opencode.ai server-function RPC 返回对象 → 领域模型的映射。
 *
 * 服务端字段命名混合（月度行用 keyId，历史记录用 keyID/sessionID），
 * 全部按未知数据处理：缺失或类型不符时回退零值，映射本身永不抛错。
 */

export interface OpenCodeKeyInfo {
  id: string;
  displayName: string;
}

export interface OpenCodeDailyCostPoint {
  date: string;
  model: string;
  costUsd: number;
  keyId: string;
}

export interface OpenCodeMonthlyBundle {
  costs: OpenCodeDailyCostPoint[];
  keys: OpenCodeKeyInfo[];
}

export interface OpenCodeUsageRecord {
  id: string;
  timeCreated: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  keyId: string;
  sessionId: string;
}

type UnknownRecord = Record<string, unknown>;

/** cost 原始单位为 1e-8 美元（实测 763124625 → $7.63）。 */
const COST_UNIT_SCALE = 1e8;

const asRecord = (value: unknown): UnknownRecord =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const asFiniteNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const asCostUsd = (value: unknown): number => asFiniteNumber(value) / COST_UNIT_SCALE;

/** new Date("...") 已被解析器还原为原始字符串，这里校验并规范化为 ISO。 */
const asIsoTimestamp = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};

const mapKeyInfo = (item: unknown): OpenCodeKeyInfo => {
  const record = asRecord(item);
  return { id: asText(record.id), displayName: asText(record.displayName) };
};

const mapDailyCostPoint = (item: unknown): OpenCodeDailyCostPoint => {
  const record = asRecord(item);
  return {
    date: asText(record.date),
    model: asText(record.model),
    costUsd: asCostUsd(record.totalCost),
    keyId: asText(record.keyId),
  };
};

const mapUsageRecord = (item: unknown): OpenCodeUsageRecord => {
  const record = asRecord(item);
  return {
    id: asText(record.id),
    timeCreated: asIsoTimestamp(record.timeCreated),
    model: asText(record.model),
    inputTokens: asFiniteNumber(record.inputTokens),
    outputTokens: asFiniteNumber(record.outputTokens),
    reasoningTokens: asFiniteNumber(record.reasoningTokens),
    cacheReadTokens: asFiniteNumber(record.cacheReadTokens),
    costUsd: asCostUsd(record.cost),
    keyId: asText(record.keyID),
    sessionId: asText(record.sessionID),
  };
};

/** 月度聚合返回 `{usage:[...], keys:[...]}` → OpenCodeMonthlyBundle（丢弃 plan/deleted）。 */
export const mapMonthlyBundle = (payload: unknown): OpenCodeMonthlyBundle => {
  const root = asRecord(payload);
  return {
    costs: asArray(root.usage).map(mapDailyCostPoint),
    keys: asArray(root.keys).map(mapKeyInfo),
  };
};

/** 历史分页返回用量记录数组 → OpenCodeUsageRecord[]（丢弃 enrichment 等未建模字段）。 */
export const mapHistoryRecords = (payload: unknown): OpenCodeUsageRecord[] =>
  asArray(payload).map(mapUsageRecord);
