import type { AlertFire } from "./evaluate";
import { evaluateRules } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot, StoredAlertState } from "../types/ipc";

interface RuleState {
  /** 当前是否处于告警态（用于边沿触发：只有从正常越过阈值才通知） */
  triggered: boolean;
  /** 上次通知时间，用于冷却 */
  lastNotifiedAt: number;
}

export interface AlertCoordinatorDeps {
  now?: () => number;
  /** 发出告警：系统通知 + 落通知历史 + 更新未读状态（判重由后端守卫兜底，ADR-0025） */
  notify: (fire: AlertFire) => void;
  /** 告警态变化（true=进入告警，false=解除） */
  onActiveChange: (instanceId: string, active: boolean) => void;
  /** 状态实际变化时回写后端事实源（ADR-0025）：边沿解除、本地判定的新触发 */
  onStateChange?: (states: StoredAlertState[]) => void;
  /** 评估时刻的文案翻译（ADR-0022）：撞满窗口名等动态片段按当前语言烘焙，其余保持模板 */
  translate?: (text: string) => string;
}

/** 默认冷却 6 小时；运行时由设置逐次传入覆盖 */
export const DEFAULT_COOLDOWN_MS = 6 * 3_600_000;

/**
 * 告警协调器：维护每条规则的边沿触发与冷却状态，状态键为规则键（`${instanceId}:${rule}`）。
 * 同一实例可有多条规则（如 GLM 的配额 quota 与余额 balance），边沿与冷却互相独立；
 * 实例级告警态 = 任一规则处于告警态。可注入 now/notify/onActiveChange 以便单元测试。
 * 内存态只是后端事实源（alert_states 表，ADR-0025）的投影：hydrate 播种、onStateChange 回写，
 * 评估窗口重载（F5）或应用重启后冷却与边沿原样恢复，不再重复通知。
 */
export class AlertCoordinator {
  private state = new Map<string, RuleState>();
  /** 实例上一次的告警态，仅在变化时回调 onActiveChange，避免每轮刷新重复广播 */
  private lastActive = new Map<string, boolean>();
  private deps: Required<Pick<AlertCoordinatorDeps, "now">> &
    Pick<AlertCoordinatorDeps, "notify" | "onActiveChange" | "onStateChange" | "translate">;

  constructor(deps: AlertCoordinatorDeps) {
    this.deps = {
      now: deps.now ?? Date.now,
      notify: deps.notify,
      onActiveChange: deps.onActiveChange,
      onStateChange: deps.onStateChange,
      translate: deps.translate,
    };
  }

  /** 删除实例后清理其全部规则的边沿/冷却状态（ADR-0022）：常驻 webview 反复增删实例不累积。
   *  后端事实源由 delete_instance 级联清理，这里只清投影 */
  prune(instanceId: string): void {
    const prefix = `${instanceId}:`;
    for (const key of this.state.keys()) {
      if (key.startsWith(prefix)) this.state.delete(key);
    }
    this.lastActive.delete(instanceId);
  }

  /**
   * 水合（ADR-0025）：用后端持久化状态播种内存投影。只播种本会话尚不存在的键——
   * 会话内已写过的键比库里的快照新；同时按播种结果重建实例告警态（active 表），
   * 重载后托盘/横幅立即恢复，不等下一轮成功刷新。
   */
  hydrate(states: StoredAlertState[]): void {
    const touchedInstances = new Set<string>();
    for (const state of states) {
      if (this.state.has(state.rule_key)) continue;
      this.state.set(state.rule_key, {
        triggered: state.triggered,
        lastNotifiedAt: state.last_notified_at,
      });
      touchedInstances.add(state.instance_id);
    }
    for (const instanceId of touchedInstances) {
      const anyActive = this.anyRuleTriggered(instanceId);
      const previous = this.lastActive.get(instanceId) ?? false;
      if (previous !== anyActive) {
        this.lastActive.set(instanceId, anyActive);
        this.deps.onActiveChange?.(instanceId, anyActive);
      }
    }
  }

  private anyRuleTriggered(instanceId: string): boolean {
    const prefix = `${instanceId}:`;
    for (const [key, state] of this.state) {
      if (key.startsWith(prefix) && state.triggered) return true;
    }
    return false;
  }

  /** 每次刷新落快照后调用。cooldownMs 由设置逐次传入（ADR-0025），默认 6 小时 */
  observe(
    instance: ProviderInstance,
    snapshot: ProviderSnapshot,
    alertsEnabled: boolean,
    cooldownMs: number = DEFAULT_COOLDOWN_MS,
  ): void {
    // 冻结语义（ADR-0023）：错误快照是「未知」而非「正常」——既不触发也不解除，
    // 边沿状态不被网络抖动重置，恢复后不会因重新越阈而重复通知；
    // 总开关关闭（alertsEnabled=false）是明确的「关」，照常走解除路径
    if (snapshot.status !== "ok") return;
    const now = this.deps.now();
    const fires = alertsEnabled
      ? evaluateRules(instance, snapshot, this.deps.translate ?? ((text) => text))
      : [];
    const firedByKey = new Map(fires.map((fire) => [fire.ruleKey, fire]));

    // 本实例关心的规则键 = 已有状态中属于本实例的 + 本次触发的
    const instancePrefix = `${instance.id}:`;
    const keys = new Set<string>();
    for (const key of this.state.keys()) {
      if (key.startsWith(instancePrefix)) keys.add(key);
    }
    for (const key of firedByKey.keys()) keys.add(key);

    // lastNotifiedAt 用 -Infinity 表示"从未通知过"，保证首次触发必定通知
    let anyActive = false;
    const changed: StoredAlertState[] = [];
    for (const key of keys) {
      const existing = this.state.get(key);
      // 注意：existing 是 Map 内的同一对象，下面的变异是原地的——prev 必须先行快照
      const state = existing ?? { triggered: false, lastNotifiedAt: Number.NEGATIVE_INFINITY };
      const prevTriggered = state.triggered;
      const prevLastNotifiedAt = state.lastNotifiedAt;
      const fire = firedByKey.get(key);
      if (fire) {
        const cooledDown = now - state.lastNotifiedAt >= cooldownMs;
        if (!state.triggered && cooledDown) {
          this.deps.notify(fire);
          state.lastNotifiedAt = now;
        }
        state.triggered = true;
        anyActive = true;
      } else {
        // 未触发（含总开关关闭）：只解除边沿态，冷却时间戳保留
        state.triggered = false;
      }
      if (!existing || prevTriggered !== state.triggered || prevLastNotifiedAt !== state.lastNotifiedAt) {
        // -Infinity 只存在于「从未通知」的内存初始态，不可落库；回写前定格为 0
        changed.push({
          rule_key: key,
          instance_id: instance.id,
          triggered: state.triggered,
          last_notified_at: Number.isFinite(state.lastNotifiedAt) ? state.lastNotifiedAt : 0,
        });
      }
      this.state.set(key, state);
    }
    if (changed.length > 0) {
      this.deps.onStateChange?.(changed);
    }

    const previous = this.lastActive.get(instance.id) ?? false;
    if (previous !== anyActive) {
      this.lastActive.set(instance.id, anyActive);
      this.deps.onActiveChange(instance.id, anyActive);
    }
  }
}
