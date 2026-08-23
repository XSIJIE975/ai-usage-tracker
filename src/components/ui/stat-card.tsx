import * as React from "react";
import { Card } from "./card";
import { cn } from "../../lib/utils";

/** 统计指标卡规范：label(xs/muted) + 数值(xl/semibold/tnum) + 可选辅助行 */
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
    <Card className={cn("p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-muted">{label}</span>
        {icon ? <span className="text-fg-muted">{icon}</span> : null}
      </div>
      <div className="tnum mt-1.5 truncate text-xl font-semibold tracking-tight text-fg">{value}</div>
      {hint ? <div className="mt-1 text-xs text-fg-muted">{hint}</div> : null}
    </Card>
  );
}
