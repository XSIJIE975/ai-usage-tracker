/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import { ChangelogDialog } from "./ChangelogDialog";
import { useChangelogDialogStore } from "../store/useChangelogDialogStore";
import { useUpdateStore } from "../store/useUpdateStore";
import type { ChangelogEntry } from "../lib/changelog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

const entries: ChangelogEntry[] = [
  {
    version: "0.5.0",
    date: "2026-10-20",
    notes: "### 新功能\n\n- 第五版支持更新日志弹窗",
  },
  {
    version: "0.4.0",
    date: "2026-10-15",
    notes: "### 新功能\n\n- 第四版内容",
  },
  {
    version: "0.3.0",
    date: "2026-10-10",
    notes: "### 修复\n\n- 第三版内容",
  },
];

function resetStores() {
  useChangelogDialogStore.setState({
    open: false,
    mode: "manual",
    fromVersion: null,
    toVersion: null,
  });
  useUpdateStore.setState({
    status: "idle",
    version: null,
    notes: null,
  });
}

beforeEach(() => {
  resetStores();
  mockedInvoke.mockReset();
});

afterEach(() => {
  cleanup();
  resetStores();
});

describe("ChangelogDialog", () => {
  it("manual 模式：展示内嵌全量历史，无更新时不出现新版本区块", async () => {
    mockedInvoke.mockResolvedValue(entries);
    useChangelogDialogStore.setState({ open: true, mode: "manual" });

    render(<ChangelogDialog />);

    // getByText 找不到即抛错：出现即断言通过
    await waitFor(() => {
      screen.getByText("v0.5.0");
    });
    screen.getByText("v0.4.0");
    screen.getByText("v0.3.0");
    // 每个版本带 GitHub Release 链接
    screen.getByTitle("在 GitHub 查看 v0.5.0 的发布");
    screen.getByTitle("在 GitHub 查看 v0.3.0 的发布");
    screen.getByText("更新日志");
    expect(screen.queryByText(/发现新版本/)).toBeNull();
    // manual 模式没有「知道了」底栏
    expect(screen.queryByText("知道了")).toBeNull();
  });

  it("manual 模式：有待安装新版本时顶部出现新版本区块与安装入口", async () => {
    mockedInvoke.mockResolvedValue(entries);
    useUpdateStore.setState({
      status: "available",
      version: "0.6.0",
      notes: "### 新功能\n\n- 第六版的新内容",
    });
    useChangelogDialogStore.setState({ open: true, mode: "manual" });

    render(<ChangelogDialog />);

    await waitFor(() => {
      screen.getByText(/发现新版本/);
    });
    screen.getByText(/第六版的新内容/);
    screen.getByText("下载并安装");
    // 历史仍在
    screen.getByText("v0.5.0");
  });

  it("whats-new 模式：只展示区间条目并带「从…更新到…」副题", async () => {
    mockedInvoke.mockResolvedValue(entries);
    useChangelogDialogStore.setState({
      open: true,
      mode: "whats-new",
      fromVersion: "0.3.0",
      toVersion: "0.5.0",
    });

    render(<ChangelogDialog />);

    await waitFor(() => {
      screen.getByText("本次更新内容");
    });
    screen.getByText("从 v0.3.0 更新到 v0.5.0");
    screen.getByText("v0.5.0");
    screen.getByText("v0.4.0");
    // 区间下界不含 0.3.0（那一版已看过）
    expect(screen.queryByText("v0.3.0")).toBeNull();
    screen.getByText("知道了");
  });
});
