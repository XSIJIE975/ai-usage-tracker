import { beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdateStore } from "./useUpdateStore";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

const mockedCheck = vi.mocked(check);
const mockedRelaunch = vi.mocked(relaunch);
const mockedGetVersion = vi.mocked(getVersion);

const resetStore = () =>
  useUpdateStore.setState({
    status: "idle",
    version: null,
    notes: null,
    currentVersion: null,
    downloadedBytes: 0,
    contentLength: null,
    error: null,
  });

type DownloadEventCallback = (event:
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" }) => void;

const makeUpdate = (downloadImpl?: (onEvent?: DownloadEventCallback) => Promise<void>) => ({
  version: "0.2.0",
  body: "## 修复\n- 修正若干问题",
  downloadAndInstall: vi.fn(
    async (onEvent?: DownloadEventCallback) => {
      await downloadImpl?.(onEvent);
    },
  ),
});

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe("check", () => {
  it("标记 up-to-date 当检查返回 null", async () => {
    mockedCheck.mockResolvedValue(null);

    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().status).toBe("up-to-date");
    expect(useUpdateStore.getState().version).toBeNull();
  });

  it("记录版本号与说明当发现新版本", async () => {
    mockedCheck.mockResolvedValue(makeUpdate() as never);

    await useUpdateStore.getState().check();

    const state = useUpdateStore.getState();
    expect(state.status).toBe("available");
    expect(state.version).toBe("0.2.0");
    expect(state.notes).toBe("## 修复\n- 修正若干问题");
  });

  it("静默检查失败时回到 idle 且不写错误态", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockedCheck.mockRejectedValue(new Error("network unreachable"));

    await useUpdateStore.getState().check({ silent: true });

    expect(useUpdateStore.getState().status).toBe("idle");
    expect(useUpdateStore.getState().error).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("手动检查失败时进入 error 态并带中文消息", async () => {
    mockedCheck.mockRejectedValue(new Error("not found"));

    await useUpdateStore.getState().check();

    const state = useUpdateStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toBe("检查更新失败：not found");
  });

  it("下载进行中时忽略重复检查", async () => {
    useUpdateStore.setState({ status: "downloading" });

    await useUpdateStore.getState().check();

    expect(mockedCheck).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toBe("downloading");
  });
});

describe("downloadAndInstall", () => {
  it("累加下载字节并在完成后重启应用", async () => {
    const update = makeUpdate(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 300 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 200 } });
      onEvent?.({ event: "Finished" });
    });
    mockedCheck.mockResolvedValue(update as never);
    mockedRelaunch.mockResolvedValue(undefined);
    await useUpdateStore.getState().check();

    await useUpdateStore.getState().downloadAndInstall();

    const state = useUpdateStore.getState();
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(state.contentLength).toBe(300);
    expect(state.downloadedBytes).toBe(300);
    expect(state.status).toBe("ready");
    expect(mockedRelaunch).toHaveBeenCalledTimes(1);
  });

  it("服务端未给出总长度时仍可下载", async () => {
    const update = makeUpdate(async (onEvent) => {
      onEvent?.({ event: "Started", data: {} });
      onEvent?.({ event: "Progress", data: { chunkLength: 64 } });
      onEvent?.({ event: "Finished" });
    });
    mockedCheck.mockResolvedValue(update as never);
    mockedRelaunch.mockResolvedValue(undefined);
    await useUpdateStore.getState().check();

    await useUpdateStore.getState().downloadAndInstall();

    const state = useUpdateStore.getState();
    expect(state.contentLength).toBeNull();
    expect(state.downloadedBytes).toBe(64);
    expect(state.status).toBe("ready");
  });

  it("安装失败进入 error 态并保留重试空间", async () => {
    const update = makeUpdate(async () => {
      throw new Error("disk full");
    });
    mockedCheck.mockResolvedValue(update as never);
    await useUpdateStore.getState().check();

    await useUpdateStore.getState().downloadAndInstall();

    const state = useUpdateStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toBe("更新安装失败：disk full");
  });
});

describe("loadCurrentVersion", () => {
  it("写入版本号且幂等", async () => {
    mockedGetVersion.mockResolvedValue("0.1.0");

    await useUpdateStore.getState().loadCurrentVersion();
    await useUpdateStore.getState().loadCurrentVersion();

    expect(useUpdateStore.getState().currentVersion).toBe("0.1.0");
    expect(mockedGetVersion).toHaveBeenCalledTimes(1);
  });
});
