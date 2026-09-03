import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOpenCodeHistoryPage } from "../../../providers/opencode-stats";
import type { OpenCodeUsageRecord } from "../../../providers/opencode-stats";
import type { ProviderInstance } from "../../../types/ipc";

export interface HistoryPages {
  records: OpenCodeUsageRecord[];
  currentPage: number;
  hasPrev: boolean;
  hasNext: boolean;
  loading: boolean;
  /** 非空表示最近一次加载失败的原因（中文模板串） */
  errorMessage: string;
  /** errorMessage 模板的占位符实参 */
  errorParams?: Record<string, string | number>;
  /** 失败原因是缺少凭据配置（引导前往设置页） */
  configNeeded: boolean;
  goToPage: (page: number) => void;
  nextPage: () => void;
  prevPage: () => void;
}

/**
 * 使用历史分页：支持前后翻页导航。
 * 每页独立加载（非累加），翻页时替换记录。
 * 递增 requestId 丢弃过期响应，防止翻页竞态。
 * instance 或 refreshTick 变化时回到第 0 页重载。
 */
export const useHistoryPages = (
  instance: ProviderInstance | null,
  refreshTick: number,
): HistoryPages => {
  const [records, setRecords] = useState<OpenCodeUsageRecord[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [errorParams, setErrorParams] = useState<Record<string, string | number> | undefined>(undefined);
  const [configNeeded, setConfigNeeded] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(
    (page: number) => {
      if (!instance) return;
      const requestId = ++requestRef.current;
      setLoading(true);
      setErrorMessage("");
      setErrorParams(undefined);
      fetchOpenCodeHistoryPage(instance, page)
      .then((result) => {
        if (requestId !== requestRef.current) return;
        if (result.status !== "ok") {
          setConfigNeeded(result.status === "needs_config");
          setErrorMessage(result.message);
          setErrorParams(result.params);
          setLoading(false);
          return;
        }
        setRecords(result.data.records);
        setCurrentPage(page);
        // 返回了记录 → 还有下一页；空数组 → 没有更多
        setHasNext(result.data.records.length > 0);
        setConfigNeeded(false);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (requestId !== requestRef.current) return;
        setConfigNeeded(false);
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setErrorParams(undefined);
        setLoading(false);
      });
  }, [instance]);

  useEffect(() => {
    load(0);
  }, [load, refreshTick]);

  const goToPage = useCallback(
    (page: number) => {
      if (page < 0 || loading) return;
      load(page);
    },
    [load, loading],
  );

  const nextPage = useCallback(() => {
    if (loading || !hasNext) return;
    load(currentPage + 1);
  }, [load, loading, hasNext, currentPage]);

  const prevPage = useCallback(() => {
    if (loading || currentPage === 0) return;
    load(currentPage - 1);
  }, [load, loading, currentPage]);

  return {
    records,
    currentPage,
    hasPrev: currentPage > 0,
    hasNext,
    loading,
    errorMessage,
    errorParams,
    configNeeded,
    goToPage,
    nextPage,
    prevPage,
  };
};
