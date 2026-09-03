import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { useT } from "../i18n";

/**
 * 异常详情弹窗：展示供应商接口返回的原始报错全文。
 * 宽度钳制到视口内（快速面板 380px 视口也能完整容纳）。
 */
export function ErrorDetailsDialog({
  open,
  onOpenChange,
  title,
  message,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 来源实例显示名（弹窗描述行） */
  title: string;
  message: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // 剪贴板不可用时静默：原文仍可在弹窗内选中复制
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{t("异常详情")}</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed text-fg-secondary">
            {message}
          </pre>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("已复制") : t("复制")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            {t("关闭")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
