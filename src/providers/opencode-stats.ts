import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, InstanceCredentials, ProviderInstance } from "../types/ipc";
import type { StatsResult } from "./stats-result";
import { parseRpcResponse } from "./opencode-rpc-parser";
import {
  mapHistoryRecords,
  mapMonthlyBundle,
  type OpenCodeMonthlyBundle,
  type OpenCodeUsageRecord,
} from "./opencode-response-mapping";

export type {
  OpenCodeDailyCostPoint,
  OpenCodeKeyInfo,
  OpenCodeMonthlyBundle,
  OpenCodeUsageRecord,
} from "./opencode-response-mapping";

/** opencode.ai SolidStart server-function 的统一 RPC 端点。 */
export const OPENCODE_RPC_ENDPOINT = "https://opencode.ai/_server";

/** 月度聚合 server-function 的构建哈希（x-server-id 路由头）。 */
export const OPENCODE_RPC_ID_MONTHLY =
  "15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205";

/** 历史分页 server-function 的构建哈希（x-server-id 路由头）。 */
export const OPENCODE_RPC_ID_HISTORY =
  "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c";

const NEEDS_CONFIG_MESSAGE = "请在设置中填写 Workspace ID 和 Auth Cookie";
const PARSE_ERROR_MESSAGE = "opencode.ai 返回结构无法解析，可能已改版";

/**
 * 服务端强制要求 x-server-instance 头存在，缺失时直接返回 500 HTTPError；
 * 值任意非空即可（响应水合包装会原样回显该值），固定一个常量即可。
 */
const RPC_INSTANCE_HEADER = "server-fn:0";

type SerializedRpcArg = { t: number; s: string | number };

/** RPC 参数序列化：字符串 `{"t":1,"s":"..."}`、数字 `{"t":0,"s":N}`。 */
const serializeRpcArg = (arg: string | number): SerializedRpcArg =>
  typeof arg === "string" ? { t: 1, s: arg } : { t: 0, s: arg };

/** 构造 SolidStart server-function 的 RPC 请求信封（月度 l=4、历史 l=2 由参数个数决定）。 */
export const buildRpcEnvelope = (args: Array<string | number>): string =>
  JSON.stringify({
    t: { t: 9, i: 0, l: args.length, a: args.map(serializeRpcArg), o: 0 },
    f: 31,
    m: [],
  });

/** 将 UTC 偏移分钟数格式化为 ±HH:MM（如 480 → "+08:00"、-300 → "-05:00"）。 */
export const formatTimezoneOffset = (offsetMinutes: number): string => {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
};

const systemTimezoneOffset = (): string => formatTimezoneOffset(-new Date().getTimezoneOffset());

const loadWorkspaceId = async (instance: ProviderInstance): Promise<StatsResult<string>> => {
  const credentials = await invoke<InstanceCredentials>("vault_credentials", {
    instanceId: instance.id,
  });
  const workspaceId = credentials.workspaceId?.trim() ?? "";
  if (!workspaceId) return { status: "needs_config", message: NEEDS_CONFIG_MESSAGE };
  return { status: "ok", data: workspaceId };
};

const postRpc = async (instanceId: string, serverId: string, envelope: string): Promise<HttpResult> =>
  invoke<HttpResult>("provider_request", {
    instanceId,
    url: OPENCODE_RPC_ENDPOINT,
    method: "POST",
    auth: "cookie",
    headers: {
      "Content-Type": "application/json",
      "x-server-id": serverId,
      "x-server-instance": RPC_INSTANCE_HEADER,
    },
    bodyText: envelope,
  });

const WORKSPACE_MISMATCH_HINT = "请核对设置中的 Workspace ID 与 Auth Cookie 是否来自同一账号";

/**
 * 服务端应用层错误通过 x-error 响应头传递（HTTP 仍为 200）。
 * 值为 "true" 时无实际信息（真正的线索在响应体），跳过。
 */
const serverBusinessError = (http: HttpResult): string | null => {
  const detail = http.headers["x-error"];
  if (!detail || detail === "true") return null;
  if (detail.includes("not associated with a workspace")) {
    return `opencode.ai：${detail}。${WORKSPACE_MISMATCH_HINT}`;
  }
  if (detail.includes("Invalid time value")) {
    return "opencode.ai 服务端内部错误（时间处理异常），请稍后重试或切换到其他月份查看。";
  }
  return `opencode.ai 服务端错误：${detail}`;
};

/** 未登录/登录态失效时服务端返回指向 /auth/authorize 的重定向 Response 包装。 */
const authExpiredMessage = (bodyText: string): string | null =>
  bodyText.includes("/auth/authorize") ? "OpenCode 登录态已失效，请在设置中重新复制 Auth Cookie" : null;

const executeRpc = async <T>(
  instanceId: string,
  serverId: string,
  envelope: string,
  mapPayload: (payload: unknown) => T,
): Promise<StatsResult<T>> => {
  const http = await postRpc(instanceId, serverId, envelope);
  if (http.status !== 200) {
    return { status: "error", message: `opencode.ai 接口返回 HTTP ${http.status}` };
  }
  const authExpired = authExpiredMessage(http.bodyText);
  if (authExpired !== null) return { status: "error", message: authExpired };
  const businessError = serverBusinessError(http);
  if (businessError !== null) return { status: "error", message: businessError };
  try {
    return { status: "ok", data: mapPayload(parseRpcResponse(http.bodyText)) };
  } catch {
    // 解析器抛出的 Error 已带位置信息；对视图统一收敛为固定话术，避免暴露内部细节。
    return { status: "error", message: PARSE_ERROR_MESSAGE };
  }
};

/** 拉取指定年月的按日×模型成本聚合与 API Key 列表；month 为 1-based。 */
export const fetchOpenCodeMonthlyCost = async (
  instance: ProviderInstance,
  year: number,
  month: number,
): Promise<StatsResult<OpenCodeMonthlyBundle>> => {
  const workspace = await loadWorkspaceId(instance);
  if (workspace.status !== "ok") return workspace;
  const envelope = buildRpcEnvelope([workspace.data, year, month - 1, systemTimezoneOffset()]);
  return executeRpc(instance.id, OPENCODE_RPC_ID_MONTHLY, envelope, mapMonthlyBundle);
};

/** 拉取用量历史的一页记录；page 从 0 开始。 */
export const fetchOpenCodeHistoryPage = async (
  instance: ProviderInstance,
  page: number,
): Promise<StatsResult<{ records: OpenCodeUsageRecord[] }>> => {
  const workspace = await loadWorkspaceId(instance);
  if (workspace.status !== "ok") return workspace;
  const envelope = buildRpcEnvelope([workspace.data, page]);
  const result = await executeRpc(instance.id, OPENCODE_RPC_ID_HISTORY, envelope, mapHistoryRecords);
  if (result.status !== "ok") return result;
  return { status: "ok", data: { records: result.data } };
};
