import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * 图标按钮规范（docs/DESIGN.md#图标按钮）：
 * 工具区/卡片角落的纯图标操作，必须提供 aria-label / title。
 */
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "sm" | "md";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, size = "md", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-fast hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-40",
        size === "md" ? "h-8 w-8" : "h-6 w-6",
        className,
      )}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";
