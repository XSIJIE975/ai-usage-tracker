import { alertTitle } from "./evaluate";
import type { ProviderInstance, ProviderSnapshot, StoredSeenResetCards } from "../types/ipc";

/** 到账事件：文案出口与 AlertFire 同构（中文模板 + params，ADR-0022），但不进告警
 *  协调器的边沿/冷却体系，也不带 ruleKey 走后端冷却判重——到账判重的权威是
 *  seen_reset_cards 的已见集合本身，同一张卡在集合合并后天然不会再出现在差集里 */
export interface ResetCardArrival {
  instanceId: string;
  title: string;
  body: string;
  params: Record<string, string | number>;
}

export interface ResetCardDetectorDeps {
  notify: (arrival: ResetCardArrival) => void;
  /** 已见集合变化时回写后端事实源（播种、新卡合并、卡消耗后的收敛），重启恢复用 */
  onStateChange?: (seen: StoredSeenResetCards) => void;
}

interface InstanceState {
  seen: Set<number>;
  /** 是否已完成首刷播种：false = 从未见该实例数据（观察下一轮成功快照时播种、不通知） */
  seeded: boolean;
}

export interface ResetCardIds {
  fiveHour: number[];
  week: number[];
}

/**
 * 重置卡到账检测器（仅智谱实例）：快照携带本轮在线的可用卡 recordId（glm.ts 透传，
 * 不发额外请求），与本实例已见集合做差集，新增的可用卡发一条到账通知（5 小时卡与
 * 周卡合并）。同一张卡只提醒一次：内存集合判定 + Rust 表持久化，重启/重载后 hydrate
 * 播种恢复，与 AlertCoordinator 的「内存投影 + 后端事实源」分工同构。
 *
 * 边界语义：
 * - 快照非 ok 或缺 availableResetIds（重置卡源失败）→ 冻结：不播种、不判定、不收敛
 *   （ADR-0023 同构：未知 ≠ 正常，网络抖动不重置已见集合）；
 * - 从未播种的实例首次成功快照 → 把存量可用卡整体记为已见，不发通知；
 * - recordId 缺失的卡不参与检测（glm.ts 侧已过滤），绝不误报。
 */
export class ResetCardDetector {
  private state = new Map<string, InstanceState>();
  private deps: Required<Pick<ResetCardDetectorDeps, "notify">> &
    Pick<ResetCardDetectorDeps, "onStateChange">;

  constructor(deps: ResetCardDetectorDeps) {
    this.deps = { notify: deps.notify, onStateChange: deps.onStateChange };
  }

  /** 删除实例后清理其内存投影（后端事实源由 delete_instance 级联清理，这里只清投影） */
  prune(instanceId: string): void {
    this.state.delete(instanceId);
  }

  /** 启动/重载后用后端事实源播种内存投影（ADR-0025 同构）：只播种会话内尚不存在的键 */
  hydrate(seen: StoredSeenResetCards[]): void {
    for (const item of seen) {
      if (this.state.has(item.instance_id)) continue;
      this.state.set(item.instance_id, {
        seen: new Set(item.record_ids),
        seeded: item.seeded,
      });
    }
  }

  /** 每次快照落库后调用；非 ok 快照与缺明细的快照按冻结处理 */
  observe(instance: ProviderInstance, snapshot: ProviderSnapshot): void {
    if (instance.providerId !== "glm") return;
    if (snapshot.status !== "ok" || !snapshot.availableResetIds) return;
    const current = snapshot.availableResetIds;

    const existing = this.state.get(instance.id);
    if (!existing || !existing.seeded) {
      // 首刷播种：存量可用卡全部视为已见，不发通知（功能上线/重建实例不回放历史卡）
      this.save(instance, current, true);
      return;
    }

    const newFiveHour = current.fiveHour.filter((id) => !existing.seen.has(id));
    const newWeek = current.week.filter((id) => !existing.seen.has(id));
    const total = newFiveHour.length + newWeek.length;
    if (total === 0) return;

    this.deps.notify(this.buildArrival(instance, snapshot, total, newFiveHour, newWeek));
    // 已见集合只增不减：同一 recordId 永远只提醒一次。卡被使用/过期后旧 id 留在集合里
    // 无副作用，还免疫接口把 available 短暂闪成 false 再恢复的抖动（收敛策略会误报重到）；
    // 每实例的活动卡量级有限，集合不存在膨胀问题
    const seen = new Set([...existing.seen, ...current.fiveHour, ...current.week]);
    this.state.set(instance.id, { seen, seeded: true });
    this.deps.onStateChange?.({ instance_id: instance.id, record_ids: [...seen], seeded: true });
  }

  private save(instance: ProviderInstance, current: ResetCardIds, seeded: boolean): void {
    const seen = new Set([...current.fiveHour, ...current.week]);
    this.state.set(instance.id, { seen, seeded });
    this.deps.onStateChange?.({
      instance_id: instance.id,
      record_ids: [...seen],
      seeded,
    });
  }

  private buildArrival(
    instance: ProviderInstance,
    snapshot: ProviderSnapshot,
    total: number,
    fiveHour: number[],
    week: number[],
  ): ResetCardArrival {
    const title = alertTitle(instance, snapshot, "重置卡到账");
    // 三种组合各一条模板（模板不能变形状，i18n key 不爆炸）；5 小时/周为窗口专名，
    // 与卡片「可用重置卡」行的「5 小时 ×N · 周 ×N」写法同源
    const body =
      fiveHour.length > 0 && week.length > 0
        ? "新增 {count} 张可用重置卡（5 小时 ×{fiveHour} · 周 ×{week}）"
        : fiveHour.length > 0
          ? "新增 {count} 张可用重置卡（5 小时 ×{fiveHour}）"
          : "新增 {count} 张可用重置卡（周 ×{week}）";
    return {
      instanceId: instance.id,
      title: title.title,
      body,
      params: { ...title.params, count: total, fiveHour: fiveHour.length, week: week.length },
    };
  }
}

/** 纯函数（单测锚点）：本轮可用 id − 已见 id，组内保持接口返回顺序 */
export function diffNewCardIds(seen: ReadonlySet<number>, current: ResetCardIds): ResetCardIds {
  return {
    fiveHour: current.fiveHour.filter((id) => !seen.has(id)),
    week: current.week.filter((id) => !seen.has(id)),
  };
}
