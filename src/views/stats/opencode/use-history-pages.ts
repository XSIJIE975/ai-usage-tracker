import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOpenCodeHistoryPage } from "../../../providers/opencode-stats";
import type { OpenCodeUsageRecord } from "../../../providers/opencode-stats";

export interface HistoryPages {
  records: OpenCodeUsageRecord[];
  hasMore: boolean;
  loading: boolean;
  /** 非空表示最近一次加载失败的原因 */
  errorMessage: string;
  /** 失败原因是缺少凭据配置（引导前往设置页） */
  configNeeded: boolean;
  loadMore: () => void;
}

/**
 * 使用历史分页：本地 state 累加各页记录（不做缓存键控）。
 * 挂载与 refreshTick 变化时重置回第 0 页；某页返回空数组后 hasMore=false。
 * 递增 requestId 丢弃过期响应，防止翻页/刷新竞态错序追加。
 */
export const useHistoryPages = (refreshTick: number): HistoryPages => {
  const [records, setRecords] = useState<OpenCodeUsageRecord[]>([]);
  const [nextPage, setNextPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [configNeeded, setConfigNeeded] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback((page: number, append: boolean) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setErrorMessage("");
    fetchOpenCodeHistoryPage(page)
      .then((result) => {
        if (requestId !== requestRef.current) return;
        if (result.status !== "ok") {
          setConfigNeeded(result.status === "needs_config");
          setErrorMessage(result.message);
          setLoading(false);
          return;
        }
        setRecords((prev) => (append ? [...prev, ...result.data.records] : result.data.records));
        setNextPage(page + 1);
        setHasMore(result.data.records.length > 0);
        setConfigNeeded(false);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (requestId !== requestRef.current) return;
        setConfigNeeded(false);
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load(0, false);
  }, [load, refreshTick]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || configNeeded) return;
    load(nextPage, true);
  }, [load, loading, hasMore, configNeeded, nextPage]);

  return { records, hasMore, loading, errorMessage, configNeeded, loadMore };
};
