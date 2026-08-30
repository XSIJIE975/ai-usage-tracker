import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AlertCoordinator, type AlertCoordinatorDeps } from "../alerts/coordinator";
import type { AlertFire } from "../alerts/evaluate";
import type { AppSettings, ProviderSnapshot, StoredNotification } from "../types/ipc";
import { useNotificationStore } from "./useNotificationStore";

interface AlertStore {
  /** 处于告警态的供应商（驱动托盘图标与快速面板横幅） */
  active: Record<string, boolean>;
  /** 刷新落快照后调用 */
  observe: (providerId: string, snapshot: ProviderSnapshot, settings: AppSettings) => void;
}

/** 系统通知：权限未授予时静默请求一次，失败不影响主流程（通知仍会进入通知中心） */
async function sendSystemNotification(fire: AlertFire): Promise<void> {
  if (!isTauri()) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) await sendNotification({ title: fire.title, body: fire.body });
  } catch {
    // 忽略系统通知失败
  }
}

function createCoordinator(): AlertCoordinator {
  const deps: AlertCoordinatorDeps = {
    notify: (fire) => {
      void invoke<StoredNotification>("add_notification", {
        providerId: fire.providerId,
        title: fire.title,
        body: fire.body,
      })
        .then((stored) => useNotificationStore.getState().onAdded(stored))
        .catch(() => undefined);
      void sendSystemNotification(fire);
    },
    onActiveChange: (providerId, active) => {
      useAlertStore.setState((state) => ({
        active: { ...state.active, [providerId]: active },
      }));
    },
  };
  return new AlertCoordinator(deps);
}

const coordinator = createCoordinator();

export const useAlertStore = create<AlertStore>(() => ({
  active: {},
  observe: (providerId, snapshot, settings) => {
    coordinator.observe(providerId, snapshot, settings);
  },
}));
