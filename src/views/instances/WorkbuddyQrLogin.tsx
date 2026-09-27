import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import qrcode from "qrcode-generator";
import { CheckCircle2, Check, ClipboardCopy, LoaderCircle, LogOut, QrCode, RefreshCw, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { applyParams } from "../../i18n/apply-params";
import { useT } from "../../i18n";
import type { ProviderInstance, ProviderSite, WorkbuddyQrPollResult, WorkbuddyQrStartResult } from "../../types/ipc";

/**
 * WorkBuddy 扫码登录区块（ADR-0034，无实例会话形态见 ADR-0035）：登录方式选
 * 「扫码登录」时渲染的录入区块。流程＝Rust 按站点签发授权会话（不需要实例先存在）
 * → 前端把授权链接渲染成二维码（本地编码，无外联）→ 3 秒轮询 Rust 查进度 →
 * 确认后凭据暂存 Rust 内存：编辑态立即 claim 写入 vault（不经表单提交，关弹窗不丢），
 * 新增态停在「扫码成功」等用户点保存，由保存流程创建实例后 claim。
 * 发布版 CSP 决定了一切外部请求都在 Rust 侧，这里只做展示与轮询调度。
 *
 * spike 实证（2026-09-26）：授权链接必须一字不差——「复制链接」用程序把整段 URL
 * 写进剪贴板，不提供让用户手选复制的路径。
 */

type QrPhase = "idle" | "starting" | "showing" | "confirmed" | "success" | "error";

/** 扫码产物槽位全集：退出扫码登录时一并清除；保存切到 Cookie 登录时表单层也用它清槽（ADR-0035 互斥） */
export const WORKBUDDY_TOKEN_SLOTS = [
  "accessToken",
  "refreshToken",
  "expiresAt",
  "uid",
  "nickname",
  "enterpriseId",
] as const;

function formatExpiry(raw: string | undefined): string | null {
  const ms = Number(raw);
  if (!raw || !Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

export function WorkbuddyQrLogin({
  site,
  instance,
  tokenConfigured,
  nickname,
  uid,
  expiresAt,
  busy,
  onChanged,
  onClearCredentials,
  onPendingClaim,
}: {
  /** 站点决定授权域（中国站 copilot.tencent.com / 国际站 workbuddy.ai），换站即换会话 */
  site: ProviderSite;
  /** 编辑态必传（claim 目标实例）；新增态 undefined——凭据等保存流程认领 */
  instance?: ProviderInstance;
  /** accessToken 槽已写入（credentialStatus 投影） */
  tokenConfigured: boolean;
  /** 已存的扫码摘要（vault 明文里非敏感的两个槽；扫码成功后 onChanged 重读刷新） */
  nickname?: string;
  uid?: string;
  expiresAt?: string;
  /** 外层保存进行中：整块禁用 */
  busy: boolean;
  /** 编辑态扫码认领成功（或退出）后：重读凭据状态并刷新该实例快照 */
  onChanged?: () => void | Promise<void>;
  /** 退出扫码登录的写库通道（表单层 saveInstanceCredentials，编辑态） */
  onClearCredentials?: (delta: Record<string, string | null>) => Promise<void>;
  /** 新增态：扫码确认后把待认领会话键上报给表单（保存时 claim）；作废时回 null */
  onPendingClaim?: (sessionKey: string | null) => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<QrPhase>("idle");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [confirmedNickname, setConfirmedNickname] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startSeq = useRef(0);

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  useEffect(
    () => () => {
      stopPolling();
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      if (successTimer.current !== null) clearTimeout(successTimer.current);
    },
    [],
  );

  // 换站即换授权域：进行中的会话对不上新站点，直接作废回 idle（互斥世界里凭据
  // 本来就要按站重配，这里只处理「进行中」的过渡态）
  useEffect(() => {
    startSeq.current += 1;
    stopPolling();
    if (successTimer.current !== null) {
      clearTimeout(successTimer.current);
      successTimer.current = null;
    }
    setPhase("idle");
    setAuthUrl(null);
    setSessionKey(null);
    setConfirmedNickname(null);
    setError(null);
    setCopied(false);
    onPendingClaim?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  async function start() {
    // 序号守卫：收起/换站作废在途的 start——否则收起后 invoke 才返回，
    // 会把已收起的界面又拉回展示态
    const seq = ++startSeq.current;
    stopPolling();
    setError(null);
    setCopied(false);
    setPhase("starting");
    try {
      const result = await invoke<WorkbuddyQrStartResult>("workbuddy_qr_start", { site });
      if (seq !== startSeq.current) return;
      setAuthUrl(result.authUrl);
      setSessionKey(result.sessionKey);
      setConfirmedNickname(null);
      onPendingClaim?.(null);
      setPhase("showing");
    } catch (caught) {
      if (seq !== startSeq.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase("error");
    }
  }

  /** 收起二维码（顶栏按钮在扫码进行中变成「关闭」）：作废在途会话回到常态，
   *  新增态同时上报清空待认领键——收起即放弃本次扫码 */
  function collapse() {
    startSeq.current += 1;
    stopPolling();
    setPhase("idle");
    setAuthUrl(null);
    setSessionKey(null);
    setError(null);
    setCopied(false);
    if (!instance) onPendingClaim?.(null);
  }

  // 展示态＝轮询态：3 秒一查（参考实现同节奏）。确认/过期/出错都停表
  useEffect(() => {
    if (phase !== "showing") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await invoke<WorkbuddyQrPollResult>("workbuddy_qr_poll", {
          sessionKey,
        });
        if (cancelled) return;
        if (result.status === "confirmed") {
          stopPolling();
          if (instance) {
            // 编辑态：立即认领，凭据写库即生效（关弹窗不丢），顺手清三格保互斥
            await invoke("workbuddy_qr_claim", { instanceId: instance.id, sessionKey });
            setAuthUrl(null);
            setSessionKey(null);
            setConfirmedNickname(result.nickname ?? null);
            // 成功必须被看见（ADR-0024 精神在正向事件上的对应）：绿字停留 3 秒再回落摘要
            if (successTimer.current !== null) clearTimeout(successTimer.current);
            setPhase("success");
            successTimer.current = setTimeout(() => {
              successTimer.current = null;
              setPhase("idle");
            }, 3000);
            await onChanged?.();
          } else {
            // 新增态：停在「扫码成功」等保存（ADR-0035：认领发生在实例创建之后）
            setPhase("confirmed");
            setConfirmedNickname(result.nickname ?? null);
            onPendingClaim?.(sessionKey ?? null);
          }
        } else if (result.status === "expired") {
          stopPolling();
          setPhase("error");
          setError(t("二维码已过期，请重新发起扫码。"));
        }
      } catch (caught) {
        if (cancelled) return;
        stopPolling();
        setPhase("error");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void poll();
    pollTimer.current = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sessionKey, instance?.id]);

  const qrSvg = useMemo(() => {
    if (!authUrl) return null;
    const qr = qrcode(0, "M");
    qr.addData(authUrl);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [authUrl]);

  async function signOut() {
    if (!onClearCredentials) return;
    const slots: Record<string, string | null> = {};
    for (const slot of WORKBUDDY_TOKEN_SLOTS) slots[slot] = null;
    await onClearCredentials(slots);
    await onChanged?.();
  }

  async function copyLink() {
    if (!authUrl) return;
    // 整段写入剪贴板：授权链接截断即「登录链接不完整」（spike 实测），不设手选路径
    await navigator.clipboard.writeText(authUrl);
    // 复制必须给反馈（否则不知道成功没有）：按钮短暂变为「已复制」再复原
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    setCopied(true);
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null;
      setCopied(false);
    }, 2000);
  }

  const disabled = busy;

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface-2 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <QrCode className="h-4 w-4 text-fg-muted" aria-hidden />
          <span className="text-[13px] font-medium">{t("扫码登录")}</span>
        </div>
      {(() => {
        // 顶栏按钮是切换器：扫码进行中变「关闭」（收起二维码、作废会话），
        // 其余时候才是发起/重扫入口；新增态扫码成功后收起入口（成功块引导保存）
        const sessionActive = phase === "starting" || phase === "showing";
        if (sessionActive) {
          return (
            <Button variant="outline" size="sm" onClick={collapse} disabled={disabled}>
              {/* 只有首次发起（还没有旧二维码）顶栏才转圈；「换一个」的重新生成
                  是二维码区的局部事务（遮罩+按钮自转），关闭按钮保持静态 */}
              {phase === "starting" && !authUrl ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <X className="h-4 w-4" aria-hidden />
              )}
              {t("关闭")}
            </Button>
          );
        }
        if (phase === "confirmed") return null;
        if (tokenConfigured) {
          return (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void start()} disabled={disabled}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                {t("重新扫码")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void signOut()} disabled={disabled}>
                <LogOut className="h-4 w-4" aria-hidden />
                {t("退出扫码登录")}
              </Button>
            </div>
          );
        }
        return (
          <Button variant="outline" size="sm" onClick={() => void start()} disabled={disabled}>
            <QrCode className="h-4 w-4" aria-hidden />
            {t("发起扫码")}
          </Button>
        );
      })()}
      </div>

      {tokenConfigured && phase === "idle" && (
        <p className="text-xs leading-relaxed text-fg-muted">
          {applyParams(t("扫码账号：{name} · 有效期至 {date}"), {
            name: nickname?.trim() || uid || t("未知账号"),
            date: formatExpiry(expiresAt) ?? t("未知"),
          })}
        </p>
      )}
      {!tokenConfigured && phase === "idle" && (
        <p className="text-xs leading-relaxed text-fg-muted">
          {t("手机扫码完成 WorkBuddy 登录，自动获取凭据并每日续期。")}
        </p>
      )}

      {/* 展示态也涵盖「重新生成中」（starting）：旧二维码置灰加遮罩原地换新，
          不整块消失闪跳——旧 state 已作废，遮罩期间也拦住别去扫它。
          白底收紧为贴合二维码的尺寸（mx-auto 居中）：二维码必须白底黑块才可扫，
          但不该在深色模式下铺成一条横贯整卡的亮带 */}
      {(phase === "showing" || phase === "starting") && authUrl && (
        <div className="space-y-2">
          <div className="relative mx-auto w-fit rounded-md bg-white p-3">
            {qrSvg && (
              <div
                className={`h-44 w-44 transition-opacity duration-fast [&>svg]:h-full [&>svg]:w-full${
                  phase === "starting" ? " opacity-30" : ""
                }`}
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            )}
            {phase === "starting" && (
              <div className="absolute inset-0 flex items-center justify-center">
                <LoaderCircle className="h-6 w-6 animate-spin text-fg-muted" aria-hidden />
              </div>
            )}
          </div>
          <p className="text-center text-xs text-fg-muted">{t("用手机浏览器或微信扫码，完成登录后此处自动继续。")}</p>
          <div className="flex justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyLink()}
              disabled={disabled || phase === "starting"}
            >
              {copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <ClipboardCopy className="h-4 w-4" aria-hidden />
              )}
              {copied ? t("已复制") : t("复制登录链接")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void start()}
              disabled={disabled || phase === "starting"}
            >
              {phase === "starting" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
              {t("换一个")}
            </Button>
          </div>
        </div>
      )}

      {/* 首次发起（还没有旧二维码可原地置灰）：给一行居中加载，避免区块空一下 */}
      {phase === "starting" && !authUrl && (
        <div className="flex justify-center py-6" role="status">
          <LoaderCircle className="h-6 w-6 animate-spin text-fg-muted" aria-hidden />
        </div>
      )}

      {phase === "confirmed" && (
        <div className="space-y-2" role="status">
          <p className="flex items-center gap-1.5 text-xs font-medium text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {confirmedNickname
              ? applyParams(t("扫码成功：{name}"), { name: confirmedNickname })
              : t("扫码成功")}
          </p>
          <p className="text-xs leading-relaxed text-fg-muted">
            {t("凭据已就绪，点击「保存」完成添加。")}
          </p>
        </div>
      )}

      {/* 编辑态认领成功：绿字停留 3 秒回落到常驻摘要行 */}
      {phase === "success" && (
        <div className="space-y-2" role="status">
          <p className="flex items-center gap-1.5 text-xs font-medium text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {confirmedNickname
              ? applyParams(t("扫码成功：{name}"), { name: confirmedNickname })
              : t("扫码成功")}
          </p>
          <p className="text-xs leading-relaxed text-fg-muted">
            {t("凭据已保存，即时生效。")}
          </p>
        </div>
      )}

      {phase === "error" && error && (
        <p className="text-xs leading-relaxed text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
