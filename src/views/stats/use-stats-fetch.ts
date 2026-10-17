import { useLayoutEffect, useRef, useState } from "react";
import type { StatsResult } from "../../providers/stats-result";
import type { UsageCache } from "../../stats/usage-cache";
import type { StatsAsyncState } from "./StatsStateCard";

const toState = <T,>(result: StatsResult<T>): StatsAsyncState<T> => {
  if (result.status === "ok") return { kind: "ready", data: result.data };
  if (result.status === "needs_config") {
    return { kind: "needs_config", message: result.message, params: result.params };
  }
  return { kind: "error", message: result.message, params: result.params };
};

export interface StatsFetchResult<T> {
  state: StatsAsyncState<T>;
  /** 刷新中（已有数据时局部 loading，不替换区域） */
  isRefreshing: boolean;
}

/**
 * 统计取数 hook：UsageCache 记忆 + 三态收敛 + 递增 requestId 竞态防护。
 *
 * 刷新模式（refreshTick 变化但已有数据时）：
 *   不切换到 loading 全屏占位，而是保留旧数据 + isRefreshing=true，
 *   完成后平滑替换为新数据，避免页面闪烁。
 *
 * cacheKey 为 null 时不拉取（保持 loading）。
 */
export function useStatsFetch<T>(
  cache: UsageCache,
  cacheKey: string | null,
  loader: () => Promise<StatsResult<T>>,
  refreshTick: number,
): StatsFetchResult<T> {
  const [state, setState] = useState<StatsAsyncState<T>>({ kind: "loading" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestIdRef = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  // 记录上一次的 state，用于判断是否为"已有数据的刷新"
  const prevStateRef = useRef<StatsAsyncState<T>>({ kind: "loading" });
  // 区间/实例切换会换 cacheKey：那不是刷新，旧数据不能挂在新标签下
  const prevKeyRef = useRef<string | null>(null);

  // 绘制前处理：key 变化时先回到 loading，避免旧区间数字先闪一帧
  useLayoutEffect(() => {
    if (cacheKey === null) return;
    const requestId = ++requestIdRef.current;

    const keyChanged = prevKeyRef.current !== cacheKey;
    prevKeyRef.current = cacheKey;
    if (keyChanged) {
      // 旧 key 的 ready 不能被新 key 的刷新误判成「已有数据」
      prevStateRef.current = { kind: "loading" };
    }
    const hadData = !keyChanged && prevStateRef.current.kind === "ready";
    if (hadData) {
      // 同 key 刷新：保留旧数据，标记 refreshing
      setIsRefreshing(true);
    } else {
      // 首次加载、切换区间/实例，或从错误/配置态恢复：全屏 loading
      setIsRefreshing(false);
      setState({ kind: "loading" });
    }

    cache
      .load(cacheKey, () => loaderRef.current())
      .then((result) => {
        if (requestId !== requestIdRef.current) return;
        const newState = toState(result);
        prevStateRef.current = newState;
        setState(newState);
        setIsRefreshing(false);
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        const detail = error instanceof Error ? error.message : String(error);
        const errorState: StatsAsyncState<T> = { kind: "error", message: detail };
        prevStateRef.current = errorState;
        setState(errorState);
        setIsRefreshing(false);
      });
  }, [cache, cacheKey, refreshTick]);

  return { state, isRefreshing };
}
