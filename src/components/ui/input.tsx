import * as React from "react";
import { cn } from "../../lib/utils";

/** 输入框规范（docs/DESIGN.md#表单）：surface 底，聚焦时 brand 描边 + 焦点环 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg shadow-sm transition-colors placeholder:text-fg-muted hover:border-line-strong focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
