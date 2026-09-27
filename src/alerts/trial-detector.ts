import { alertTitle } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot, StoredWorkbuddyTrial } from "../types/ipc";

export interface TrialArrival {
  instanceId: string;
  title: string;
  body: string;
  params: Record<string, string | number>;
}

export interface TrialDetectorDeps {
  notify: (arrival: TrialArrival) => void;
  onStateChange: (record: StoredWorkbuddyTrial) => void;
}

/**
 * WorkBuddy 试用加油包通知检测器（仅国际站，ADR-0037）：与签到检测器同构但判重键
 * 是实例本身——trial 是一次性事件，领取成功只可能发生一次，实例级一行即够。
 * 判定权威是 Rust 端 workbuddy_trials 行：落库快照随重启后的 reevaluate 重放时
 * （trial 字段还在），已通知过的实例直接跳过。不进告警冷却体系：一次性事件没有
 * 冷却参数。
 */
export class TrialDetector {
  /** instanceId → 是否已通知过领取（后端事实源的内存投影） */
  private claimed = new Map<string, boolean>();

  constructor(private deps: TrialDetectorDeps) {}

  /** 启动/重载后从后端事实源播种；失败的水合行静默跳过（最坏重报一次） */
  hydrate(rows: StoredWorkbuddyTrial[]): void {
    for (const row of rows) {
      this.claimed.set(row.instance_id, row.claimed);
    }
  }

  observe(instance: ProviderInstance, snapshot: ProviderSnapshot): void {
    if (instance.providerId !== "workbuddy") return;
    const trial = snapshot.trial;
    if (!trial) return;
    if (this.claimed.get(instance.id)) return;
    this.claimed.set(instance.id, true);
    const { title, params } = alertTitle(instance, snapshot, "试用加油包已领取");
    const credited = trial.credit > 0;
    this.deps.notify({
      instanceId: instance.id,
      title,
      body: credited ? "试用加油包已领取（+{credit} 积分）" : "试用加油包已领取",
      params: credited ? { ...params, credit: trial.credit } : params,
    });
    this.deps.onStateChange({ instance_id: instance.id, claimed: true });
  }

  /** 删除实例后清理其投影；后端事实源由 delete_instance 级联清理 */
  prune(instanceId: string): void {
    this.claimed.delete(instanceId);
  }
}
