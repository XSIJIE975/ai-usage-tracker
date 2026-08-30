import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

/**
 * 下拉选择规范（docs/DESIGN.md#下拉选择）：
 * 原生 select 封装，保证键盘可达与系统级交互；禁止自绘弹出层。
 */
export interface SelectProps<T extends string = string>
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function Select<T extends string = string>({
  options,
  value,
  onChange,
  className,
  ...props
}: SelectProps<T>) {
  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className={cn(
          "h-9 appearance-none rounded-md border border-line bg-surface pl-3 pr-8 text-[13px] text-fg shadow-sm transition-colors",
          "hover:border-line-strong focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-focus-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-fg-muted" aria-hidden />
    </span>
  );
}
