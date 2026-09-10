import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { currentWindowLabel, useAppStore } from "./useAppStore";
import type { StoredSnapshot } from "../types/ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedGetCurrentWindow = vi.mocked(getCurrentWindow);

/** 落库行固定形如 { instance_id, captured_at, payload }；payload 里的 instanceId 是历史遗留 */
const storedRow = (instanceId: string, percentUsed: number) =>
  ({
    instance_id: instanceId,
    captured_at: 1_700_000_000_000,
    payload: {
      instanceId,
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "ok",
      updatedAt: 1_700_000_000_000,
      lines: [{ type: "progress", label: "{hours} 小时请求配额", params: { hours: 5 }, percentUsed }],
    },
  }) as unknown as StoredSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ snapshots: [], lastRefreshedAt: 0 });
});

describe("reloadSnapshots（快照收敛，ADR-0019）", () => {
  it("以落库行的 instance_id 为准重建快照", async () => {
    // payload 里的 instanceId 故意写成旧值：行的 instance_id 才是唯一事实
    const row = storedRow("inst-1", 42);
    row.payload.instanceId = "legacy-id";
    mockedInvoke.mockResolvedValue([row]);

    await useAppStore.getState().reloadSnapshots();

    expect(mockedInvoke).toHaveBeenCalledWith("get_latest_snapshots");
    const [snapshot] = useAppStore.getState().snapshots;
    expect(snapshot.instanceId).toBe("inst-1");
    expect(snapshot.lines[0].percentUsed).toBe(42);
  });

  it("读库失败时保留旧快照，不置空也不抛出", async () => {
    useAppStore.setState({ snapshots: [storedRow("inst-1", 7).payload] });
    mockedInvoke.mockRejectedValue(new Error("db locked"));

    await expect(useAppStore.getState().reloadSnapshots()).resolves.toBeUndefined();

    expect(useAppStore.getState().snapshots).toHaveLength(1);
    expect(useAppStore.getState().snapshots[0].instanceId).toBe("inst-1");
  });

  it("收敛只动快照，不碰 lastRefreshedAt（基准由事件载荷负责）", async () => {
    mockedInvoke.mockResolvedValue([storedRow("inst-1", 3)]);
    useAppStore.setState({ lastRefreshedAt: 1234 });

    await useAppStore.getState().reloadSnapshots();

    expect(useAppStore.getState().lastRefreshedAt).toBe(1234);
  });
});

describe("currentWindowLabel", () => {
  it("返回当前窗口标签", () => {
    mockedGetCurrentWindow.mockReturnValue({ label: "glance" } as never);
    expect(currentWindowLabel()).toBe("glance");
  });

  it("非 Tauri 环境（取窗口抛错）返回空串，收敛判定退化为「总是重读」", () => {
    mockedGetCurrentWindow.mockImplementation(() => {
      throw new Error("not in tauri");
    });
    expect(currentWindowLabel()).toBe("");
  });
});
