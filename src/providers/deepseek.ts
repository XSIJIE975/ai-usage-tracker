import { invoke } from "@tauri-apps/api/core";
import type {
  HttpResult,
  InstanceCredentialStatus,
  ProviderInstance,
  ProviderSnapshot,
} from "../types/ipc";
import type { ProviderModule } from "./types";

interface DeepSeekBalanceResponse {
  is_available?: boolean;
  balance_infos?: Array<{
    currency?: string;
    total_balance?: string | number;
    granted_balance?: string | number;
    topped_up_balance?: string | number;
  }>;
}

async function fetchBalance(instance: ProviderInstance): Promise<ProviderSnapshot> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  const updatedAt = Date.now();
  if (!status.apiKey) {
    return {
      instanceId: instance.id,
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "needs_config",
      updatedAt,
      message: "请在设置中填写 DeepSeek API Key",
      lines: [],
    };
  }

  const result = await invoke<HttpResult>("provider_request", {
    instanceId: instance.id,
    url: "https://api.deepseek.com/user/balance",
    method: "GET",
    auth: "bearer",
    headers: { Accept: "application/json" },
  });

  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return {
      instanceId: instance.id,
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "error",
      updatedAt,
      message: "DeepSeek 余额接口返回 HTTP {status}{detail}",
      messageParams: { status: result.status, detail: detail ? `：${detail.length > 300 ? `${detail.slice(0, 300)}...` : detail}` : "" },
      lines: [],
    };
  }

  try {
    const data = JSON.parse(result.bodyText) as DeepSeekBalanceResponse;
    const infos = data.balance_infos ?? [];
    if (infos.length === 0) {
      return {
        instanceId: instance.id,
        providerId: "deepseek",
        providerName: "DeepSeek",
        status: data.is_available === false ? "error" : "ok",
        updatedAt,
        message: data.is_available === false ? "DeepSeek 余额不足或不可用" : "DeepSeek 暂无余额信息",
        lines: [],
      };
    }

    const currency = infos[0].currency ?? "CNY";
    const total = Number(infos[0].total_balance ?? 0);
    const formatter = new Intl.NumberFormat("zh-CN", { style: "currency", currency });
    const lines = [
      {
        type: "badge" as const,
        label: "可用状态",
        value: data.is_available === false ? "不可用" : "可用",
        color: data.is_available === false ? "#dc2626" : "#16a34a",
      },
      {
        type: "text" as const,
        label: "账户余额",
        value: formatter.format(total),
      },
    ];

    const toppedUp = Number(infos[0].topped_up_balance ?? 0);
    const granted = Number(infos[0].granted_balance ?? 0);
    if (toppedUp > 0) {
      lines.push({ type: "text" as const, label: "充值余额", value: formatter.format(toppedUp) });
    }
    if (granted > 0) {
      lines.push({ type: "text" as const, label: "赠送余额", value: formatter.format(granted) });
    }

    return {
      instanceId: instance.id,
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "ok",
      updatedAt,
      lines,
    };
  } catch (error) {
    return {
      instanceId: instance.id,
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "error",
      updatedAt,
      message: "DeepSeek 返回数据解析失败：{detail}",
      messageParams: { detail: error instanceof Error ? error.message : String(error) },
      lines: [],
    };
  }
}

export const deepseekProvider: ProviderModule = {
  id: "deepseek",
  name: "DeepSeek",
  description: "查询 DeepSeek 官方 API 余额和可用状态",
  fetch: fetchBalance,
};
