import * as React from "react";
import { Label } from "./label";
import { cn } from "../../lib/utils";

/**
 * 表单字段原语：把「控件 + 标签 + 提示 + 错误」这组结构收敛到一处，
 * 顺带保证无障碍属性（data-invalid / role=alert）不会每个字段各写一遍、各漏一个。
 * 不接管状态——值的读写与校验结果由调用方（表单层）传入。
 */

export function Field({
  invalid = false,
  className,
  children,
}: {
  invalid?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-invalid={invalid || undefined} className={cn("space-y-2.5", className)}>
      {children}
    </div>
  );
}

/** 必填以前置星号标记（纯视觉，读屏由失败提交时的错误播报承担） */
export function FieldLabel({
  htmlFor,
  required = false,
  className,
  children,
}: {
  htmlFor?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Label htmlFor={htmlFor} className={className}>
      {required && (
        <span aria-hidden className="mr-1 text-danger">
          *
        </span>
      )}
      {children}
    </Label>
  );
}

export function FieldDescription({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p id={id} className={cn("text-xs leading-relaxed text-fg-muted", className)}>
      {children}
    </p>
  );
}

/**
 * 字段级错误。只在错误出现的那一刻挂载，配合 role=alert 让读屏播报一次；
 * 逐键触发校验时不常驻挂载，否则每敲一个字都刷屏。
 */
export function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs leading-relaxed text-danger-soft-fg">
      {children}
    </p>
  );
}
