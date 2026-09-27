import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { ProviderInstance } from "../types/ipc";
import type { WorkbuddyTask } from "../providers/workbuddy-tasks";
import { useWorkbuddyTaskStore } from "./workbuddyTaskStore";

const mockInvoke = vi.mocked(invoke);

const makeInstance = (): ProviderInstance => ({
  id: "wb-store-1",
  providerId: "workbuddy",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: true,
  threshold: null,
  balanceThreshold: null,
  site: "china",
  tokenAutoRenew: true,
  createdAt: 0,
});

const titles = new Map([["chat_5", "完成 5 次对话"]]);
const tasks: WorkbuddyTask[] = [
  {
    taskCode: "chat_5",
    title: "",
    description: "",
    rewardCredit: 100,
    rewardEnergy: 0,
    target: 5,
    current: 0,
    acceptStatus: "",
    claimed: false,
    claimable: false,
    locked: false,
    isMp: false,
  },
];

beforeEach(() => {
  mockInvoke.mockReset();
  useWorkbuddyTaskStore.setState({ runs: {}, pendingBadges: {} });
});

describe("workbuddyTaskStore", () => {
  it("createTaskContext 抛错有兜底：全部标 error、running 归位、可再次开跑（P1-1）", async () => {
    // vault_credential_status 直接 reject——旧实现会把 running 永久卡 true
    mockInvoke.mockRejectedValue(new Error("vault locked"));
    const instance = makeInstance();
    const started = useWorkbuddyTaskStore.getState().startRun(instance, tasks, titles);
    expect(started).toBe(true);
    // 执行中重入被拒
    expect(useWorkbuddyTaskStore.getState().startRun(instance, tasks, titles)).toBe(false);
    await vi.waitFor(
      () => {
        const session = useWorkbuddyTaskStore.getState().runs[instance.id];
        expect(session?.running).toBe(false);
      },
      { timeout: 3_000 },
    );
    const session = useWorkbuddyTaskStore.getState().runs[instance.id];
    expect(session.items[0].status).toBe("error");
    expect(session.items[0].message).toContain("账号信息获取失败");
    // 结束后可以开新一轮（无死锁）
    expect(useWorkbuddyTaskStore.getState().startRun(instance, tasks, titles)).toBe(true);
  });

  it("resetRun 保护执行中的会话，只清已结束的", async () => {
    mockInvoke.mockImplementation(
      () =>
        new Promise(() => {
          /* 永不 resolve：模拟挂着的请求 */
        }),
    );
    const instance = makeInstance();
    useWorkbuddyTaskStore.getState().startRun(instance, tasks, titles);
    expect(useWorkbuddyTaskStore.getState().runs[instance.id]?.running).toBe(true);
    useWorkbuddyTaskStore.getState().resetRun(instance.id);
    expect(useWorkbuddyTaskStore.getState().runs[instance.id]?.running).toBe(true);
  });
});
