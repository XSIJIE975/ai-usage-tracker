import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AlertCoordinator, type AlertCoordinatorDeps } from "../alerts/coordinator";
import type { AlertFire } from "../alerts/evaluate";
import type { AppSettings, ProviderInstance, ProviderSnapshot, StoredNotification } from "../types/ipc";
import { useNotificationStore } from "./useNotificationStore";

interface AlertStore {
  /** 处于告警态的实例（驱动托盘图标与快速面板横幅） */
  active: Record<string, boolean>;
  /** 刷新落快照后调用 */
  observe: (instance: ProviderInstance, snapshot: ProviderSnapshot, settings: AppSettings) => void;
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
        instanceId: fire.instanceId,
        title: fire.title,
        body: fire.body,
      })
        .then((stored) => useNotificationStore.getState().onAdded(stored))
        .catch(() => undefined);
      void sendSystemNotification(fire);
    },
    onActiveChange: (instanceId, active) => {
      useAlertStore.setState((state) => ({
        active: { ...state.active, [instanceId]: active },
      }));
      // 同步其他窗口（快速面板/主窗口各自独立 webview 上下文）
      void emit("alert-state-changed", { instanceId, active }).catch(() => undefined);
    },
  };
  return new AlertCoordinator(deps);
}

const coordinator = createCoordinator();

export const useAlertStore = create<AlertStore>(() => ({
  active: {},
  observe: (instance, snapshot, settings) => {
    coordinator.observe(instance, snapshot, settings.alertsEnabled);
  },
}));
