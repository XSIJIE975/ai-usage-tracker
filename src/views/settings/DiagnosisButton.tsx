import { useState } from "react";
import { LoaderCircle, PlugZap } from "lucide-react";
import { describeDiagnosis, type DiagnosisResult } from "../../diagnostics";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { useT } from "../../i18n";

/** 凭据连通性测试按钮：点击真实探测，结果内联展示（成功带延迟，失败带原因） */
export function DiagnosisButton({
  test,
  disabled,
  onBefore,
}: {
  test: () => Promise<DiagnosisResult>;
  disabled?: boolean;
  /** 点击测试前回调（如清除上一次结果） */
  onBefore?: () => void;
}) {
  const [running, setRunning] = useState(false);
  const t = useT();
  const [result, setResult] = useState<DiagnosisResult | null>(null);

  async function run() {
    onBefore?.();
    setRunning(true);
    try {
      setResult(await test());
    } catch (error) {
      setResult({
        ok: false,
        status: 0,
        latencyMs: 0,
        code: "unknown",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" disabled={disabled || running} onClick={() => void run()}>
        {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
        {t("测试")}
      </Button>
      {running && <span className="text-xs text-fg-muted">{t("测试中…")}</span>}
      {result && (
        <span
          className={cn(
            "text-xs leading-relaxed",
            result.ok ? "text-success" : "text-danger",
          )}
        >
          {result.ok ? "✓ " : "✗ "}
          {describeDiagnosis(result, t)}
        </span>
      )}
    </div>
  );
}
