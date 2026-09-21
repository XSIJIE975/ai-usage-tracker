import { alertTitle } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot, StoredWorkbuddyCheckin } from "../types/ipc";

export interface CheckinArrival {
  instanceId: string;
  title: string;
  body: string;
  params: Record<string, string | number>;
}

export interface CheckinDetectorDeps {
  notify: (arrival: CheckinArrival) => void;
  onStateChange: (record: StoredWorkbuddyCheckin) => void;
}

/**
 * WorkBuddy 签到通知检测器：快照携带本轮实际发生的签到（瞬时字段），这里把「每天
 * 每实例只通知一次」补齐。判定权威是 Rust 端 workbuddy_checkins 行（ADR-0029）——
 * 落库快照会随重启后的 reevaluate 重放（checkin 字段还在），只靠内存态必然重报；
 * 水合后同一天的重放直接跳过。与重置卡到账检测器同构，但不进告警冷却体系：
 * 签到是每日一次的事件，天然没有冷却参数。
 */
export class CheckinDetector {
  /** instanceId → 最近一次发出通知的签到日期（后端事实源的内存投影） */
  private notified = new Map<string, string>();

  constructor(private deps: CheckinDetectorDeps) {}

  /** 启动/重载后从后端事实源播种；失败的水合行静默跳过（最坏重报一次） */
  hydrate(rows: StoredWorkbuddyCheckin[]): void {
    for (const row of rows) {
      this.notified.set(row.instance_id, row.notified_date);
    }
  }

  observe(instance: ProviderInstance, snapshot: ProviderSnapshot): void {
    const checkin = snapshot.checkin;
    if (!checkin) return;
    if (this.notified.get(instance.id) === checkin.date) return;
    this.notified.set(instance.id, checkin.date);
    const { title, params } = alertTitle(instance, snapshot, "签到成功");
    this.deps.notify({
      instanceId: instance.id,
      title,
      body: "积分 +{credit} 已到账",
      params: { ...params, credit: checkin.credited },
    });
    this.deps.onStateChange({ instance_id: instance.id, notified_date: checkin.date });
  }

  /** 删除实例后清理其投影；后端事实源由 delete_instance 级联清理 */
  prune(instanceId: string): void {
    this.notified.delete(instanceId);
  }
}
