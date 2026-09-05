import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardTitle } from "../../../components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { HintTooltip } from "../../../components/ui/tooltip";
import { applyParams, useT } from "../../../i18n";
import {
  RESET_CARD_UNAVAILABLE_MSG,
  useGlmResetCard,
  type GlmResetCardList,
  type GlmResetType,
} from "../../../providers/glm-stats";

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

/**
 * 重置卡摘要卡（官网「用量重置额度」同款交互）：抽屉内只展示各窗口可用张数，
 * 「重置管理」打开「重置额度」弹窗查看明细并可使用（不可逆，二次确认）；成功后 onUsed 通知外层刷新。
 */
export function GlmResetCards({
  list,
  instanceId,
  onUsed,
}: {
  list: GlmResetCardList;
  instanceId: string;
  onUsed: () => void;
}) {
  const t = useT();
  const [manageOpen, setManageOpen] = useState(false);
  const [pending, setPending] = useState<PendingUse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

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
        onUsed();
      } else {
        const detail = result.status === "error" ? (result.params?.detail ?? result.message) : result.message;
        setResultMessage(
          result.status === "error" && detail === RESET_CARD_UNAVAILABLE_MSG
            ? t("这张重置卡已不可用（可能已过期或被使用），请刷新后重试。")
            : detail
              ? applyParams(t("使用重置卡失败：{detail}"), { detail })
              : t("使用重置卡失败"),
        );
      }
    } catch (error) {
      setResultMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  const summary = [
    { label: t("5小时额度"), count: list.fiveHour.available },
    { label: t("周额度"), count: list.week.available },
  ];

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {t("重置卡")}
          <HintTooltip
            tip={t("每张重置卡可立即恢复对应窗口的额度，独立有效期、过期自动失效；使用周卡会同步重置 5 小时额度，不额外消耗 5 小时次数。")}
          />
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
          {t("重置管理")}
        </Button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4">
        {summary.map((item) => (
          <div key={item.label}>
            <div className="text-xs text-fg-muted">{item.label}</div>
            <div className="tnum mt-0.5 text-lg font-semibold text-fg">
              {applyParams(t("可用{count}次"), { count: item.count })}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t("重置额度")}</DialogTitle>
            <DialogDescription>
              {t("每条次数有独立有效期，过期自动失效。重置周额度时会同步重置 5h 额度，且不额外消耗 5h 次数。仅展示未使用或近 7 天已过期的重置次数")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {resultMessage && (
              <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning-soft-fg">
                {resultMessage}
              </p>
            )}
            <ResetGroup
              title={t("5小时额度")}
              group={list.fiveHour}
              resetType="FIVE_HOUR"
              windowLabel={t("5小时额度")}
              disabled={submitting}
              onSelect={setPending}
            />
            <ResetGroup
              title={t("周额度")}
              group={list.week}
              resetType="WEEK"
              windowLabel={t("周额度")}
              disabled={submitting}
              onSelect={setPending}
            />
          </DialogBody>
        </DialogContent>

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
              <AlertDialogAction disabled={submitting} onClick={(event) => { event.preventDefault(); void confirmUse(); }}>
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
      </Dialog>
    </Card>
  );
}
