import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { VaultScreen } from "./VaultScreen";
import { Dashboard } from "./Dashboard";

export function MainWindow() {
  const { vaultStatus, error, loadInitial } = useAppStore();

  useEffect(() => {
    void loadInitial();
  }, []);

  if (!vaultStatus) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 text-sm text-slate-400">
        {error ? (
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <p className="text-amber-700">{error}</p>
            <Button size="sm" variant="secondary" onClick={() => void loadInitial()}>
              重试
            </Button>
          </div>
        ) : (
          "加载中..."
        )}
      </div>
    );
  }

  if (!vaultStatus.initialized || !vaultStatus.unlocked) {
    return <VaultScreen />;
  }

  return <Dashboard />;
}
