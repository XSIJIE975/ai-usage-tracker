import type { AlertFire } from "./evaluate";
import { evaluateRules } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";

interface RuleState {
  /** 当前是否处于告警态（用于边沿触发：只有从正常越过阈值才通知） */
  triggered: boolean;
  /** 上次通知时间，用于冷却 */
  lastNotifiedAt: number;
}

export interface AlertCoordinatorDeps {
  now?: () => number;
  /** 触发冷却，默认 6 小时 */
  cooldownMs?: number;
  /** 发出告警：系统通知 + 落通知历史 + 更新未读状态 */
  notify: (fire: AlertFire) => void;
  /** 告警态变化（true=进入告警，false=解除） */
  onActiveChange: (instanceId: string, active: boolean) => void;
}

/**
 * 告警协调器：维护每条规则的边沿触发与冷却状态，状态键为规则键（`${instanceId}:${rule}`）。
 * 同一实例可有多条规则（如 GLM 的配额 quota 与余额 balance），边沿与冷却互相独立；
 * 实例级告警态 = 任一规则处于告警态。可注入 now/notify/onActiveChange 以便单元测试。
 */
export class AlertCoordinator {
  private state = new Map<string, RuleState>();
  /** 实例上一次的告警态，仅在变化时回调 onActiveChange，避免每轮刷新重复广播 */
  private lastActive = new Map<string, boolean>();
  private deps: Required<Pick<AlertCoordinatorDeps, "now" | "cooldownMs">> &
    Pick<AlertCoordinatorDeps, "notify" | "onActiveChange">;

  constructor(deps: AlertCoordinatorDeps) {
    this.deps = {
      now: deps.now ?? Date.now,
      cooldownMs: deps.cooldownMs ?? 6 * 3_600_000,
      notify: deps.notify,
      onActiveChange: deps.onActiveChange,
    };
  }

  /** 每次刷新落快照后调用 */
  observe(instance: ProviderInstance, snapshot: ProviderSnapshot, alertsEnabled: boolean): void {
    const now = this.deps.now();
    const fires = alertsEnabled ? evaluateRules(instance, snapshot) : [];
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
    for (const key of keys) {
      const state = this.state.get(key) ?? {
        triggered: false,
        lastNotifiedAt: Number.NEGATIVE_INFINITY,
      };
      const fire = firedByKey.get(key);
      if (fire) {
        const cooledDown = now - state.lastNotifiedAt >= this.deps.cooldownMs;
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
      this.state.set(key, state);
    }

    const previous = this.lastActive.get(instance.id) ?? false;
    if (previous !== anyActive) {
      this.lastActive.set(instance.id, anyActive);
      this.deps.onActiveChange(instance.id, anyActive);
    }
  }
}
