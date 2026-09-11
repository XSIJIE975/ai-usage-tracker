import { extractBalanceValue, extractMetric } from "./metric";
import { applyParams } from "../i18n/apply-params";
import type { MetricLine, ProviderInstance, ProviderSnapshot } from "../types/ipc";

export interface AlertFire {
  /** 规则键：`${instanceId}:${rule}`，同一实例同名规则的边沿状态互相独立 */
  ruleKey: string;
  instanceId: string;
  /** 中文模板（含 {占位符}），落库与渲染层据此翻译（ADR-0022） */
  title: string;
  body: string;
  /** 模板参数：字符串值本身可能是字典键（如规则名「余额告警」），渲染层经 renderTemplate
   *  先 t() 再替换；数值已在评估时定格（快照是采样点，事后无法重算） */
  params: Record<string, string | number>;
}

/** 备注存在时标题带上备注，同名种类的两个实例告警才能分得清。
 *  返回模板与参数：{rule} 是字典键（渲染层翻译），{provider} 是专名（无字典键原样保留） */
function alertTitle(
  instance: ProviderInstance,
  snapshot: ProviderSnapshot,
  ruleName: string,
): { title: string; params: Record<string, string | number> } {
  const note = instance.note.trim();
  const base = { provider: snapshot.providerName, rule: ruleName };
  return note
    ? { title: "{note}（{provider}）{rule}", params: { ...base, note } }
    : { title: "{provider} {rule}", params: base };
}

function usable(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * 纯函数：根据快照指标与实例阈值判断应触发的全部告警（同一实例可命中多条规则）。
 * 不含边沿触发与冷却状态（那是 AlertCoordinator 的职责）。
 * 快照非 ok 时不产生 fire——错误快照由协调器**冻结**告警态（ADR-0023：未知 ≠ 正常，
 * 不触发也不解除），不再是旧契约的「视为正常用于解除」。
 * 阈值语义按种类固定：DeepSeek=余额低于该值（元，规则 balance）；
 * OpenCode=已用达到该百分比（规则 monthly，主指标=重置最远窗）；
 * GLM=配额已用达到百分比（规则 quota，主指标=周窗）+ 余额低于阈值（规则 balance，独立阈值 balanceThreshold）。
 * 与阈值无关的公共规则：任一配额窗口已用 ≥100%（规则 exhausted，ADR-0021）——撞满即不可用，
 * 是阈值规则只盯预算窗（防短周期窗日常冲高噪音）留下的盲区的终值补丁。
 * translate（ADR-0022）：窗口名是含数值的动态模板（「{hours} 小时请求配额」），整串没法当字典键，
 * 撞满窗名列表在评估时刻按当前语言烘焙进 names 参数；其余文案一律保持模板，渲染层再翻译。
 */
export function evaluateRules(
  instance: ProviderInstance,
  snapshot: ProviderSnapshot,
  translate: (text: string) => string = (text) => text,
): AlertFire[] {
  if (snapshot.status !== "ok") return [];
  const fires: AlertFire[] = [];
  const metric = extractMetric(snapshot);
  const threshold = instance.threshold;
  const thresholdActive = usable(threshold) && metric != null;

  if (instance.providerId === "deepseek") {
    if (thresholdActive && metric!.value < threshold!) {
      const title = alertTitle(instance, snapshot, "余额告警");
      fires.push({
        ruleKey: `${instance.id}:balance`,
        instanceId: instance.id,
        title: title.title,
        body: "当前余额 {balance} 元，已低于 {threshold} 元，请及时充值。",
        params: { ...title.params, balance: metric!.value.toFixed(2), threshold: threshold! },
      });
    }
  } else if (instance.providerId === "opencode-go") {
    if (thresholdActive && metric!.value >= threshold!) {
      const title = alertTitle(instance, snapshot, "额度告警");
      fires.push({
        ruleKey: `${instance.id}:monthly`,
        instanceId: instance.id,
        title: title.title,
        body: "本月额度已用 {percent}%，达到 {threshold}%，注意分配剩余用量。",
        params: { ...title.params, percent: metric!.value.toFixed(1), threshold: threshold! },
      });
    }
  } else if (instance.providerId === "glm") {
    if (thresholdActive && metric!.value >= threshold!) {
      const title = alertTitle(instance, snapshot, "配额告警");
      fires.push({
        ruleKey: `${instance.id}:quota`,
        instanceId: instance.id,
        title: title.title,
        body: "Coding Plan 配额已用 {percent}%，达到 {threshold}%，注意分配剩余用量。",
        params: { ...title.params, percent: metric!.value.toFixed(1), threshold: threshold! },
      });
    }
    const balanceThreshold = instance.balanceThreshold;
    const balance = extractBalanceValue(snapshot);
    if (usable(balanceThreshold) && usable(balance) && balance < balanceThreshold) {
      const title = alertTitle(instance, snapshot, "余额告警");
      fires.push({
        ruleKey: `${instance.id}:balance`,
        instanceId: instance.id,
        title: title.title,
        body: "当前余额 {balance} 元，已低于 {threshold} 元，请及时充值。",
        params: { ...title.params, balance: balance.toFixed(2), threshold: balanceThreshold },
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
    const names = exhausted
      .map((line) => `「${applyParams(translate(line.label), line.params)}」`)
      .join("");
    const title = alertTitle(instance, snapshot, "额度耗尽");
    fires.push({
      ruleKey: `${instance.id}:exhausted`,
      instanceId: instance.id,
      title: title.title,
      body: "{names}已用尽（100%），等待重置恢复。",
      params: { ...title.params, names },
    });
  }
  return fires;
}
