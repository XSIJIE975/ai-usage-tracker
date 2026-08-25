import { useEffect, useRef, useState } from "react";
import type { StatsResult } from "../../providers/stats-result";
import type { UsageCache } from "../../stats/usage-cache";
import type { StatsAsyncState } from "./StatsStateCard";

const toState = <T,>(result: StatsResult<T>): StatsAsyncState<T> => {
  if (result.status === "ok") return { kind: "ready", data: result.data };
  if (result.status === "needs_config") return { kind: "needs_config", message: result.message };
  return { kind: "error", message: result.message };
};

/**
 * 统计取数 hook：UsageCache 记忆 + 三态收敛 + 递增 requestId 竞态防护。
 * cacheKey 为 null 时不拉取（保持 loading）；refreshTick 自增触发强制刷新。
 * loader 经 ref 中转，避免内联闭包身份变化导致 effect 反复执行。
 */
export const useStatsFetch = <T,>(
  cache: UsageCache,
  cacheKey: string | null,
  loader: () => Promise<StatsResult<T>>,
  refreshTick: number,
): StatsAsyncState<T> => {
  const [state, setState] = useState<StatsAsyncState<T>>({ kind: "loading" });
  const requestIdRef = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (cacheKey === null) return;
    const requestId = ++requestIdRef.current;
    setState({ kind: "loading" });
    cache
      .load(cacheKey, () => loaderRef.current())
      .then((result) => {
        if (requestId === requestIdRef.current) setState(toState(result));
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        const detail = error instanceof Error ? error.message : String(error);
        setState({ kind: "error", message: detail });
      });
  }, [cache, cacheKey, refreshTick]);

  return state;
};
