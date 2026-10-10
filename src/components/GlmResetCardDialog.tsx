import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { applyParams, useT } from "../i18n";
import { cn } from "../lib/utils";
import {
  RESET_CARD_UNAVAILABLE_MSG,
  fetchGlmResetCards,
  useGlmResetCard,
  type GlmResetCardList,
  type GlmResetType,
} from "../providers/glm-stats";

interface PendingUse {
  resetType: GlmResetType;
  recordId: number;
  expireTime: string;
  windowLabel: string;
}

/** 弹窗内单个窗口组（官网同款）：边框盒 + 组头可用数 + 两行式卡目（名称/有效期），可用卡带「使用」 */
function ResetGroup({
  title,
  group,
  resetType,
  windowLabel,
  disabled,
  onSelect,
}: {
  title: string;
  group: GlmResetCardList["fiveHour"];
  resetType: GlmResetType;
  windowLabel: string;
  disabled: boolean;
  onSelect: (pending: PendingUse) => void;
}) {
  const t = useT();
  const firstUsable = group.items.findIndex(
    (item) => item.status === "available" && item.recordId != null,
  );
  return (
    <section className="rounded-lg border border-line p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
          <span className="h-2 w-2 rounded-full bg-brand" aria-hidden />
          {title}
        </span>
        <Badge variant="neutral">{applyParams(t("可用{count}次"), { count: group.available })}</Badge>
      </div>
      {group.items.length > 0 && (
        <ul className="mt-1 divide-y divide-line">
          {group.items.map((item, index) => {
            const usable = item.status === "available" && item.recordId != null;
            return (
              <li key={`${item.expireTime}-${index}`} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg">
                    {t("1次重置")}
                    {usable && index === firstUsable && (
                      <Badge variant="warning">{t("优先")}</Badge>
                    )}
                  </span>
                  {usable ? (
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        onSelect({
                          resetType,
                          recordId: item.recordId!,
                          expireTime: item.expireTime,
                          windowLabel,
                        })
                      }
                    >
                      {t("使用")}
                    </Button>
                  ) : (
                    <Badge variant="neutral">
                      {t(item.status === "expired" ? "已过期" : "已使用")}
                    </Badge>
                  )}
                </div>
                <div className="tnum mt-0.5 text-xs text-fg-muted">
                  {applyParams(t("有效期至 {time}"), { time: item.expireTime })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 取数失败的瞬时态：存中文模板 + 实参，渲染端翻译（语言中途切换也对） */
interface Failure {
  message: string;
  params?: Record<string, string | number>;
}

/** 弹窗内的黄条提示（取数失败与使用失败共用一处出口）：文案 + 重取列表 */
function NoticeBar({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-warning-soft px-3 py-2">
      <span className="min-w-0 text-xs text-warning-soft-fg">
        {applyParams(t(failure.message), failure.params)}
      </span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5" /> {t("重试")}
      </Button>
    </div>
  );
}

/**
 * 重置卡弹窗（明细的唯一宿主，ADR-0014 修订）：由卡片底部「重置卡」按钮打开，
 * 每次打开都重取列表——上次结果里的 recordId 可能已被用掉或过期，不能再点。
 * 重取期间上一轮卡目顶住显示、原地变暗禁点（只有首次打开才出「加载中…」，不闪空面板）。
 * 使用不可逆 → AlertDialog 二次确认；成功后关弹窗，由外层刷新快照（配额窗口已变）。
 */
export function GlmResetCardDialog({
  instanceId,
  open,
  onOpenChange,
  onUsed,
}: {
  instanceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUsed: () => void;
}) {
  const t = useT();
  const [list, setList] = useState<GlmResetCardList | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [pending, setPending] = useState<PendingUse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState<Failure | null>(null);

  // 打开/重试的**那一帧**就进「重取中」：放进 effect 置位会晚于绘制，于是上一轮的旧卡目
  // 会先以可点状态画出来（用的是可能已失效的 recordId）。渲染期同步 state 是 React 官方
  // 的「从上一次渲染派生信息」写法，重绘发生在绘制之前。
  const fetchKey = `${instanceId}:${open ? "o" : "c"}:${reloadTick}`;
  const [syncedKey, setSyncedKey] = useState(fetchKey);
  if (syncedKey !== fetchKey) {
    setSyncedKey(fetchKey);
    if (open) setLoading(true);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 不清空上一轮 list：打开即渲染旧卡目、重取期间原地变暗禁点。
    // 置空会让弹窗先闪一块空面板（第二轮打开还会先闪旧数据再闪空），与成长中心抽屉的原地反馈同口径
    setFailure(null);
    setResultMessage(null);
    fetchGlmResetCards(instanceId)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "ok") setList(result.data);
        else setFailure({ message: result.message, params: result.params });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailure({
          message: "智谱重置卡查询失败：{detail}",
          params: { detail: error instanceof Error ? error.message : String(error) },
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, instanceId, reloadTick]);

  async function confirmUse() {
    if (!pending) return;
    setSubmitting(true);
    setResultMessage(null);
    try {
      // 官网同款幂等约定：requestId 客户端生成，失败后下次重新生成
      const result = await useGlmResetCard(
        instanceId,
        pending.resetType,
        pending.recordId,
        crypto.randomUUID(),
      );
      if (result.status === "ok") {
        setPending(null);
        onOpenChange(false);
        onUsed();
      } else {
        const detail = result.status === "error" ? (result.params?.detail ?? result.message) : result.message;
        // 失败同样要退出二次确认层：AlertDialog 自带遮罩，回话留在弹窗体里会被压得看不见
        setPending(null);
        setResultMessage(
          result.status === "error" && detail === RESET_CARD_UNAVAILABLE_MSG
            ? { message: "这张重置卡已不可用（可能已过期或被使用），请刷新后重试。" }
            : detail
              ? { message: "使用重置卡失败：{detail}", params: { detail } }
              : { message: "使用重置卡失败" },
        );
      }
    } catch (error) {
      setPending(null);
      setResultMessage({
        message: "使用重置卡失败：{detail}",
        params: { detail: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !submitting && onOpenChange(false)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("重置卡")}</DialogTitle>
          <DialogDescription>
            {t("每条次数有独立有效期，过期自动失效。重置周额度时会同步重置 5h 额度，且不额外消耗 5h 次数。仅展示未使用或近 7 天已过期的重置次数")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* 取数失败与使用失败各占一条：合并会让「列表陈旧」吞掉一次不可逆动作的失败回话；
              重取失败也不吞掉已有卡目，列表留在原地供参照 */}
          {failure && (
            <NoticeBar failure={failure} onRetry={() => setReloadTick((tick) => tick + 1)} />
          )}
          {resultMessage && (
            <NoticeBar failure={resultMessage} onRetry={() => setReloadTick((tick) => tick + 1)} />
          )}
          {/* 占位判据看 list 而不是 loading：loading 晚于首帧绘制，靠它会先渲染出一块空面板 */}
          {list === null ? (
            failure ? null : (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
                <LoaderCircle className="h-4 w-4 animate-spin" /> {t("加载中…")}
              </div>
            )
          ) : (
            <div className={cn("space-y-4", loading && "pointer-events-none opacity-50")}>
              <ResetGroup
                title={t("5小时额度")}
                group={list.fiveHour}
                resetType="FIVE_HOUR"
                windowLabel={t("5小时额度")}
                disabled={submitting || loading}
                onSelect={setPending}
              />
              <ResetGroup
                title={t("周额度")}
                group={list.week}
                resetType="WEEK"
                windowLabel={t("周额度")}
                disabled={submitting || loading}
                onSelect={setPending}
              />
            </div>
          )}
        </DialogBody>

        <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !submitting && setPending(null)}>
          <AlertDialogContent>
            <AlertDialogTitle>{t("使用重置卡")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? applyParams(
                    t("确认使用该{window}的重置卡？对应窗口额度将立即恢复（有效期至 {time}），操作不可撤销。"),
                    { window: pending.windowLabel, time: pending.expireTime },
                  )
                : ""}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={submitting}>{t("取消")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={submitting}
                onClick={(event) => {
                  event.preventDefault();
                  void confirmUse();
                }}
              >
                {submitting ? (
                  <>
                    <LoaderCircle className="h-4 w-4 animate-spin" /> {t("使用中…")}
                  </>
                ) : (
                  t("确认使用")
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
