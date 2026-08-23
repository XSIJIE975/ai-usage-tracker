import * as React from "react";
import { Card } from "./card";
import { cn } from "../../lib/utils";

/** 统计指标卡规范：label(xs/muted) + 数值(xl/semibold/tnum) + 可选辅助行；图标置于 brand-soft 圆角块中 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("p-4 transition-shadow duration-normal hover:shadow-pop", className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-xs text-fg-muted">{label}</span>
          <div className="tnum mt-1.5 truncate text-xl font-semibold tracking-tight text-fg">{value}</div>
          {hint ? <div className="mt-1 text-xs text-fg-muted">{hint}</div> : null}
        </div>
        {icon ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
            {icon}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
