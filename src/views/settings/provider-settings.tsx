import { AlertCircle, CheckCircle2 } from "lucide-react";

export type SaveMessage = { kind: "success" | "error"; text: string } | null;

/** 表单内联的保存结果提示（InstanceDialog 使用） */
export function SaveMessageBanner({ message }: { message: SaveMessage }) {
  if (!message) return null;
  return message.kind === "success" ? (
    <p className="flex items-center gap-2 rounded-md border border-success/20 bg-success-soft px-3 py-2 text-[13px] text-success-soft-fg">
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      {message.text}
    </p>
  ) : (
    <p className="flex items-start gap-2 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger-soft-fg">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      {message.text}
    </p>
  );
}
