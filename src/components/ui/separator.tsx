import { cn } from "../../lib/utils";

/** 分隔线规范：卡片内部模块之间使用，勿用大留白 + 分隔线叠加 */
export function Separator({ className }: { className?: string }) {
  return <div role="separator" className={cn("h-px w-full bg-line", className)} />;
}
