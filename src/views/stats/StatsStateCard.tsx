import { AlertTriangle, KeyRound, LoaderCircle } from "lucide-react";
import { Card } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";

export type StatsAsyncState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "needs_config"; message: string }
  | { kind: "error"; message: string };

/**
 * 统计模块异步三态卡片：
 * loading 轻量占位 / needs_config 引导前往设置页配置凭据 / error 展示原因并可重试。
 */
export function StatsStateCard<T>({ state, onRetry }: { state: StatsAsyncState<T>; onRetry?: () => void }) {
  if (state.kind === "loading") {
    return (
      <Card className="flex items-center justify-center gap-2 p-10 text-[13px] text-fg-muted">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        正在加载用量数据…
      </Card>
    );
  }

  if (state.kind === "needs_config") {
    return (
      <Card className="p-5">
        <EmptyState
          icon={<KeyRound className="h-5 w-5" />}
          title={state.message}
          description="请前往设置页配置对应凭据后回来重试。"
        />
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card className="p-5">
        <EmptyState
          icon={<AlertTriangle className="h-5 w-5" />}
          title="用量数据加载失败"
          description={state.message}
          action={
            onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                重试
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return null;
}
