import { cn } from "../../lib/utils";

export interface TabItem<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

/**
 * 下划线式标签页规范（docs/DESIGN.md#标签页）：
 * 用于页面级模块切换（如统计页的供应商模块）。
 * 与 Segmented 的区别：Tabs 切换的是整页内容模块，Segmented 切换的是小范围选项。
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex items-center gap-1 border-b border-line", className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              "relative -mb-px inline-flex items-center gap-1.5 border-b-2 px-3.5 pb-2.5 pt-1 text-[13px] font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              active
                ? "border-brand text-fg"
                : "border-transparent text-fg-muted hover:border-line-strong hover:text-fg-secondary",
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
