import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { StoredNotification } from "../types/ipc";

interface NotificationStore {
  items: StoredNotification[];
  loaded: boolean;
  load: () => Promise<void>;
  markAllRead: () => Promise<void>;
  removeOne: (id: number) => Promise<void>;
  clearAll: () => Promise<void>;
  /** 新告警落库后本地插入（避免整表刷新） */
  onAdded: (notification: StoredNotification) => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  items: [],
  loaded: false,

  load: async () => {
    try {
      const items = await invoke<StoredNotification[]>("list_notifications", { limit: 200 });
      set({ items, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  markAllRead: async () => {
    await invoke("mark_all_notifications_read");
    set({ items: get().items.map((item) => ({ ...item, read: true })) });
  },

  removeOne: async (id) => {
    await invoke("delete_notification", { id });
    set({ items: get().items.filter((item) => item.id !== id) });
  },

  clearAll: async () => {
    await invoke("clear_notifications");
    set({ items: [] });
  },

  onAdded: (notification) => {
    set({ items: [notification, ...get().items].slice(0, 200) });
  },
}));

export const selectUnreadCount = (state: NotificationStore): number =>
  state.items.filter((item) => !item.read).length;
