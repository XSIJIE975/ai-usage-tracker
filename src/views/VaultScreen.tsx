import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, KeyRound, ShieldCheck } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import type { VaultStatus } from "../types/ipc";

export function VaultScreen() {
  const { vaultStatus, setVaultStatus, loadInitial, error, clearError } = useAppStore();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const initialized = vaultStatus?.initialized ?? false;

  async function submit() {
    setFormError("");
    setBusy(true);
    try {
      if (!initialized) {
        if (password.length < 6) {
          setFormError("主密码至少 6 位");
          return;
        }
        if (password !== confirm) {
          setFormError("两次输入的主密码不一致");
          return;
        }
        await invoke("vault_init", { password });
      } else {
        await invoke("vault_unlock", { password });
      }
      const status = await invoke<VaultStatus>("vault_status");
      setVaultStatus(status);
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
            {initialized ? <KeyRound className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
          </div>
          <h1 className="mt-4 text-lg font-semibold tracking-tight text-fg">AI 用量助手</h1>
          <p className="mt-1 text-[13px] text-fg-muted">本机加密凭据库</p>
        </div>

        <Card className="shadow-pop">
          <CardHeader className="pb-4">
            <CardTitle>{initialized ? "解锁 Credential Vault" : "创建 Credential Vault"}</CardTitle>
            <CardDescription>
              {initialized
                ? "输入主密码解锁本机加密凭据。"
                : "设置一个主密码，用于加密本机保存的所有 Provider 凭据和敏感配置。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">主密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && initialized) submit();
                }}
                autoFocus
              />
            </div>
            {!initialized && (
              <div className="space-y-2">
                <Label htmlFor="confirm">确认主密码</Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submit();
                  }}
                />
              </div>
            )}
            {(formError || error) && (
              <p className="flex items-start gap-2 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger-soft-fg">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {formError || error}
              </p>
            )}
            <Button className="w-full" disabled={busy || !password} onClick={submit}>
              {busy ? "处理中..." : initialized ? "解锁" : "创建并解锁"}
            </Button>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs leading-relaxed text-fg-muted">
          凭据仅保存在本机，使用主密码加密，不会上传到任何服务器。
        </p>
      </div>
    </div>
  );
}
