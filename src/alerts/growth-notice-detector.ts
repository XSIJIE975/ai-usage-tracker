import { alertTitle } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot, StoredWorkbuddyGrowthNotice } from "../types/ipc";

export interface GrowthNoticeArrival {
  instanceId: string;
  title: string;
  body: string;
  params: Record<string, string | number>;
}

export interface GrowthNoticeDetectorDeps {
  notify: (arrival: GrowthNoticeArrival) => void;
  onStateChange: (record: StoredWorkbuddyGrowthNotice) => void;
}

/** 连登奖励通知正文（纯函数，单测锚点）：一轮闭环可能同时发生补签/礼包/补偿/兑换/抽奖，
 *  通知按日汇总为一条——积分与能量合并成到账合计，事件明细（档位、奖品、礼包名）
 *  在成长中心抽屉的行内记录里看全量，通知只报最重要的两条事实：到账了什么、
 *  连登保没保住。抽奖计数不进通知（奖品明细无法枚举进模板，见 ADR-0037 取舍） */
export function buildButlerNoticeBody(credit: number, energy: number, makeupUsed: number): string {
  const suffix = makeupUsed > 0 ? "；已用补签卡补签昨日" : "";
  if (credit > 0 && energy > 0) return `成长中心到账 +{credit} 积分 +{energy} 能量${suffix}`;
  if (credit > 0) return `成长中心到账 +{credit} 积分${suffix}`;
  if (makeupUsed > 0) return "已用补签卡补签昨日，连登已保住";
  // 剩余形态 = 纯抽奖有奖（draws 非空才进通知）：奖品不含积分，报中性事实，
  // 不出「到账 +0 积分」的荒谬文案
  return "成长中心奖励已领取";
}

/**
 * WorkBuddy 连登奖励通知检测器：与签到检测器同构（按日判重）——自动闭环跟随每日
 * 首次刷新自动跑（ADR-0037），一轮可能产生多个事件但通知至多一条；判定权威是
 * Rust 端 workbuddy_growth_notices 行，落库快照随重启后的 reevaluate 重放时
 * （growthNotice 字段还在）同一天的重放直接跳过。不进告警冷却体系：管家是
 * 每日至多一轮的事件，没有冷却参数。抽屉里手动「领取全部奖励」不产生快照字段、
 * 不走这里——用户主动触发的结果在行内即时可见，不需要再敲一条系统通知。
 * 回写时把本轮明细（detail_json）一起存进判重行：那是抽屉「最近一次领取」的唯一
 * 持久留档——快照上的 growthNotice 会被下一次刷新覆盖，不落库的抽屉就答不出昨天领了什么。
 */
export class GrowthNoticeDetector {
  /** instanceId → 最近一次发出通知的闭环日期（后端事实源的内存投影） */
  private notified = new Map<string, string>();

  constructor(private deps: GrowthNoticeDetectorDeps) {}

  /** 启动/重载后从后端事实源播种；失败的水合行静默跳过（最坏重报一次） */
  hydrate(rows: StoredWorkbuddyGrowthNotice[]): void {
    for (const row of rows) {
      this.notified.set(row.instance_id, row.notified_date);
    }
  }

  observe(instance: ProviderInstance, snapshot: ProviderSnapshot): void {
    const notice = snapshot.growthNotice;
    if (!notice) return;
    if (this.notified.get(instance.id) === notice.date) return;
    this.notified.set(instance.id, notice.date);
    const { title, params } = alertTitle(instance, snapshot, "连登奖励到账");
    const credit =
      notice.giftCredit +
      notice.compensationCredit +
      notice.redeemed.reduce((sum, item) => sum + item.credit, 0);
    const energy = notice.redeemed.reduce((sum, item) => sum + item.energy, 0);
    this.deps.notify({
      instanceId: instance.id,
      title,
      body: buildButlerNoticeBody(credit, energy, notice.makeupUsed),
      params: { ...params, credit, energy },
    });
    this.deps.onStateChange({
      instance_id: instance.id,
      notified_date: notice.date,
      detail_json: JSON.stringify(notice),
    });
  }

  /** 删除实例后清理其投影；后端事实源由 delete_instance 级联清理 */
  prune(instanceId: string): void {
    this.notified.delete(instanceId);
  }
}
