import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * 数据表格规范（docs/DESIGN.md#数据表格）：
 * 表头 xs/muted，数值右对齐 + tnum，行分隔用 line，末行不加分隔线。
 * 传入 maxHeight 时启用内部垂直滚动 + 粘性表头。
 */
export function DataTable({
  className,
  maxHeight,
  viewportRef,
  ...props
}: React.HTMLAttributes<HTMLTableElement> & {
  maxHeight?: number | string;
  /** 滚动容器 ref，供外部在翻页等场景重置滚动位置 */
  viewportRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={viewportRef}
      className={cn("overflow-x-auto", maxHeight !== undefined && "overflow-y-auto")}
      style={maxHeight !== undefined ? { maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight } : undefined}
    >
      <table className={cn("w-full border-collapse text-[13px]", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("[&_th]:border-b [&_th]:border-line [&_th]:bg-surface [&_th]:sticky [&_th]:top-0 [&_th]:z-10", className)}
      {...props}
    />
  );
}

export function Th({
  className,
  align = "left",
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center" }) {
  return (
    <th
      className={cn(
        "whitespace-nowrap pb-2.5 pr-4 text-xs font-medium text-fg-muted last:pr-0",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&_tr:last-child_td]:border-b-0", className)} {...props} />;
}

export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors hover:bg-surface-2/50", className)} {...props} />;
}

export function Td({
  className,
  align = "left",
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center" }) {
  return (
    <td
      className={cn(
        "border-b border-line/70 py-2.5 pr-4 text-fg last:pr-0",
        align === "right" ? "tnum text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
      {...props}
    />
  );
}
