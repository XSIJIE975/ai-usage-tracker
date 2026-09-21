import { alertTitle } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot, StoredWorkbuddyTravelClaim } from "../types/ipc";

export interface TravelArrival {
  instanceId: string;
  title: string;
  body: string;
  params: Record<string, string | number>;
}

export interface TravelDetectorDeps {
  notify: (arrival: TravelArrival) => void;
  onStateChange: (record: StoredWorkbuddyTravelClaim) => void;
}

/**
 * WorkBuddy 喵喵旅行领奖通知检测器：与签到检测器同构，但判重键是行程标识
 * （depart_at）而非日期——一天可有多趟旅行，各趟各判各的。判定权威是 Rust 端
 * workbuddy_travel_claims 行：落库快照会随重启后的 reevaluate 重放（travel 字段
 * 还在），只靠内存态必然重报；水合后同行程的重放直接跳过。与重置卡/签到检测器
 * 同样不进告警冷却体系：领奖是按趟发生的事件，没有冷却参数。
 */
export class TravelDetector {
  /** instanceId → 最近一次发出通知的行程键（后端事实源的内存投影） */
  private claimed = new Map<string, string>();

  constructor(private deps: TravelDetectorDeps) {}

  /** 启动/重载后从后端事实源播种；失败的水合行静默跳过（最坏重报一次） */
  hydrate(rows: StoredWorkbuddyTravelClaim[]): void {
    for (const row of rows) {
      this.claimed.set(row.instance_id, row.claimed_key);
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
    this.deps.onStateChange({ instance_id: instance.id, claimed_key: travel.tripKey });
  }

  /** 删除实例后清理其投影；后端事实源由 delete_instance 级联清理 */
  prune(instanceId: string): void {
    this.claimed.delete(instanceId);
  }
}
