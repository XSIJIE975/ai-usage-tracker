import { extractBalanceValue, extractMetric } from "./metric";
import { applyParams } from "../i18n/apply-params";
import type { MetricLine, ProviderInstance, ProviderSnapshot } from "../types/ipc";

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
 * OpenCode=已用达到该百分比（规则 monthly，主指标=重置最远窗）；
 * GLM=配额已用达到百分比（规则 quota，主指标=周窗）+ 余额低于阈值（规则 balance，独立阈值 balanceThreshold）。
 * 与阈值无关的公共规则：任一配额窗口已用 ≥100%（规则 exhausted，ADR-0021）——撞满即不可用，
 * 是阈值规则只盯预算窗（防短周期窗日常冲高噪音）留下的盲区的终值补丁。
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
  } else if (instance.providerId === "opencode-go") {
    if (thresholdActive && metric!.value >= threshold!) {
      fires.push({
        ruleKey: `${instance.id}:monthly`,
        instanceId: instance.id,
        title: alertTitle(instance, snapshot, "额度告警"),
        body: `本月额度已用 ${metric!.value.toFixed(1)}%，达到 ${threshold}%，注意分配剩余用量。`,
      });
    }
  } else if (instance.providerId === "glm") {
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

  // 耗尽规则（ADR-0021）：任一配额窗口达到 100% 即告警，与阈值无关——撞满意味着该窗在重置前
  // 不可用；阈值规则只盯主指标（重置周期最长窗，防 5h 窗日常冲高噪音），这里是它的盲区补丁。
  const exhausted = snapshot.lines.filter(
    (line): line is MetricLine & { percentUsed: number } =>
      line.type === "progress" && typeof line.percentUsed === "number" && line.percentUsed >= 100,
  );
  if (exhausted.length > 0) {
    const names = exhausted.map((line) => `「${applyParams(line.label, line.params)}」`).join("");
    fires.push({
      ruleKey: `${instance.id}:exhausted`,
      instanceId: instance.id,
      title: alertTitle(instance, snapshot, "额度耗尽"),
      body: `${names}已用尽（100%），等待重置恢复。`,
    });
  }
  return fires;
}
