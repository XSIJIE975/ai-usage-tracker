import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, LoaderCircle, Save } from "lucide-react";
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
} from "../../diagnostics";
import { useAppStore } from "../../store/useAppStore";
import { normalizeOpenCodeAuthCookie } from "../../lib/utils";
import { providerName } from "../../providers";
import { useT } from "../../i18n";
import type { ProviderInstance, ProviderKind } from "../../types/ipc";

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
  },
};

/** 连通性诊断在表单层组队：workspaceId+cookie 成对探测，其余单字段探测刚输入的值 */
function diagnosisFor(kind: ProviderKind, slot: string, values: Record<string, string>) {
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
    default:
      return null;
  }
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
  const [message, setMessage] = useState<SaveMessage>(null);
  const [saving, setSaving] = useState(false);

  // 打开时重置表单：编辑模式回填备注/开关/阈值与凭据明文
  useEffect(() => {
    if (!open) return;
    setNote(instance?.note ?? "");
    setAutoRefresh(instance?.autoRefresh ?? true);
    setThreshold(instance?.threshold != null ? String(instance.threshold) : "");
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

  const kindTitle = providerName(kind);

  const notice = !vaultStatus
    ? undefined
    : vaultStatus.needsMigration
      ? t("凭据库待迁移，请先完成一次性迁移，再保存凭据。")
      : vaultStatus.keychainLost
        ? t("本机设备密钥已丢失，保存时将重建凭据库。")
        : undefined;

  const thresholdConfig = config.threshold;
  const thresholdValue = useMemo(() => {
    const parsed = Number(threshold);
    return Number.isFinite(parsed) ? Math.min(thresholdConfig.max, Math.max(thresholdConfig.min, Math.round(parsed))) : null;
  }, [threshold, thresholdConfig.min, thresholdConfig.max]);

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
        if (raw) filledCredentials[field.slot] = field.normalize ? field.normalize(raw) : raw;
      }
      if (editing && instance) {
        await updateInstance(instance.id, {
          note: note.trim(),
          autoRefresh,
          threshold: threshold.trim() === "" ? null : thresholdValue,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
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

          <Separator />

          <div className="space-y-5">
            {config.fields.map((field) => (
              <div key={field.slot} className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor={`slot-${field.slot}`}>{t(field.label)}</Label>
                  {editing && <StatusBadge configured={Boolean(credentialStatus?.[field.slot])} />}
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
                {field.help && (
                  <p className="text-xs leading-relaxed text-fg-muted">{t(field.help)}</p>
                )}
                {(() => {
                  const diagnosis = diagnosisFor(kind, field.slot, values);
                  if (!diagnosis) return null;
                  return (
                    <DiagnosisButton
                      test={diagnosis.test}
                      disabled={saveDisabled || saving || diagnosis.disabled}
                    />
                  );
                })()}
              </div>
            ))}
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
