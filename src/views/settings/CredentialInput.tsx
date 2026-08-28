import { useState } from "react";
import { Check, Eye, EyeOff, X } from "lucide-react";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";

interface SecretFieldProps {
  id: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  clearDisabled?: boolean;
}

export function SecretField({
  id,
  value,
  placeholder,
  disabled = false,
  onChange,
  onClear,
  clearDisabled = false,
}: SecretFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        autoComplete="off"
        disabled={disabled}
        className="pr-16 font-mono text-[13px]"
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        disabled={disabled}
        className="absolute right-8 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        title={visible ? "隐藏" : "显示"}
        aria-label={visible ? "隐藏" : "显示"}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={disabled || clearDisabled}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-danger-soft hover:text-danger-soft-fg disabled:pointer-events-none disabled:opacity-40"
        title="清除"
        aria-label="清除"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function StatusBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <Badge variant="success">
      <Check className="h-3 w-3" /> 已配置
    </Badge>
  ) : (
    <Badge variant="neutral">未配置</Badge>
  );
}
