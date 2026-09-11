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

/** 金额字段解析为有限数；缺失/非数值返回 null——不折算为 0（会把余额显示成 ¥0.00
 *  并误报余额告警），不透传 NaN（Intl.format 会渲染出 "NaN"） */
function toAmount(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
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
    const total = toAmount(infos[0].total_balance);
    if (total === null) {
      // 余额是 DeepSeek 的唯一指标：解析不出就如实报错误快照（ADR-0023 语义），
      // 绝不能折算成 0 触发虚假的余额告警
      return {
        instanceId: instance.id,
        providerId: "deepseek",
        providerName: "DeepSeek",
        status: "error",
        updatedAt,
        message: "DeepSeek 余额字段无法解析：{detail}",
        messageParams: { detail: String(infos[0].total_balance ?? "字段缺失") },
        lines: [],
      };
    }
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

    // 充值/赠送余额缺字段时跳过该行（不显示 ¥0.00）
    const toppedUp = toAmount(infos[0].topped_up_balance);
    const granted = toAmount(infos[0].granted_balance);
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
