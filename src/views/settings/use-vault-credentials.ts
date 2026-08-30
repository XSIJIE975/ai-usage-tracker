import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CredentialStatus, VaultCredentials } from "../../types/ipc";

/**
 * 设置页共享的凭据加载：页签状态点与各供应商表单复用同一份数据。
 * 凭据库解锁时加载，凭据/保险库状态变化事件触发重载；未解锁时清空。
 */
export function useVaultCredentials(unlocked: boolean) {
  const [credentials, setCredentials] = useState<VaultCredentials | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);

  const reload = useCallback(async () => {
    if (!unlocked) {
      setCredentials(null);
      setCredentialStatus(null);
      return;
    }
    try {
      const [stored, status] = await Promise.all([
        invoke<VaultCredentials>("vault_credentials"),
        invoke<CredentialStatus>("vault_credential_status"),
      ]);
      setCredentials(stored);
      setCredentialStatus(status);
    } catch {
      setCredentials(null);
      setCredentialStatus(null);
    }
  }, [unlocked]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    void (async () => {
      const unlistenCredentials = await listen("credentials-changed", () => {
        if (!disposed) void reload();
      });
      const unlistenVault = await listen("vault-status-changed", () => {
        if (!disposed) void reload();
      });
      if (disposed) {
        unlistenCredentials();
        unlistenVault();
        return;
      }
      unlisteners.push(unlistenCredentials, unlistenVault);
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [reload]);

  return { credentials, credentialStatus, reload };
}
