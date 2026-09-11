import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getProviderModule } from "../providers";
import { currentWindowLabel, useAppStore } from "./useAppStore";
import type { ProviderInstance, ProviderSnapshot, StoredSnapshot } from "../types/ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("../providers", () => ({ getProviderModule: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);
const mockedGetCurrentWindow = vi.mocked(getCurrentWindow);
const mockedGetProviderModule = vi.mocked(getProviderModule);

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

describe("refreshAll（ADR-0023）", () => {
  const instance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
    id: "inst-1",
    providerId: "deepseek",
    note: "",
    sortOrder: 0,
    pinned: false,
    autoRefresh: true,
    threshold: null,
    balanceThreshold: null,
    createdAt: 0,
    ...overrides,
  });

  const snapshot = (status: "ok" | "error"): ProviderSnapshot => ({
    instanceId: "inst-1",
    providerId: "deepseek",
    providerName: "DeepSeek",
    status,
    updatedAt: 0,
    lines: [],
  });

  const readyState = () => {
    useAppStore.setState({
      instances: [instance()],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vaultStatus: { unlocked: true, needsMigration: false, keychainLost: false } as any,
      loading: false,
      snapshots: [],
      lastRefreshedAt: 0,
      error: null,
    });
  };

  beforeEach(() => {
    mockedGetProviderModule.mockReset();
    mockedInvoke.mockImplementation(async () => undefined);
  });

  it("抓取失败也落库错误快照：save_snapshot 收到 status=error 的 payload", async () => {
    readyState();
    mockedGetProviderModule.mockReturnValue({
      id: "deepseek",
      name: "DeepSeek",
      fetch: vi.fn().mockRejectedValue(new Error("provider down")),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "get_latest_snapshots") return [storedRow("inst-1", 42)];
      return undefined;
    });

    await useAppStore.getState().refreshAll();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "save_snapshot",
      expect.objectContaining({
        instanceId: "inst-1",
        payload: expect.objectContaining({ status: "error" }),
      }),
    );
    // 展示以读回的落库事实为准
    expect(useAppStore.getState().snapshots[0]?.instanceId).toBe("inst-1");
    expect(useAppStore.getState().loading).toBe(false);
  });

  it("in-flight 去重：刷新进行中的重入不重复抓取", async () => {
    readyState();
    let resolveFetch!: (snapshot: ProviderSnapshot) => void;
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise<ProviderSnapshot>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    mockedGetProviderModule.mockReturnValue({ id: "deepseek", name: "DeepSeek", fetch } as never);

    const first = useAppStore.getState().refreshAll();
    const reentrant = useAppStore.getState().refreshAll();
    expect(useAppStore.getState().loading).toBe(true);

    resolveFetch(snapshot("ok"));
    await Promise.all([first, reentrant]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().loading).toBe(false);
  });

  it("落库失败不冒充成功：错误留在 error 字段，快照回退本轮内存结果", async () => {
    readyState();
    mockedGetProviderModule.mockReturnValue({
      id: "deepseek",
      name: "DeepSeek",
      fetch: vi.fn().mockResolvedValue(snapshot("ok")),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "save_snapshot") throw new Error("db locked");
      if (command === "get_latest_snapshots") return [storedRow("inst-1", 42)];
      return undefined;
    });

    await useAppStore.getState().refreshAll();

    expect(useAppStore.getState().error).toBe("db locked");
    // 读回也失败时回退 results（save 失败 + 读回失败 → 用内存里的本轮结果）
    expect(useAppStore.getState().loading).toBe(false);
  });
});
