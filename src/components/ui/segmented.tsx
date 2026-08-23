import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

/**
 * 分段选择器规范（docs/DESIGN.md#分段选择器）：
 * 用于同层级 2-4 个视图的互斥切换（如 总览/设置、外观主题）。
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  size = "md",
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-2 p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] font-medium transition-all duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              size === "md" ? "px-3 py-1.5 text-xs" : "px-2 py-1 text-xs",
              active
                ? "bg-surface text-fg shadow-sm"
                : "text-fg-muted hover:text-fg-secondary",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
