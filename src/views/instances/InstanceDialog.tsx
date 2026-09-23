import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, LoaderCircle, Save } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Separator } from "../../components/ui/separator";
import { Switch } from "../../components/ui/switch";
import { SecretField, StatusBadge } from "../settings/CredentialInput";
import { DiagnosisButton } from "../settings/DiagnosisButton";
import { useVaultCredentials } from "../settings/use-vault-credentials";
import { SaveMessageBanner, type SaveMessage } from "../settings/provider-settings";
import {
  testDeepSeekApiKey,
  testDeepSeekUserToken,
  testGlmCodingPlanKey,
  testOpenCodeApiKey,
  testOpenCodeConnection,
  testQoderCookie,
  testWorkbuddyCredential,
} from "../../diagnostics";
import { useAppStore } from "../../store/useAppStore";
import { normalizeOpenCodeAuthCookie } from "../../lib/utils";
import { isValidSessionCookieValue } from "../../providers/qoder";
import { isValidCookiePartValue, isValidUserAgentValue } from "../../providers/workbuddy";
import { hasMultipleSites, providerSites, SITE_LABELS } from "../../lib/instance";
import { providerName } from "../../providers";
import { useT } from "../../i18n";
import { Select } from "../../components/ui/select";
import type { ProviderInstance, ProviderKind, ProviderSite } from "../../types/ipc";

interface CredentialFieldSpec {
  slot: string;
  label: string;
  placeholder?: string;
  help?: string;
  /** 展示前归一化（auth cookie 兼容多种粘贴格式） */
  normalize?: (value: string) => string;
}

interface KindConfig {
  fields: CredentialFieldSpec[];
  threshold: { label: string; hint: string; min: number; max: number };
  /** 第二阈值（可选）：glm 的余额告警阈值（元），与配额百分比阈值并存 */
  balanceThreshold?: { label: string; hint: string; min: number; max: number };
}

const KIND_CONFIGS: Record<ProviderKind, KindConfig> = {
  deepseek: {
    fields: [
      {
        slot: "apiKey",
        label: "DeepSeek API Key",
        placeholder: "sk-...",
      },
      {
        slot: "userToken",
        label: "DeepSeek UserToken",
        placeholder: "platform.deepseek.com 登录令牌",
        help: "获取方式：打开 platform.deepseek.com 并登录 → F12 打开开发者工具 → Application(应用) → Local Storage → https://platform.deepseek.com → 找到键 userToken，其值为 JSON 对象，复制其中 token 字段的字符串值。",
      },
    ],
    threshold: { label: "余额告警阈值（元）", hint: "余额低于该值时发送系统通知；留空不告警。", min: 0, max: 1_000_000 },
  },
  "opencode-go": {
    fields: [
      {
        slot: "workspaceId",
        label: "OpenCode Go Workspace ID",
        placeholder: "wrk_...",
      },
      {
        slot: "cookie",
        label: "OpenCode Auth Cookie",
        placeholder: "只粘贴 auth Cookie 的 Value",
        help: "获取方式：打开 opencode.ai 后台，按 F12 → Application → Cookies → opencode.ai，复制名为 auth 的 Value；不要带 Cookie: 或 auth= 前缀。",
        normalize: normalizeOpenCodeAuthCookie,
      },
      {
        slot: "apiKey",
        label: "OpenCode Go API Key（可选）",
        placeholder: "官方 /usage 接口上线后使用",
      },
    ],
    threshold: { label: "本月额度告警阈值（%）", hint: "本月额度已用达到该百分比时发送系统通知；留空不告警。", min: 1, max: 100 },
  },
  glm: {
    fields: [
      {
        slot: "planKey",
        label: "智谱 Coding Plan API Key",
        placeholder: "粘贴 API Key",
        help: "获取方式：打开 bigmodel.cn 控制台 → Coding Plan 页 → 「生成 API Key」，复制生成的 API Key 粘贴到上方。",
      },
    ],
    threshold: { label: "Coding Plan 配额告警阈值（%）", hint: "Coding Plan 配额已用达到该百分比时发送系统通知；留空不告警。", min: 1, max: 100 },
    balanceThreshold: { label: "余额告警阈值（元）", hint: "账户余额低于该值时发送系统通知；留空不告警。", min: 0, max: 1_000_000 },
  },
  workbuddy: {
    fields: [
      {
        slot: "session",
        label: "WorkBuddy session",
        placeholder: "只粘贴值，不带键名",
        help: "Cookie 行里 session= 后面的那段值",
      },
      {
        slot: "session2",
        label: "WorkBuddy session_2",
        placeholder: "只粘贴值，不带键名",
        help: "Cookie 行里 session_2= 后面的那段值",
      },
      {
        slot: "userAgent",
        label: "浏览器 User-Agent",
        placeholder: "只粘贴整行值，不带「User-Agent:」前缀",
        help: "User-Agent 行的整行值，须与登录时逐字节相同",
      },
    ],
    threshold: { label: "积分已用告警阈值（%）", hint: "积分已用达到该百分比时发送系统通知；留空不告警。", min: 1, max: 100 },
  },
  qoder: {
    fields: [
      {
        slot: "cookie",
        label: "Qoder 会话 Cookie",
        placeholder: "只粘贴 qoder_session_cookie 的值",
        // help 按选中站点动态生成，见 SITE_PROFILES
      },
    ],
    threshold: { label: "积分已用告警阈值（%）", hint: "积分已用达到该百分比时发送系统通知；留空不告警。", min: 1, max: 100 },
  },
};

/**
 * 多站供应商的站点档案（ADR-0031）：域名是判站与重贴凭据的唯一线索，所以下拉标签与
 * 凭据获取文案都按 (种类, 站点) 给——并列两个域名会让显式判站失去意义。
 * 可选站点集本身在 lib/instance.ts 的 providerSites，弹窗与卡片徽标共用那一个判据。
 * `help` 是站点级长指引：多格种类折进「如何获取？」，单格种类贴在唯一的框下面。
 */
const SITE_PROFILES: Partial<
  Record<ProviderKind, Record<ProviderSite, { domain: string; help: string }>>
> = {
  qoder: {
    china: {
      domain: "qoder.com.cn",
      help: "获取方式：登录 qoder.com.cn → F12 → Application(应用) → Cookies → https://qoder.com.cn → 找到名为 qoder_session_cookie 的 Cookie，只复制它的 Value 粘贴（不要带键名或「Cookie:」前缀）。",
    },
    international: {
      domain: "qoder.com",
      help: "获取方式：登录 qoder.com → F12 → Application(应用) → Cookies → https://qoder.com → 找到名为 qoder_session_cookie 的 Cookie，只复制它的 Value 粘贴（不要带键名或「Cookie:」前缀）。",
    },
  },
  workbuddy: {
    china: {
      domain: "workbuddy.cn",
      // 逐格「贴哪一段」由各格的短提示说明，这里只留取值的导航路径
      help: "获取方式：登录 www.workbuddy.cn → F12 打开开发者工具 → Network(网络) → 刷新页面 → 任选一条 www.workbuddy.cn 的请求 → Request Headers(请求标头)，按每格下面的提示取三个值。三项必须来自同一条请求（网关要求两个 Cookie 成对、UA 与登录时逐字节相同），都只贴值本身、不带键名。",
    },
    international: {
      domain: "workbuddy.ai",
      help: "获取方式：登录 www.workbuddy.ai → F12 打开开发者工具 → Network(网络) → 刷新页面 → 任选一条 www.workbuddy.ai 的请求 → Request Headers(请求标头)，按每格下面的提示取三个值。三项必须来自同一条请求（网关要求两个 Cookie 成对、UA 与登录时逐字节相同），都只贴值本身、不带键名。",
    },
  },
};

/** 站点下拉的选项：标签=短名（域名），中文标签同时是 i18n 键 */
function siteOptions(kind: ProviderKind): { value: ProviderSite; label: string }[] {
  const profiles = SITE_PROFILES[kind];
  if (!profiles) return [];
  return providerSites(kind).map((site) => ({
    value: site,
    label: `${SITE_LABELS[site]}（${profiles[site].domain}）`,
  }));
}

/** 连通性诊断在表单层组队：workspaceId+cookie 成对探测，其余单字段探测刚输入的值 */
function diagnosisFor(
  kind: ProviderKind,
  slot: string,
  values: Record<string, string>,
  site: ProviderSite,
) {
  const value = values[slot] ?? "";
  switch (`${kind}/${slot}`) {
    case "deepseek/apiKey":
      return { test: () => testDeepSeekApiKey(value), disabled: !value.trim() };
    case "deepseek/userToken":
      return { test: () => testDeepSeekUserToken(value), disabled: !value.trim() };
    case "opencode-go/cookie": {
      const workspaceId = values.workspaceId ?? "";
      return {
        test: () => testOpenCodeConnection(workspaceId, value),
        disabled: !workspaceId.trim() || !value.trim(),
      };
    }
    case "opencode-go/apiKey":
      return { test: () => testOpenCodeApiKey(value), disabled: !value.trim() };
    case "glm/planKey":
      return { test: () => testGlmCodingPlanKey(value), disabled: !value.trim() };
    case "qoder/cookie":
      return {
        test: () => testQoderCookie(value, site),
        disabled: !value.trim(),
      };
    default:
      return null;
  }
}

/** 成对/成组才有意义的凭据按组探测：WorkBuddy 三值缺一即 401（ADR-0029），
 *  所以它不挂在哪一格下面，而是三格之后一次探测这三格 */
function groupDiagnosisFor(
  kind: ProviderKind,
  values: Record<string, string>,
  site: ProviderSite,
) {
  if (kind !== "workbuddy") return null;
  const session = values.session ?? "";
  const session2 = values.session2 ?? "";
  const userAgent = values.userAgent ?? "";
  return {
    test: () => testWorkbuddyCredential(session, session2, userAgent, site),
    disabled: !session.trim() || !session2.trim() || !userAgent.trim(),
  };
}

/**
 * 供应商实例配置弹窗：新建与编辑共用。
 * 结构 = 备注 → 凭据区（按种类渲染）→ 自动刷新与阈值 → 取消/保存。
 */
export function InstanceDialog({
  open,
  onOpenChange,
  instance,
  providerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建模式 */
  instance: ProviderInstance | null;
  providerId: ProviderKind;
}) {
  const editing = instance !== null;
  const kind = instance?.providerId ?? providerId;
  const config = KIND_CONFIGS[kind];
  const t = useT();
  const vaultStatus = useAppStore((state) => state.vaultStatus);
  const settings = useAppStore((state) => state.settings);
  const addInstance = useAppStore((state) => state.addInstance);
  const updateInstance = useAppStore((state) => state.updateInstance);
  const saveInstanceCredentials = useAppStore((state) => state.saveInstanceCredentials);
  const reloadInstances = useAppStore((state) => state.reloadInstances);
  const refreshInstance = useAppStore((state) => state.refreshInstance);

  const unlocked = Boolean(vaultStatus?.unlocked);
  const saveDisabled = Boolean(vaultStatus?.needsMigration);
  const { credentials, credentialStatus, reload } = useVaultCredentials(
    unlocked && editing && open,
    instance?.id ?? null,
  );

  const [note, setNote] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [threshold, setThreshold] = useState("");
  const [balanceThreshold, setBalanceThreshold] = useState("");
  const [site, setSite] = useState<ProviderSite>("china");
  const [message, setMessage] = useState<SaveMessage>(null);
  const [saving, setSaving] = useState(false);

  // 打开时重置表单：编辑模式回填备注/开关/阈值/站点与凭据明文
  useEffect(() => {
    if (!open) return;
    setNote(instance?.note ?? "");
    setAutoRefresh(instance?.autoRefresh ?? true);
    setThreshold(instance?.threshold != null ? String(instance.threshold) : "");
    setBalanceThreshold(instance?.balanceThreshold != null ? String(instance.balanceThreshold) : "");
    setSite(instance?.site ?? "china");
    setValues({});
    setMessage(null);
  }, [open, instance]);

  useEffect(() => {
    if (!open || !editing || !credentials) return;
    setValues((current) => {
      const next = { ...current };
      for (const field of config.fields) {
        if (current[field.slot] === undefined && credentials[field.slot] !== undefined) {
          next[field.slot] = credentials[field.slot];
        }
      }
      return next;
    });
  }, [open, editing, credentials, config.fields]);

  const kindTitle = t(providerName(kind));

  const notice = !vaultStatus
    ? undefined
    : vaultStatus.needsMigration
      ? t("凭据库待迁移，请先完成一次性迁移，再保存凭据。")
      : vaultStatus.keychainLost
        ? t("本机设备密钥已丢失，保存时将重建凭据库。")
        : undefined;

  const thresholdConfig = config.threshold;
  const balanceThresholdConfig = config.balanceThreshold;
  const thresholdValue = useMemo(() => {
    const parsed = Number(threshold);
    return Number.isFinite(parsed) ? Math.min(thresholdConfig.max, Math.max(thresholdConfig.min, Math.round(parsed))) : null;
  }, [threshold, thresholdConfig.min, thresholdConfig.max]);
  const balanceThresholdValue = useMemo(() => {
    if (!balanceThresholdConfig) return null;
    const parsed = Number(balanceThreshold);
    return Number.isFinite(parsed)
      ? Math.min(balanceThresholdConfig.max, Math.max(balanceThresholdConfig.min, Math.round(parsed)))
      : null;
  }, [balanceThreshold, balanceThresholdConfig]);

  async function clearCredential(slot: string) {
    if (!instance) return;
    setSaving(true);
    try {
      await saveInstanceCredentials(instance.id, { [slot]: null });
      setValues((current) => ({ ...current, [slot]: "" }));
      await reload();
      setMessage({ kind: "success", text: t("凭据已清除") });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const filledCredentials: Record<string, string> = {};
      for (const field of config.fields) {
        const raw = (values[field.slot] ?? "").trim();
        if (raw) {
          // Qoder 只存会话 Cookie 的值本体（键名与 Cookie 头由 Rust 端拼），合法性只在
          // 这一道把关：拒「Cookie:」前缀、连键名一起贴、以及分号/空格/换行等非
          // cookie-value 字符——保存前拦下，错误可见而不是存进去等 401（探测链路传的是
          // 同一个原文，测得过即存得过）
          if (kind === "qoder" && !isValidSessionCookieValue(raw)) {
            setSaving(false);
            setMessage({
              kind: "error",
              text: t(
                "只粘贴 qoder_session_cookie 的值：不要带「Cookie:」前缀或键名，也不能包含分号、空格、换行或中文",
              ),
            });
            return;
          }
          // WorkBuddy 三格同口径：两个 Cookie 格过 cookie-value 字符集（整段 Cookie 头
          // 带分号与空格，正是这里拒掉的），UA 格过单行可见 ASCII——保存前拦下而不是
          // 存进去等网关 401，且探测用的是同一份判定
          if (kind === "workbuddy") {
            const ok =
              field.slot === "userAgent" ? isValidUserAgentValue(raw) : isValidCookiePartValue(raw);
            if (!ok) {
              setSaving(false);
              setMessage({
                kind: "error",
                text:
                  field.slot === "userAgent"
                    ? t("只粘贴 User-Agent 的值：不要带「User-Agent:」前缀，也不能包含换行或中文")
                    : t("只粘贴该 Cookie 的值：不要带键名或「Cookie:」前缀，也不能包含分号、空格、换行或中文"),
              });
              return;
            }
          }
          filledCredentials[field.slot] = field.normalize ? field.normalize(raw) : raw;
        }
      }
      if (editing && instance) {
        await updateInstance(instance.id, {
          note: note.trim(),
          autoRefresh,
          threshold: threshold.trim() === "" ? null : thresholdValue,
          ...(config.balanceThreshold
            ? { balanceThreshold: balanceThreshold.trim() === "" ? null : balanceThresholdValue }
            : {}),
          ...(hasMultipleSites(kind) ? { site } : {}),
        });
        if (Object.keys(filledCredentials).length > 0) {
          await saveInstanceCredentials(instance.id, filledCredentials);
        }
        await reloadInstances();
        await reload();
        await refreshInstance(instance.id);
      } else {
        const created = await addInstance(kind, note.trim(), filledCredentials, {
          autoRefresh,
          threshold: threshold.trim() === "" ? null : thresholdValue,
          balanceThreshold:
            config.balanceThreshold && balanceThreshold.trim() !== "" ? balanceThresholdValue : null,
          ...(hasMultipleSites(kind) ? { site } : {}),
        });
        await refreshInstance(created.id);
      }
      onOpenChange(false);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 保存进行中拦下 ESC/遮罩关闭（ADR-0024 可见性）：半途关掉后保存结果
        // 会写进已关闭的弹窗，新建路径用户完全得不到反馈
        if (!next && saving) return;
        onOpenChange(next);
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {editing ? t("编辑配置") : `${t("添加供应商")} · ${kindTitle}`}
          </DialogTitle>
          <DialogDescription>
            {t("同一供应商可以添加多份配置，各自独立追踪、统计与告警。")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {notice && (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-soft-fg">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {notice}
            </p>
          )}
          <SaveMessageBanner message={message} />

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="instance-note">{t("备注")}</Label>
            </div>
            <Input
              id="instance-note"
              value={note}
              placeholder={t("如：公司主账号")}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            <p className="text-xs text-fg-muted">{t("备注会作为卡片标题；留空时显示供应商名。")}</p>
          </div>

          {hasMultipleSites(kind) && (
            <>
              <Separator />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="instance-site">{t("站点")}</Label>
                  <p className="mt-1 text-[13px] text-fg-muted">
                    {t("两套登录域互不相通，请选择账号所在的站点；换站后需重新粘贴对应站点的凭据。")}
                  </p>
                </div>
                <Select
                  id="instance-site"
                  // label 是中文源文案（i18n 键），渲染时按界面语言翻译
                  options={siteOptions(kind).map((option) => ({ ...option, label: t(option.label) }))}
                  value={site}
                  onChange={setSite}
                  disabled={saving}
                />
              </div>
            </>
          )}

          <Separator />

          <div className="space-y-5">
            {(() => {
              /* 站点级长指引的位置：多格种类（WorkBuddy 三格）折进组尾的「如何获取？」，
                 常驻长文会把填写框挤出首屏；单格种类（Qoder）指引就贴在唯一的框下面，
                 不值得多点一次。逐格「这一格贴什么」由各格的短提示承担，两边不重复 */
              const siteGuide = SITE_PROFILES[kind]?.[site]?.help;
              const collapsedGuide = config.fields.length > 1;
              const groupDiagnosis = groupDiagnosisFor(kind, values, site);
              return (
                <>
                  {config.fields.map((field) => {
                    const inlineHelp = field.help ?? (collapsedGuide ? undefined : siteGuide);
                    const diagnosis = groupDiagnosis
                      ? null
                      : diagnosisFor(kind, field.slot, values, site);
                    return (
                      <div key={field.slot} className="space-y-2.5">
                        <div className="flex items-center justify-between">
                          <Label htmlFor={`slot-${field.slot}`}>{t(field.label)}</Label>
                          {editing && (
                            <StatusBadge configured={Boolean(credentialStatus?.[field.slot])} />
                          )}
                        </div>
                        <SecretField
                          id={`slot-${field.slot}`}
                          value={values[field.slot] ?? ""}
                          placeholder={field.placeholder ? t(field.placeholder) : undefined}
                          disabled={saveDisabled || saving}
                          onChange={(value) =>
                            setValues((current) => ({ ...current, [field.slot]: value }))
                          }
                          onClear={() => void clearCredential(field.slot)}
                          clearDisabled={!(values[field.slot] ?? "").trim() || !editing}
                        />
                        {inlineHelp && (
                          <p className="text-xs leading-relaxed text-fg-muted">{t(inlineHelp)}</p>
                        )}
                        {diagnosis && (
                          <DiagnosisButton
                            test={diagnosis.test}
                            disabled={saveDisabled || saving || diagnosis.disabled}
                          />
                        )}
                      </div>
                    );
                  })}
                  {collapsedGuide && siteGuide && (
                    <details className="group rounded-md border border-line bg-surface-2 px-3 py-2">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
                        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                        {t("如何获取？")}
                      </summary>
                      <p className="mt-2 text-xs leading-relaxed text-fg-muted">{t(siteGuide)}</p>
                    </details>
                  )}
                  {groupDiagnosis && (
                    <DiagnosisButton
                      test={groupDiagnosis.test}
                      disabled={saveDisabled || saving || groupDiagnosis.disabled}
                    />
                  )}
                </>
              );
            })()}
          </div>

          <Separator />

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label>{t("自动刷新")}</Label>
                <p className="mt-1 text-[13px] text-fg-muted">
                  {!settings.refreshEnabled
                    ? t("需先在设置中开启自动刷新总开关。")
                    : t("跟随全局刷新间隔，手动刷新不受此开关影响。")}
                </p>
              </div>
              <Switch
                checked={autoRefresh}
                disabled={!settings.refreshEnabled}
                onCheckedChange={setAutoRefresh}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="instance-threshold">{t(thresholdConfig.label)}</Label>
                <p className="mt-1 text-[13px] text-fg-muted">{t(thresholdConfig.hint)}</p>
              </div>
              <input
                id="instance-threshold"
                type="number"
                value={threshold}
                min={thresholdConfig.min}
                max={thresholdConfig.max}
                step={1}
                disabled={!settings.alertsEnabled}
                onChange={(event) => setThreshold(event.currentTarget.value)}
                className="tnum h-9 w-28 rounded-md border border-line bg-surface px-2 text-right text-[13px] text-fg shadow-sm focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
              />
            </div>

            {balanceThresholdConfig && (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="instance-balance-threshold">{t(balanceThresholdConfig.label)}</Label>
                  <p className="mt-1 text-[13px] text-fg-muted">{t(balanceThresholdConfig.hint)}</p>
                </div>
                <input
                  id="instance-balance-threshold"
                  type="number"
                  value={balanceThreshold}
                  min={balanceThresholdConfig.min}
                  max={balanceThresholdConfig.max}
                  step={1}
                  disabled={!settings.alertsEnabled}
                  onChange={(event) => setBalanceThreshold(event.currentTarget.value)}
                  className="tnum h-9 w-28 rounded-md border border-line bg-surface px-2 text-right text-[13px] text-fg shadow-sm focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
                />
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("取消")}
          </Button>
          <Button size="sm" disabled={saveDisabled || saving} onClick={() => void save()}>
            {saving ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" /> {t("保存中…")}
              </>
            ) : (
              <>
                <Save className="h-4 w-4" /> {t("保存")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
