import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AlertCoordinator, type AlertCoordinatorDeps } from "../alerts/coordinator";
import type { AlertFire } from "../alerts/evaluate";
import { renderTemplate } from "../i18n/apply-params";
import { resolveLanguage, translateText } from "../i18n/translate";
import type { AppSettings, ProviderInstance, ProviderSnapshot, StoredNotification } from "../types/ipc";
import { currentWindowLabel, useAppStore } from "./useAppStore";
import { useNotificationStore } from "./useNotificationStore";

interface AlertStore {
  /** 处于告警态的实例（驱动托盘图标与快速面板横幅） */
  active: Record<string, boolean>;
  /** 刷新落快照后调用。告警评估只发生在主窗口（ADR-0022）：面板的协调器是各自
   *  webview 的独立副本，边沿/冷却状态互不知晓，放开评估会重复发通知；
   *  面板的告警态经 alert-state-changed 广播同步，纯展示 */
  observe: (instance: ProviderInstance, snapshot: ProviderSnapshot, settings: AppSettings) => void;
  /** 快照收敛后用最新落库快照重跑全部实例评估（ADR-0022）：面板刷出的快照主窗口
   *  也要能触发告警，评估输入是快照事实源的最新投影，「谁刷的」不影响「谁告警」 */
  reevaluate: () => void;
  /** 删除实例后清理协调器的边沿/冷却状态（ADR-0022） */
  prune: (instanceId: string) => void;
}

/** fire 时刻的当前语言：评估的文案出口（系统通知）按事件定格，落库存模板（ADR-0022） */
function currentTranslator(): (text: string) => string {
  const language = resolveLanguage(useAppStore.getState().settings.interfaceLanguage);
  return (text) => translateText(text, language);
}

/** 系统通知：权限未授予时静默请求一次，失败不影响主流程（通知仍会进入通知中心） */
async function sendSystemNotification(fire: AlertFire): Promise<void> {
  if (!isTauri()) return;
  try {
    const t = currentTranslator();
    const title = renderTemplate(fire.title, fire.params, t);
    const body = renderTemplate(fire.body, fire.params, t);
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) await sendNotification({ title, body });
  } catch {
    // 忽略系统通知失败
  }
}

function createCoordinator(): AlertCoordinator {
  const deps: AlertCoordinatorDeps = {
    // 撞满窗口名是含数值的动态模板（「{hours} 小时请求配额」），整串没法当字典键，
    // 在评估时刻按当前语言烘焙进参数；标题/正文的框架文案仍保持模板（ADR-0022）
    translate: () => currentTranslator(),
    notify: (fire) => {
      void invoke<StoredNotification>("add_notification", {
        instanceId: fire.instanceId,
        title: fire.title,
        body: fire.body,
        params: fire.params,
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
    if (currentWindowLabel() !== "main") return;
    coordinator.observe(instance, snapshot, settings.alertsEnabled);
  },
  reevaluate: () => {
    if (currentWindowLabel() !== "main") return;
    const { instances, snapshots, settings } = useAppStore.getState();
    const latest = new Map(snapshots.map((snapshot) => [snapshot.instanceId, snapshot]));
    for (const instance of instances) {
      const snapshot = latest.get(instance.id);
      if (snapshot) coordinator.observe(instance, snapshot, settings.alertsEnabled);
    }
  },
  prune: (instanceId) => {
    coordinator.prune(instanceId);
  },
}));
