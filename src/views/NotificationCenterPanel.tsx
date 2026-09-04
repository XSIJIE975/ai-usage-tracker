import { useEffect, useMemo } from "react";
import { Bell, CheckCheck, Trash2, TriangleAlert } from "lucide-react";
import { cn, formatClock } from "../lib/utils";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { useNotificationStore } from "../store/useNotificationStore";
import { useT } from "../i18n";

const DAY_MS = 86_400_000;
const localMidnight = (ts: number) => new Date(new Date(ts).setHours(0, 0, 0, 0)).getTime();

/** 相对时间：1 小时内显示"X 分钟前"，当天显示"HH:mm"，否则显示"M月D日" */
function relativeTime(ts: number, t: (s: string) => string): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return t("刚刚");
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} ${t("分钟前")}`;
  if (delta < DAY_MS) return formatClock(ts);
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(ts));
}

function dayLabel(ts: number, t: (s: string) => string): string {
  const today = localMidnight(Date.now());
  const day = localMidnight(ts);
  if (day === today) return t("今天");
  if (day === today - DAY_MS) return t("昨天");
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(ts));
}

/**
 * 通知中心面板：按日分组的时间线，未读高亮，支持全部已读/单条删除/清空。
 * 历史通知落库（30 天 / 200 条），跨重启保留。
 * inline 模式用于快速面板内嵌展示（填满容器），默认为主窗口顶栏下拉。
 */
export function NotificationCenterPanel({
  onClose,
  inline = false,
}: {
  onClose: () => void;
  inline?: boolean;
}) {
  const { items, loaded, load, markAllRead, removeOne, clearAll } = useNotificationStore();
  const t = useT();
  const unread = useMemo(() => items.filter((item) => !item.read).length, [items]);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof items>();
    for (const item of items) {
      const label = dayLabel(item.created_at, t);
      const list = map.get(label) ?? [];
      list.push(item);
      map.set(label, list);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-pop",
        // inline（快速面板）：高度随内容自适应，上限留出顶栏空间后内部滚动；
        // 主窗口：顶栏下方的固定宽度下拉
        inline
          ? "max-h-[min(480px,calc(100vh-4rem))] w-full"
          : "absolute right-0 top-full z-30 mt-2 max-h-[380px] w-[360px]",
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
          {t("通知中心")}
          {unread > 0 && (
            <span className="tnum rounded-full bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand">
              {unread} {t("条未读")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            onClick={() => void markAllRead()}
            disabled={unread === 0}
            title={t("全部已读")}
            aria-label={t("全部已读")}
          >
            <CheckCheck className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            size="sm"
            onClick={() => void clearAll()}
            disabled={items.length === 0}
            title={t("清空")}
            aria-label={t("清空")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className={cn("overflow-y-auto", inline ? "min-h-0 flex-1" : "max-h-[380px]")}>
        {!loaded ? (
          <p className="px-4 py-8 text-center text-xs text-fg-muted">{t("加载中…")}</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <Bell className="h-5 w-5 text-fg-muted" />
            <p className="text-[13px] text-fg-secondary">{t("暂无通知")}</p>
            <p className="text-xs leading-relaxed text-fg-muted">
              {t("开启用量告警后，额度异常会出现在这里")}
            </p>
          </div>
        ) : (
          groups.map(([label, list]) => (
            <div key={label}>
              <p className="sticky top-0 bg-surface px-4 py-1.5 text-[11px] font-medium text-fg-muted">
                {t(label)}
              </p>
              {list.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "group flex items-start gap-2.5 border-b border-line/60 px-4 py-2.5 last:border-b-0",
                    !item.read && "bg-brand/[0.04]",
                  )}
                >
                  <TriangleAlert
                    className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", item.read ? "text-fg-muted" : "text-warning")}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "truncate text-[13px]",
                        item.read ? "text-fg-secondary" : "font-medium text-fg",
                      )}
                      title={item.title}
                    >
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{item.body}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="tnum text-[11px] text-fg-muted">{relativeTime(item.created_at, t)}</span>
                    <button
                      type="button"
                      onClick={() => void removeOne(item.id)}
                      className="text-[11px] text-fg-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                      aria-label={t("删除")}
                    >
                      {t("删除")}
                    </button>
                  </div>
                  {!item.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {items.length > 0 || inline ? (
        <div className="border-t border-line px-4 py-2">
          <Button variant="ghost" size="sm" className="w-full" onClick={onClose}>
            {t("关闭")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
