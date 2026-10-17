/**
 * @vitest-environment jsdom
 *
 * 刷新与切区间的区别：同 key 的 refreshTick 变化保留旧数据只转圈；
 * cacheKey 变化（区间/实例）必须先回到 loading，不能把旧区间数字挂在新标签下。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useStatsFetch } from "./use-stats-fetch";
import { createUsageCache } from "../../stats/usage-cache";
import type { StatsResult } from "../../providers/stats-result";

const ok = (data: string): StatsResult<string> => ({ status: "ok", data });

describe("useStatsFetch", () => {
  it("同 key 刷新保留旧数据并标记 isRefreshing", async () => {
    const cache = createUsageCache();
    let resolveRefresh: ((value: StatsResult<string>) => void) | null = null;
    const loader = vi.fn((key: string, tick: number) =>
      tick === 0
        ? Promise.resolve(ok(`A${key}`))
        : new Promise<StatsResult<string>>((resolve) => {
            resolveRefresh = resolve;
          }),
    );

    const { result, rerender } = renderHook(
      ({ key, tick }: { key: string; tick: number }) =>
        useStatsFetch(cache, key, () => loader(key, tick), tick),
      { initialProps: { key: "a", tick: 0 } },
    );

    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: "Aa" }));

    // 调用方（统计抽屉的 refresh）先失效缓存再递增 tick
    cache.invalidate("a");
    rerender({ key: "a", tick: 1 });
    expect(result.current.state).toEqual({ kind: "ready", data: "Aa" });
    expect(result.current.isRefreshing).toBe(true);

    await act(async () => resolveRefresh?.(ok("A2")));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: "A2" }));
  });

  it("cacheKey 变化时先回到 loading，不显示旧区间的数据", async () => {
    const cache = createUsageCache();
    let resolveB: ((value: StatsResult<string>) => void) | null = null;
    const loader = vi.fn((key: string) =>
      key === "a"
        ? Promise.resolve(ok("A"))
        : new Promise<StatsResult<string>>((resolve) => {
            resolveB = resolve;
          }),
    );

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useStatsFetch(cache, key, () => loader(key), 0),
      { initialProps: { key: "a" } },
    );

    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: "A" }));

    rerender({ key: "b" });
    expect(result.current.state).toEqual({ kind: "loading" });
    expect(result.current.isRefreshing).toBe(false);

    await act(async () => resolveB?.(ok("B")));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: "B" }));
  });
});
