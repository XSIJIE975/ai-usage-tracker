/**
 * @vitest-environment jsdom
 *
 * 统计抽屉的页签切换、首屏与游标追加：追加页必须按 id 去重，
 * 缺失成本显示 —，刷新/切区间不能把已加载的数据弄丢。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchOverview = vi.hoisted(() => vi.fn());
const fetchLogs = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock("../../providers/opencode-stats", () => ({
  fetchOpenCodeOverview: fetchOverview,
  fetchOpenCodeLogs: fetchLogs,
}));
vi.mock("../../components/charts/StackedBars", () => ({
  StackedBars: () => <div data-testid="chart" />,
}));

import { OpenCodeStats } from "./OpenCodeStats";
import { useAppStore } from "../../store/useAppStore";
import type { ProviderInstance } from "../../types/ipc";

const instance: ProviderInstance = {
  id: "i-opencode-test",
  providerId: "opencode-go",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: false,
  threshold: null,
  balanceThreshold: null,
  site: "china",
  tokenAutoRenew: true,
  createdAt: 0,
};

const summary = {
  requests: 42,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 2000,
  cacheWriteTokens: 150,
  totalTokens: 3650,
  costUsd: 0.12345678,
};

const page = (items: unknown[], nextCursor: string | null) => ({
  status: "ok" as const,
  data: { items, nextCursor, retentionDays: 30 },
});

const log = (id: string, model: string, costUsd: number | null) => ({
  id,
  startedAt: 1_600_000_000_000,
  durationMs: 1500,
  statusCode: 200,
  outcome: "succeeded",
  model,
  provider: "opencode",
  inputTokens: 100,
  outputTokens: 200,
  reasoningTokens: 20,
  cacheReadTokens: 300,
  cacheWriteTokens: 0,
  costUsd,
  sessionId: "sess-test",
});

beforeEach(() => {
  fetchOverview.mockReset();
  fetchLogs.mockReset();
  fetchOverview.mockResolvedValue({
    status: "ok",
    data: { summary, daily: [], models: [] },
  });
  useAppStore.setState({
    loading: false,
    refreshingInstances: {},
    manualRefreshTick: 0,
    vaultStatus: { initialized: true, unlocked: false, needsMigration: false, keychainLost: false },
  });
});

afterEach(cleanup);

describe("OpenCodeStats", () => {
  it("渲染概览指标，并切到请求日志页签", async () => {
    fetchLogs.mockResolvedValue(page([log("log-1", "test-model", null)], null));

    render(<OpenCodeStats instance={instance} />);

    expect(await screen.findByText("42")).toBeTruthy();
    expect(screen.getByText("$0.12")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "请求日志" }));

    expect(await screen.findByText("test-model")).toBeTruthy();
    // 缺失成本显示 —，不能冒充 $0.0000
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(/控制台仅保留最近 30 天日志/)).toBeTruthy();
  });

  it("加载更多追加而不是替换，按 id 去重，重复游标不再继续翻页", async () => {
    fetchLogs
      .mockResolvedValueOnce(
        page(
          [log("log-1", "model-a", 0.001), log("log-2", "test-model", 0.001)],
          "cursor-2",
        ),
      )
      // 第二页重复 log-2、新增 log-3，并返回同一个 cursor
      .mockResolvedValueOnce(
        page(
          [log("log-2", "test-model", 0.001), log("log-3", "test-model-2", 0.002)],
          "cursor-2",
        ),
      );

    render(<OpenCodeStats instance={instance} />);
    fireEvent.click(screen.getByRole("tab", { name: "请求日志" }));
    expect(await screen.findByText("model-a")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));

    expect(await screen.findByText("test-model-2")).toBeTruthy();
    // 第一页的 model-a 必须还在（追加不是替换），log-2 只出现一次
    expect(screen.getByText("model-a")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("test-model")).toHaveLength(1));
    // 追加请求确实带上了第一页的游标
    expect(fetchLogs.mock.calls[1][2]).toBe("cursor-2");
    // cursor 原地打转：按钮收起，避免无限追加
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("切换区间先清空旧表，再加载新区间数据", async () => {
    let resolveNext: ((value: unknown) => void) | null = null;
    fetchLogs
      .mockResolvedValueOnce(page([log("log-1", "model-a", 0.001)], null))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNext = resolve;
          }),
      );

    render(<OpenCodeStats instance={instance} />);
    fireEvent.click(screen.getByRole("tab", { name: "请求日志" }));
    expect(await screen.findByText("model-a")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "7 天" }));

    // 旧区间的行在绘制前就被清掉，不能挂在新标签下
    await waitFor(() => expect(screen.queryByText("model-a")).toBeNull());

    await act(async () =>
      (resolveNext as ((value: unknown) => void) | null)?.(
        page([log("log-9", "model-b", 0.001)], null),
      ),
    );
    expect(await screen.findByText("model-b")).toBeTruthy();
  });
});
