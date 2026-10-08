import { invoke } from "@tauri-apps/api/core";

/**
 * WorkBuddy 日常例程判据的读写（Rust 端 workbuddy_states 表，ADR-0039）。
 *
 * 一格只说一件事：`*_acted` / `*_tried` 是「这个动作做过没有」，`*_notified` 是
 * 「这件事的通知发过没有」——两者不能合用一格（签到成功才发通知，但「今日已签」无论
 * 成功还是上游说已签都要认），此前它们一半在内存 Map、一半在各自的表里，重启后内存
 * 那半失效，于是同一天的动作会重做一遍。收进同一张表后按 kind 分格，两边都持久。
 *
 * value 的形状按格自解释：按日的存 CST 日期、按行程的存行程键、一次性的存 '1'、
 * 留档的存 JSON。
 */
export const wbStateKind = {
  /** 今日已发过 daily-checkin 请求（成功或「已签」都算） */
  checkinActed: "checkin_acted",
  /** 今日已发过「签到成功」通知 */
  checkinNotified: "checkin_notified",
  /** 该趟行程已尝试过领奖（行程键 depart_at） */
  travelTried: "travel_tried",
  /** 该趟行程的到账已通知（行程键 depart_at） */
  travelNotified: "travel_notified",
  /** 今日管家已完整跑过一轮（整轮无可重试失败才写） */
  butlerActed: "butler_acted",
  /** 今日管家事件已通知（一轮多事件汇总一条） */
  butlerNotified: "butler_notified",
  /** 最近一轮管家的到账明细 JSON（抽屉「最近一次领取」的唯一留档） */
  butlerDetail: "butler_detail",
  /** 试用加油包已永久处理（一次性，'1'） */
  trialActed: "trial_acted",
  /** 试用加油包领取已通知（一次性，'1'） */
  trialNotified: "trial_notified",
  /** 今日已自动续期过 token */
  tokenRenewed: "token_renewed",
  /** 今日已发过活跃上报（点亮连登那条） */
  activityActed: "activity_acted",
  /** Cookie 通道的账号信息 JSON（uid/nickname）——uid 是活跃上报的硬门槛，
   *  取到过一次就永久复用，不再受 console/account 偶发失败影响 */
  cookieAccount: "cookie_account",
} as const;

export type WbStateKind = (typeof wbStateKind)[keyof typeof wbStateKind];

/** 一次性事件格子的值（trial_acted / trial_notified）：这类判据只关心「写过没有」，
 *  值本身没有含义，但两侧（例程与通知检测器）必须写同一个值，故在此定一处 */
export const oneShotValue = "1";

/** 一格的完整记录（写库与检测器回写用的形状）：kind 限死在 wbStateKind 里那几格，
 *  格子名打错在编译期就拦住——判据全靠格子名对上，写错一格等于静默失效 */
export interface WorkbuddyStateRecord {
  instance_id: string;
  kind: WbStateKind;
  value: string;
}

/** 读一格；无行或读失败都返回 null（= 没做过）。刻意不留内存投影：判据的权威只有
 *  库这一处，内存里再存一份就会读到过期值（抽屉的「最近一次领取」正是会变的那种），
 *  而且同一件事两个地方各说各话本来就是这次收表要消灭的东西（ADR-0039）。
 *  读失败的后果按最坏情形处理：重复一次幂等动作或多通知一条，绝不卡住取数链 */
export async function readWorkbuddyState(
  instanceId: string,
  kind: WbStateKind,
): Promise<string | null> {
  try {
    return await invoke<string | null>("get_workbuddy_state", { instanceId, kind });
  } catch (error) {
    console.warn(`WorkBuddy 判据读取失败（${kind}）`, error);
    return null;
  }
}

/** 回写一格（UPSERT 幂等）。落库失败只留痕——判重的兜底在上游的幂等，不在这里；
 *  通知那几路本来就按「投递韧性优先于判重」处理 */
export async function writeWorkbuddyState(
  instanceId: string,
  kind: WbStateKind,
  value: string,
): Promise<void> {
  try {
    await invoke("save_workbuddy_state", { record: { instance_id: instanceId, kind, value } });
  } catch (error) {
    console.warn(`WorkBuddy 判据回写失败（${kind}）`, error);
  }
}
