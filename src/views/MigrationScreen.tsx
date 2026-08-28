import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, KeyRound } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

interface MigrationScreenProps {
  onSkip: () => void;
}

export function MigrationScreen({ onSkip }: MigrationScreenProps) {
  const { loadInitial, error, clearError } = useAppStore();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit() {
    setFormError("");
    setBusy(true);
    try {
      await invoke("vault_migrate", { password });
      clearError();
      await loadInitial();
    } catch (invokeError) {
      setFormError(invokeError instanceof Error ? invokeError.message : String(invokeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-iris-400 to-iris-600 text-white shadow-pop">
            <KeyRound className="h-5 w-5" />
          </div>
          <h1 className="mt-4 text-lg font-semibold tracking-tight text-fg">AI 用量助手</h1>
          <p className="mt-1 text-[13px] text-fg-muted">一次性凭据库迁移</p>
        </div>

        <Card className="shadow-pop">
          <CardHeader className="pb-4">
            <CardTitle>凭据库迁移</CardTitle>
            <CardDescription>
              凭据加密方式已升级为本机设备密钥。请最后一次输入旧主密码完成迁移，之后启动不再需要密码。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="migration-password">旧主密码</Label>
              <Input
                id="migration-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
                autoFocus
              />
            </div>
            {(formError || error) && (
              <p className="flex items-start gap-2 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger-soft-fg">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {formError || error}
              </p>
            )}
            <Button className="w-full" disabled={busy || !password} onClick={submit}>
              {busy ? "迁移中..." : "完成迁移"}
            </Button>
          </CardContent>
        </Card>

        <div className="mt-4 text-center">
          <button
            type="button"
            className="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            onClick={onSkip}
          >
            稍后再说（可在设置中补做迁移）
          </button>
        </div>
      </div>
    </div>
  );
}
