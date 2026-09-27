import { create } from "zustand";
import type { ProviderInstance } from "../types/ipc";
import {
  createTaskContext,
  runWorkbuddyTask,
  layerTasks,
  TaskActionError,
  type WorkbuddyTask,
} from "../providers/workbuddy-tasks";

/** 成长任务面板的执行会话（ADR-0036）：执行编排放在 React 组件树之外——抽屉关闭
 *  不中止一轮「一键完成」（全量 1~3 分钟很常见），执行期间重开抽屉仍能看到逐项
 *  结果；已结束的会话保留到下次手动刷新或开新一轮（失败痕迹不因重开丢失）。
 *  会话是内存态：任务真实进度以服务端列表为唯一事实源 */

export interface TaskRunItem {
  taskCode: string;
  title: string;
  status: "pending" | "running" | "done" | "error";
  /** 中文模板（可能含 {message} 嵌套与 {credit}/{detail} 等参数位），渲染层
   *  renderTemplate(message, params) 出文案——i18n 中文即 key（ADR-0036） */
  message: string;
  params?: Record<string, string | number>;
  /** 上一轮会话并入的历史条目：反馈保留供用户读，不计入本轮 {done}/{total} 进度 */
  carried?: boolean;
}

interface TaskRunSession {
  running: boolean;
  items: TaskRunItem[];
  startedAt: number;
}

interface WorkbuddyTaskStore {
  runs: Record<string, TaskRunSession>;
  /** 卡片入口的待办徽标缓存（面板打开过才有值；不给刷新链加活，ADR-0036 手动触发） */
  pendingBadges: Record<string, number>;
  /** 启动一轮执行（一键完成传全量，单项执行传单元素数组）。同实例执行中返回 false
   *  （不排队——任务是一次性的，重复跑只浪费上报）。titles 供执行态行内显示 */
  startRun: (
    instance: ProviderInstance,
    tasks: WorkbuddyTask[],
    titles: Map<string, string>,
  ) => boolean;
  /** 记录徽标（面板每次扫描后调用） */
  setPendingBadge: (instanceId: string, count: number) => void;
  /** 清掉同 taskCode 的执行条目（claim 收尾调用，防陈旧条目锁死行/遮蔽新反馈） */
  clearRunItem: (instanceId: string, taskCode: string) => void;
  /** 新一轮扫描结果到达时清掉旧会话（执行中不清——结果以在跑的这轮为准） */
  resetRun: (instanceId: string) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function markItem(
  instanceId: string,
  taskCode: string,
  patch: Partial<TaskRunItem>,
): void {
  useWorkbuddyTaskStore.setState((state) => {
    const session = state.runs[instanceId];
    if (!session) return state;
    return {
      runs: {
        ...state.runs,
        [instanceId]: {
          ...session,
          items: session.items.map((item) =>
            item.taskCode === taskCode ? { ...item, ...patch } : item,
          ),
        },
      },
    };
  });
}

export const useWorkbuddyTaskStore = create<WorkbuddyTaskStore>((set, get) => ({
  runs: {},
  pendingBadges: {},
  startRun: (instance, tasks, titles) => {
    const existing = get().runs[instance.id];
    if (existing?.running || tasks.length === 0) return false;
    // 上一轮不在本轮清单内的条目并入为新会话的历史反馈（N2：单项重试不再抹掉
    // 其余行的失败痕迹）；守卫保证旧会话必非 running，条目状态冻结原样保留
    const carriedItems: TaskRunItem[] = (existing?.items ?? [])
      .filter((item) => !tasks.some((task) => task.taskCode === item.taskCode))
      .map((item) => ({ ...item, carried: true }));
    const items: TaskRunItem[] = [
      ...carriedItems,
      ...tasks.map((task) => ({
        taskCode: task.taskCode,
        title: titles.get(task.taskCode) ?? task.taskCode,
        status: "pending" as const,
        message: "",
      })),
    ];
    set((state) => ({
      runs: {
        ...state.runs,
        [instance.id]: { running: true, items, startedAt: Date.now() },
      },
    }));
    // 后台跑完整轮：单项失败不中断后续（项间节流对齐参考 reportGap 风控口径）。
    // 逐项结果按模板+params 存（TaskActionError 的中文模板走键查询，未知错误原文
    // 作 {detail} 塞进兜底模板——英文模式不静默显中文）。createTaskContext 也在
    // 兜底内：它抛错（网络/半失效 HTML）绝不能把 running 永久卡在 true——那是
    // 实例级按钮死锁，只能重启应用
    void (async () => {
      let ctx: Awaited<ReturnType<typeof createTaskContext>> = null;
      try {
        ctx = await createTaskContext(instance);
      } catch {
        ctx = null;
      }
      if (!ctx) {
        // 账号信息拿不到：全项标同一个错、不逐项空等节流（复审 N 系列：
        // 15 项空转 14 秒毫无意义），直接收口
        for (const task of tasks) {
          markItem(instance.id, task.taskCode, {
            status: "error",
            message: "账号信息获取失败，请刷新重试或改用扫码登录",
          });
        }
      } else {
        for (const [index, task] of tasks.entries()) {
          markItem(instance.id, task.taskCode, { status: "running" });
          try {
            const result = await runWorkbuddyTask(ctx, task);
            markItem(instance.id, task.taskCode, {
              status: result.ok ? "done" : "error",
              message: result.message,
              params: result.params,
            });
          } catch (error) {
            markItem(instance.id, task.taskCode, {
              status: "error",
              message: error instanceof TaskActionError
                ? error.message
                : "任务执行失败：{detail}",
              params: error instanceof TaskActionError
                ? error.params
                : { detail: error instanceof Error ? error.message : String(error) },
            });
          }
          if (index < tasks.length - 1) await sleep(1_000);
        }
      }
      useWorkbuddyTaskStore.setState((state) => {
        const session = state.runs[instance.id];
        if (!session) return state;
        return { runs: { ...state.runs, [instance.id]: { ...session, running: false } } };
      });
      // 徽标不在跑完后本地扣减：部分失败时按全量扣会归零失真，执行结束的自动重扫
      // 会写入扫描准值（重扫失败则保留旧值，也不比扣减差）
    })();
    return true;
  },
  setPendingBadge: (instanceId, count) =>
    set((state) => ({ pendingBadges: { ...state.pendingBadges, [instanceId]: count } })),
  /** 清掉同 taskCode 的执行条目（claim 收尾调用）：否则陈旧的 done/error 条目会
   *  把「可领取」行锁死成已完成 ✓、或遮蔽新写入的领取反馈（复审 N1） */
  clearRunItem: (instanceId, taskCode) =>
    set((state) => {
      const session = state.runs[instanceId];
      if (!session) return state;
      return {
        runs: {
          ...state.runs,
          [instanceId]: {
            ...session,
            items: session.items.filter((item) => item.taskCode !== taskCode),
          },
        },
      };
    }),
  resetRun: (instanceId) =>
    set((state) => {
      const session = state.runs[instanceId];
      if (session?.running) return state;
      const { [instanceId]: _removed, ...rest } = state.runs;
      return { runs: rest };
    }),
}));

/** 面板标题定位（上游 title 优先，动作表兜底标题次之） */
export function taskDisplayTitle(task: WorkbuddyTask, fallbackTitles: Map<string, string>): string {
  return task.title || fallbackTitles.get(task.taskCode) || task.taskCode;
}

export { layerTasks };
