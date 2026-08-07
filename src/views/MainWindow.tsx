import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";
import { VaultScreen } from "./VaultScreen";
import { Dashboard } from "./Dashboard";

export function MainWindow() {
  const { vaultStatus, loadInitial } = useAppStore();

  useEffect(() => {
    void loadInitial();
  }, []);

  if (!vaultStatus) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 text-sm text-slate-400">
        加载中...
      </div>
    );
  }

  if (!vaultStatus.initialized || !vaultStatus.unlocked) {
    return <VaultScreen />;
  }

  return <Dashboard />;
}
