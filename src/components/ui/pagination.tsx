import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * 分页器组件（docs/DESIGN.md#数据表格）：
 * 上一页 / 页码 / 下一页，适配明暗主题。
 * 当总页数未知时（增量分页），仅显示当前页号 + 前后翻页按钮。
 */
export function Pagination({
  currentPage,
  totalPages,
  hasPrev,
  hasNext,
  loading,
  onPageChange,
  className,
}: {
  currentPage: number;
  /** 已知总页数时传入；未知传 undefined 仅显示当前页号 */
  totalPages?: number;
  hasPrev: boolean;
  hasNext: boolean;
  loading?: boolean;
  onPageChange: (page: number) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-center gap-4 pt-1", className)}>
      <button
        type="button"
        disabled={!hasPrev || loading}
        onClick={() => onPageChange(currentPage - 1)}
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-md border border-line px-2.5 text-[13px] text-fg-secondary shadow-sm transition-colors",
          "hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        )}
        aria-label="上一页"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        上一页
      </button>

      <span className="tnum text-[13px] text-fg-muted">
        第 {currentPage + 1} 页
        {totalPages !== undefined ? ` / ${totalPages}` : ""}
      </span>

      <button
        type="button"
        disabled={!hasNext || loading}
        onClick={() => onPageChange(currentPage + 1)}
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-md border border-line px-2.5 text-[13px] text-fg-secondary shadow-sm transition-colors",
          "hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        )}
        aria-label="下一页"
      >
        下一页
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
