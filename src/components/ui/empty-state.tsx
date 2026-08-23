import * as React from "react";
import { cn } from "../../lib/utils";

/** 空状态规范（docs/DESIGN.md#空状态）：图标 + 标题 + 描述 + 可选操作 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-fg-secondary">{title}</p>
      {description ? <p className="text-xs leading-relaxed text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
