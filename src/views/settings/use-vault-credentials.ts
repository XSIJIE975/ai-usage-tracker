import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { InstanceCredentialStatus, InstanceCredentials } from "../../types/ipc";

/**
 * 设置页共享的凭据加载：按实例加载凭据与配置状态。
 * 凭据库解锁时加载，凭据/保险库状态变化事件触发重载；未解锁或无实例时清空。
 */
export function useVaultCredentials(unlocked: boolean, instanceId: string | null) {
  const [credentials, setCredentials] = useState<InstanceCredentials | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<InstanceCredentialStatus | null>(null);

  const reload = useCallback(async () => {
    if (!unlocked || !instanceId) {
      setCredentials(null);
      setCredentialStatus(null);
      return;
    }
    try {
      const [stored, status] = await Promise.all([
        invoke<InstanceCredentials>("vault_credentials", { instanceId }),
        invoke<InstanceCredentialStatus>("vault_credential_status", { instanceId }),
      ]);
      setCredentials(stored);
      setCredentialStatus(status);
    } catch {
      setCredentials(null);
      setCredentialStatus(null);
    }
  }, [unlocked, instanceId]);

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
