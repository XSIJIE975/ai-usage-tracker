import { useEffect } from "react";
import { AlertCircle } from "lucide-react";
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
      <div className="flex h-full items-center justify-center bg-canvas">
        {error ? (
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-danger-soft text-danger-soft-fg">
              <AlertCircle className="h-5 w-5" />
            </div>
            <p className="text-[13px] leading-relaxed text-fg-secondary">{error}</p>
            <Button size="sm" variant="secondary" onClick={() => void loadInitial()}>
              重试
            </Button>
          </div>
        ) : (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
        )}
      </div>
    );
  }

  if (!vaultStatus.initialized || !vaultStatus.unlocked) {
    return <VaultScreen />;
  }

  return <Dashboard />;
}
