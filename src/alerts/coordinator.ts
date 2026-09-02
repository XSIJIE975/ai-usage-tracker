import type { AlertFire } from "./evaluate";
import { evaluateRule } from "./evaluate";
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
 * 告警协调器：维护每个实例规则的边沿触发与冷却状态。
 * 可注入 now/notify/onActiveChange 以便单元测试。
 */
export class AlertCoordinator {
  private state = new Map<string, RuleState>();
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

  /** 每次刷新落快照后调用；每种类的规则每实例至多一条，状态键即实例 id */
  observe(instance: ProviderInstance, snapshot: ProviderSnapshot, alertsEnabled: boolean): void {
    const key = instance.id;
    // lastNotifiedAt 用 -Infinity 表示"从未通知过"，保证首次触发必定通知
    const state = this.state.get(key) ?? { triggered: false, lastNotifiedAt: Number.NEGATIVE_INFINITY };
    const now = this.deps.now();

    if (!alertsEnabled) {
      if (state.triggered) {
        state.triggered = false;
        this.state.set(key, state);
        this.deps.onActiveChange(instance.id, false);
      }
      return;
    }

    const fire = evaluateRule(instance, snapshot);
    if (fire) {
      const cooledDown = now - state.lastNotifiedAt >= this.deps.cooldownMs;
      if (!state.triggered && cooledDown) {
        this.deps.notify(fire);
        state.lastNotifiedAt = now;
      }
      if (!state.triggered) {
        state.triggered = true;
        this.state.set(key, state);
        this.deps.onActiveChange(instance.id, true);
      }
      return;
    }

    if (state.triggered) {
      state.triggered = false;
      this.state.set(key, state);
      this.deps.onActiveChange(instance.id, false);
    }
  }
}
