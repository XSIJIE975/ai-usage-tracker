import { alertTitle } from "./evaluate";
import { wbStateKind, type WorkbuddyStateRecord } from "../lib/workbuddy-states";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";

export interface TravelArrival {
  instanceId: string;
  title: string;
  body: string;
  params: Record<string, string | number>;
}

export interface TravelDetectorDeps {
  notify: (arrival: TravelArrival) => void;
  onStateChange: (record: WorkbuddyStateRecord) => void;
}

/**
 * WorkBuddy 喵喵旅行领奖通知检测器：与签到检测器同构，但判重键是行程标识
 * （depart_at）而非日期——一天可有多趟旅行，各趟各判各的。判定权威是 workbuddy_states
 * 的 travel_notified 格（ADR-0029 通知判重、ADR-0039 收表）：落库快照会随重启后的
 * reevaluate 重放（travel 字段还在），只靠内存态必然重报；水合后同行程的重放直接跳过。
 * 与「这趟已尝试过领奖」的动作判据（travel_tried 格）分两格——领到才通知，
 * 但「上游说无可领取」也算这一趟处理过了。与重置卡/签到检测器同样不进告警冷却体系：
 * 领奖是按趟发生的事件，没有冷却参数。
 */
export class TravelDetector {
  /** instanceId → 最近一次发出通知的行程键（后端事实源的内存投影） */
  private claimed = new Map<string, string>();

  constructor(private deps: TravelDetectorDeps) {}

  /** 启动/重载后从后端事实源播种；失败的水合行静默跳过（最坏重报一次） */
  hydrate(rows: WorkbuddyStateRecord[]): void {
    for (const row of rows) {
      this.claimed.set(row.instance_id, row.value);
    }
  }

  observe(instance: ProviderInstance, snapshot: ProviderSnapshot): void {
    const travel = snapshot.travel;
    if (!travel) return;
    if (this.claimed.get(instance.id) === travel.tripKey) return;
    this.claimed.set(instance.id, travel.tripKey);
    const { title, params } = alertTitle(instance, snapshot, "喵喵旅行到账");
    const credited = travel.credited > 0;
    this.deps.notify({
      instanceId: instance.id,
      title,
      body: credited ? "旅行积分 +{credit} 已到账" : "旅行积分已到账",
      params: credited ? { ...params, credit: travel.credited } : params,
    });
    this.deps.onStateChange({
      instance_id: instance.id,
      kind: wbStateKind.travelNotified,
      value: travel.tripKey,
    });
  }

  /** 删除实例后清理其投影；后端事实源由 delete_instance 级联清理 */
  prune(instanceId: string): void {
    this.claimed.delete(instanceId);
  }
}
