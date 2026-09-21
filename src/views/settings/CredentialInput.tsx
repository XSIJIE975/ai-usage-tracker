import { useState, type CSSProperties } from "react";
import { Check, Eye, EyeOff, X } from "lucide-react";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import { useT } from "../../i18n";

interface SecretFieldProps {
  id: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  /** 多行形态：整段 Copy as cURL 这类长凭据要能看清上下文（单行 input 粘贴还会吃掉换行） */
  multiline?: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  clearDisabled?: boolean;
}

export function SecretField({
  id,
  value,
  placeholder,
  disabled = false,
  multiline = false,
  onChange,
  onClear,
  clearDisabled = false,
}: SecretFieldProps) {
  const [visible, setVisible] = useState(false);
  const t = useT();
  // 多行框没有 type=password，改用 -webkit-text-security 遮蔽（WebView2 即 Chromium）
  const mask = multiline && !visible ? ({ WebkitTextSecurity: "disc" } as CSSProperties) : undefined;
  const fieldClassName = cn(
    "w-full rounded-md border border-line bg-surface text-sm text-fg shadow-sm transition-colors",
    "placeholder:text-fg-muted hover:border-line-strong focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
    multiline
      ? "block resize-y px-3 py-2 font-mono text-[13px] leading-relaxed"
      : "flex h-9 px-3 font-mono text-[13px]",
  );

  return (
    <div className="relative">
      {multiline ? (
        <textarea
          id={id}
          rows={4}
          value={value}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          style={mask}
          className={cn(fieldClassName, "pr-10")}
          placeholder={placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          autoComplete="off"
          disabled={disabled}
          className="h-9 pr-16 font-mono text-[13px]"
          placeholder={placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        disabled={disabled}
        className={cn(
          "absolute right-8 flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40",
          multiline ? "top-2" : "top-1/2 -translate-y-1/2",
        )}
        title={visible ? t("隐藏") : t("显示")}
        aria-label={visible ? t("隐藏") : t("显示")}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={disabled || clearDisabled}
        className={cn(
          "absolute right-1 flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-danger-soft hover:text-danger-soft-fg disabled:pointer-events-none disabled:opacity-40",
          multiline ? "top-2" : "top-1/2 -translate-y-1/2",
        )}
        title={t("清除")}
        aria-label={t("清除")}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function StatusBadge({ configured }: { configured: boolean }) {
  const t = useT();
  return configured ? (
    <Badge variant="success">
      <Check className="h-3 w-3" /> {t("已配置")}
    </Badge>
  ) : (
    <Badge variant="neutral">{t("未配置")}</Badge>
  );
}
