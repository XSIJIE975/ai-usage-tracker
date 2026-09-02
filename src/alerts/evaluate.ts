import { extractMetric } from "../stats/snapshot-history";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";

export interface AlertFire {
  /** 规则键：`${instanceId}:${rule}`，同一实例同名规则的边沿状态互相独立 */
  ruleKey: string;
  instanceId: string;
  title: string;
  body: string;
}

/** 备注存在时标题带上备注，同名种类的两个实例告警才能分得清 */
function alertTitle(instance: ProviderInstance, snapshot: ProviderSnapshot, ruleName: string): string {
  const note = instance.note.trim();
  return note ? `${note}（${snapshot.providerName}）${ruleName}` : `${snapshot.providerName} ${ruleName}`;
}

/**
 * 纯函数：根据快照主指标与实例阈值判断是否应触发告警。
 * 不含边沿触发与冷却状态（那是 AlertCoordinator 的职责）。
 * 快照非 ok、解析不出主指标或实例未设阈值时返回 null（视为正常，用于解除告警态）。
 * 阈值语义按种类固定：DeepSeek=余额低于该值（元），其余=已用达到该百分比。
 */
export function evaluateRule(
  instance: ProviderInstance,
  snapshot: ProviderSnapshot,
): AlertFire | null {
  if (snapshot.status !== "ok") return null;
  const metric = extractMetric(snapshot);
  if (!metric) return null;
  const threshold = instance.threshold;
  if (threshold == null || !Number.isFinite(threshold)) return null;

  if (instance.providerId === "deepseek") {
    if (metric.value < threshold) {
      return {
        ruleKey: `${instance.id}:balance`,
        instanceId: instance.id,
        title: alertTitle(instance, snapshot, "余额告警"),
        body: `当前余额 ${metric.value.toFixed(2)} 元，已低于 ${threshold} 元，请及时充值。`,
      };
    }
    return null;
  }

  if (instance.providerId === "opencode-go") {
    if (metric.value >= threshold) {
      return {
        ruleKey: `${instance.id}:monthly`,
        instanceId: instance.id,
        title: alertTitle(instance, snapshot, "额度告警"),
        body: `本月额度已用 ${metric.value.toFixed(1)}%，达到 ${threshold}%，注意分配剩余用量。`,
      };
    }
  }

  if (instance.providerId === "glm") {
    if (metric.value >= threshold) {
      return {
        ruleKey: `${instance.id}:quota`,
        instanceId: instance.id,
        title: alertTitle(instance, snapshot, "配额告警"),
        body: `Coding Plan 配额已用 ${metric.value.toFixed(1)}%，达到 ${threshold}%，注意分配剩余用量。`,
      };
    }
  }
  return null;
}
