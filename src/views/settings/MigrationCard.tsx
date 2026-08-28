import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, KeyRound } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

export function MigrationCard() {
  const { loadInitial } = useAppStore();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit() {
    setFormError("");
    setBusy(true);
    try {
      await invoke("vault_migrate", { password });
      await loadInitial();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-warning" /> 凭据库迁移
        </CardTitle>
        <CardDescription>
          凭据加密方式已升级为本机设备密钥。最后一次输入旧主密码完成迁移，之后启动不再需要密码。
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
          />
        </div>
        {formError && (
          <p className="flex items-start gap-2 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger-soft-fg">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {formError}
          </p>
        )}
        <Button disabled={busy || !password} onClick={() => void submit()}>
          {busy ? "迁移中..." : "完成迁移"}
        </Button>
      </CardContent>
    </Card>
  );
}
