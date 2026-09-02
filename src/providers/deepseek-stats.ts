import { invoke } from "@tauri-apps/api/core";
import type { HttpResult, InstanceCredentialStatus, ProviderInstance } from "../types/ipc";
import type { StatsResult } from "./stats-result";
import { mergeDeepSeekUsage, platformErrorMessage } from "./deepseek-stats-merge";
import type {
  DeepSeekAmountResponse,
  DeepSeekCostResponse,
  DeepSeekDailyRow,
  DeepSeekKeyInfo,
  DeepSeekUsageBundle,
  UsageQuery,
} from "./deepseek-stats-merge";

export type { DeepSeekUsageBundle, DeepSeekKeyInfo, DeepSeekDailyRow };

const PLATFORM_BASE_URL = "https://platform.deepseek.com/api/v0";

export const buildUsageQuery = (startMs: number, endMs: number, now: Date = new Date()): UsageQuery => ({
  start: Math.floor(startMs / 1000),
  end: Math.floor(endMs / 1000),
  tz: (0 - now.getTimezoneOffset()) * 60,
});

const requestPlatformText = (instanceId: string, url: string): Promise<HttpResult> =>
  invoke<HttpResult>("provider_request", {
    instanceId,
    url,
    method: "GET",
    auth: "bearer",
    credentialSlot: "userToken",
    headers: { Accept: "application/json" },
  });

const platformUrl = (path: string, query: UsageQuery): string =>
  `${PLATFORM_BASE_URL}${path}?start=${query.start}&end=${query.end}&tz=${query.tz}`;

const isUserTokenConfigured = (status: InstanceCredentialStatus): boolean =>
  status.userToken === true;

const parseJson = <T>(text: string): T => JSON.parse(text) as T;

const statsError = (message: string): StatsResult<DeepSeekUsageBundle> => ({
  status: "error",
  message,
});

export const fetchDeepSeekUsage = async (
  instance: ProviderInstance,
  startMs: number,
  endMs: number,
): Promise<StatsResult<DeepSeekUsageBundle>> => {
  try {
    const credentialStatus = await invoke<InstanceCredentialStatus>(
      "vault_credential_status",
      { instanceId: instance.id },
    );
    if (!isUserTokenConfigured(credentialStatus)) {
      return { status: "needs_config", message: "请在设置中填写 DeepSeek UserToken" };
    }

    const query = buildUsageQuery(startMs, endMs);
    const [amountHttp, costHttp] = await Promise.all([
      requestPlatformText(instance.id, platformUrl("/usage/by_api_key/amount", query)),
      requestPlatformText(instance.id, platformUrl("/usage/by_api_key/cost", query)),
    ]);
    if (amountHttp.status !== 200) {
      return statsError(`DeepSeek 平台接口返回 HTTP ${amountHttp.status}`);
    }
    if (costHttp.status !== 200) {
      return statsError(`DeepSeek 平台接口返回 HTTP ${costHttp.status}`);
    }

    const amount = parseJson<DeepSeekAmountResponse>(amountHttp.bodyText);
    const cost = parseJson<DeepSeekCostResponse>(costHttp.bodyText);
    const amountError = platformErrorMessage(amount);
    if (amountError !== null) return statsError(amountError);
    const costError = platformErrorMessage(cost);
    if (costError !== null) return statsError(costError);

    return { status: "ok", data: mergeDeepSeekUsage(amount, cost) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: "error", message: "DeepSeek 响应无法解析" };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "error", message: `DeepSeek 用量查询失败：${detail}` };
  }
};
