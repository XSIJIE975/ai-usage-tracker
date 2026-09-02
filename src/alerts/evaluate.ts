import { extractMetric } from "../stats/snapshot-history";
import type { AlertThresholds, ProviderSnapshot } from "../types/ipc";

export interface AlertFire {
  ruleKey: string;
  providerId: string;
  title: string;
  body: string;
}

/**
 * 纯函数：根据快照主指标与阈值判断是否应触发告警。
 * 不含边沿触发与冷却状态（那是 AlertCoordinator 的职责）。
 * 快照非 ok 或解析不出主指标时返回 null（视为正常，用于解除告警态）。
 */
export function evaluateRule(
  providerId: string,
  snapshot: ProviderSnapshot,
  thresholds: AlertThresholds,
): AlertFire | null {
  if (snapshot.status !== "ok") return null;
  const metric = extractMetric(snapshot);
  if (!metric) return null;

  if (providerId === "deepseek") {
    const threshold = thresholds.deepseekBalanceBelowCny;
    if (Number.isFinite(threshold) && metric.value < threshold) {
      return {
        ruleKey: "deepseek:balance",
        providerId,
        title: "DeepSeek 余额告警",
        body: `当前余额 ${metric.value.toFixed(2)} 元，已低于 ${threshold} 元，请及时充值。`,
      };
    }
    return null;
  }

  if (providerId === "opencode-go") {
    const threshold = thresholds.opencodeMonthlyUsedPercent;
    if (Number.isFinite(threshold) && metric.value >= threshold) {
      return {
        ruleKey: "opencode-go:monthly",
        providerId,
        title: "OpenCode Go 额度告警",
        body: `本月额度已用 ${metric.value.toFixed(1)}%，达到 ${threshold}%，注意分配剩余用量。`,
      };
    }
  }

  if (providerId === "glm") {
    const threshold = thresholds.glmQuotaUsedPercent;
    if (Number.isFinite(threshold) && metric.value >= threshold) {
      return {
        ruleKey: "glm:quota",
        providerId,
        title: "智谱配额告警",
        body: `Coding Plan 配额已用 ${metric.value.toFixed(1)}%，达到 ${threshold}%，注意分配剩余用量。`,
      };
    }
  }
  return null;
}
