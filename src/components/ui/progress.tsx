import { cn } from "../../lib/utils";

/** 进度条规范（docs/DESIGN.md#进度条）：默认 brand，≥70% warning，≥90% danger */
export function Progress({
  value,
  className,
  barClassName,
}: {
  value: number;
  className?: string;
  barClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}>
      <div
        className={cn("h-full rounded-full bg-brand transition-[width] duration-normal", barClassName)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
