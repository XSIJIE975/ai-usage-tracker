import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";

/** 即时保存后的短暂成功反馈，约 2 秒自动消失 */
export function useSaveFlash(durationMs = 2_000) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const flash = useCallback(() => {
    setVisible(true);
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setVisible(false), durationMs);
  }, [durationMs]);

  return { visible, flash };
}

export function SavedHint({ visible }: { visible: boolean }) {
  return (
    <span
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1 text-xs text-success transition-opacity duration-normal",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <Check className="h-3.5 w-3.5" /> 已保存
    </span>
  );
}
