import { extractBalanceValue, extractMetric } from "./metric";
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

function usable(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * 纯函数：根据快照指标与实例阈值判断应触发的全部告警（同一实例可命中多条规则）。
 * 不含边沿触发与冷却状态（那是 AlertCoordinator 的职责）。
 * 快照非 ok、解析不出指标或实例未设阈值时对应规则不产生 fire（视为正常，用于解除告警态）。
 * 阈值语义按种类固定：DeepSeek=余额低于该值（元，规则 balance）；
 * OpenCode=已用达到该百分比（规则 monthly）；
 * GLM=配额已用达到百分比（规则 quota）+ 余额低于阈值（规则 balance，独立阈值 balanceThreshold）。
 */
export function evaluateRules(
  instance: ProviderInstance,
  snapshot: ProviderSnapshot,
): AlertFire[] {
  if (snapshot.status !== "ok") return [];
  const fires: AlertFire[] = [];
  const metric = extractMetric(snapshot);
  const threshold = instance.threshold;
  const thresholdActive = usable(threshold) && metric != null;

  if (instance.providerId === "deepseek") {
    if (thresholdActive && metric!.value < threshold!) {
      fires.push({
        ruleKey: `${instance.id}:balance`,
        instanceId: instance.id,
        title: alertTitle(instance, snapshot, "余额告警"),
        body: `当前余额 ${metric!.value.toFixed(2)} 元，已低于 ${threshold} 元，请及时充值。`,
      });
    }
    return fires;
  }

  if (instance.providerId === "opencode-go") {
    if (thresholdActive && metric!.value >= threshold!) {
      fires.push({
        ruleKey: `${instance.id}:monthly`,
        instanceId: instance.id,
        title: alertTitle(instance, snapshot, "额度告警"),
        body: `本月额度已用 ${metric!.value.toFixed(1)}%，达到 ${threshold}%，注意分配剩余用量。`,
      });
    }
    return fires;
  }

  if (instance.providerId === "glm") {
    if (thresholdActive && metric!.value >= threshold!) {
      fires.push({
        ruleKey: `${instance.id}:quota`,
        instanceId: instance.id,
        title: alertTitle(instance, snapshot, "配额告警"),
        body: `Coding Plan 配额已用 ${metric!.value.toFixed(1)}%，达到 ${threshold}%，注意分配剩余用量。`,
      });
    }
    const balanceThreshold = instance.balanceThreshold;
    const balance = extractBalanceValue(snapshot);
    if (usable(balanceThreshold) && usable(balance) && balance < balanceThreshold) {
      fires.push({
        ruleKey: `${instance.id}:balance`,
        instanceId: instance.id,
        title: alertTitle(instance, snapshot, "余额告警"),
        body: `当前余额 ${balance.toFixed(2)} 元，已低于 ${balanceThreshold} 元，请及时充值。`,
      });
    }
  }
  return fires;
}
