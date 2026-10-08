import { alertTitle } from "./evaluate";
import { wbStateKind, type WorkbuddyStateRecord } from "../lib/workbuddy-states";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";

export interface CheckinArrival {
  instanceId: string;
  title: string;
  body: string;
  params: Record<string, string | number>;
}

export interface CheckinDetectorDeps {
  notify: (arrival: CheckinArrival) => void;
  onStateChange: (record: WorkbuddyStateRecord) => void;
}

/**
 * WorkBuddy 签到通知检测器：快照携带本轮实际发生的签到（瞬时字段），这里把「每天
 * 每实例只通知一次」补齐。判定权威是 workbuddy_states 的 checkin_notified 格
 * （ADR-0029 通知判重、ADR-0039 收表）——落库快照会随重启后的 reevaluate 重放
 * （checkin 字段还在），只靠内存态必然重报；水合后同一天的重放直接跳过。
 * 与「今日已签到」的动作判据（checkin_acted 格）分两格：成功才通知，但成功与
 * 「上游说已签」都意味着今天不必再发请求。与重置卡到账检测器同构，但不进告警冷却体系：
 * 签到是每日一次的事件，天然没有冷却参数。
 */
export class CheckinDetector {
  /** instanceId → 最近一次发出通知的签到日期（后端事实源的内存投影） */
  private notified = new Map<string, string>();

  constructor(private deps: CheckinDetectorDeps) {}

  /** 启动/重载后从后端事实源播种；失败的水合行静默跳过（最坏重报一次） */
  hydrate(rows: WorkbuddyStateRecord[]): void {
    for (const row of rows) {
      this.notified.set(row.instance_id, row.value);
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
    this.deps.onStateChange({
      instance_id: instance.id,
      kind: wbStateKind.checkinNotified,
      value: checkin.date,
    });
  }

  /** 删除实例后清理其投影；后端事实源由 delete_instance 级联清理 */
  prune(instanceId: string): void {
    this.notified.delete(instanceId);
  }
}
