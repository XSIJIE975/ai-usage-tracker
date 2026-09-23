import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, LoaderCircle, Save } from "lucide-react";
import { Controller, useForm, useWatch, type FieldError, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { Field, FieldDescription, FieldError as FieldErrorText, FieldLabel } from "../../components/ui/field";
import { Separator } from "../../components/ui/separator";
import { Switch } from "../../components/ui/switch";
import { Select } from "../../components/ui/select";
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
import { providerFormSpecs, siteProfiles, type ProviderFormSpec } from "../../forms/form-specs";
import { buildInstanceSchema, NOTE_MAX_LENGTH, type InstanceFormValues } from "../../forms/instance-schema";
import { renderFormError } from "../../forms/error-codes";
import { hasMultipleSites, providerSites, SITE_LABELS } from "../../lib/instance";
import { providerName } from "../../providers";
import { useT } from "../../i18n";
import type { ProviderInstance, ProviderKind, ProviderSite } from "../../types/ipc";

/** 站点下拉的选项：标签=短名（域名），中文标签同时是 i18n 键 */
function siteOptions(kind: ProviderKind): { value: ProviderSite; label: string }[] {
  const profiles = siteProfiles[kind];
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

function defaultsFor(instance: ProviderInstance | null, kind: ProviderKind): InstanceFormValues {
  return {
    note: instance?.note ?? "",
    site: instance?.site ?? "china",
    autoRefresh: instance?.autoRefresh ?? true,
    threshold: instance?.threshold != null ? String(instance.threshold) : "",
    balanceThreshold: instance?.balanceThreshold != null ? String(instance.balanceThreshold) : "",
    credentials: Object.fromEntries(providerFormSpecs[kind].fields.map((f) => [f.slot, ""])),
  };
}

/** 提交失败时聚焦第一个错误字段（对齐后台表单的滚动定位）：按视觉顺序找，
 *  而不是按 FieldErrors 的键序；控件是自绘的，用 DOM id 定位比 ref 传递省事 */
function firstInvalidFieldId(errors: FieldErrors<InstanceFormValues>, spec: ProviderFormSpec) {
  const credentials = errors.credentials as Record<string, FieldError> | undefined;
  if (errors.note?.message) return "instance-note";
  if (errors.site?.message) return "instance-site";
  for (const field of spec.fields) {
    if (credentials?.[field.slot]?.message) return `slot-${field.slot}`;
  }
  if (errors.threshold?.message) return "instance-threshold";
  if (errors.balanceThreshold?.message) return "instance-balance-threshold";
  return undefined;
}

/** 校验错误渲染：schema 只给错误码，文案在这里按当前语言现翻 */
function FieldErrorMessage({
  id,
  error,
  params,
}: {
  id: string;
  error?: FieldError;
  params?: Record<string, string | number>;
}) {
  const t = useT();
  if (!error?.message) return null;
  return <FieldErrorText id={id}>{renderFormError(error.message, params, t)}</FieldErrorText>;
}

/**
 * 供应商实例配置弹窗：新建与编辑共用。
 * 结构 = 备注 → 凭据区（按种类渲染）→ 自动刷新与阈值 → 取消/保存。
 * 表单状态与校验由 react-hook-form 承担，校验规则来自 zod schema
 * （buildInstanceSchema，按种类 + 新建/编辑态装配），字段规格见 providers/form-specs.ts。
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
  const spec = providerFormSpecs[kind];
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

  // 凭据没读出来时不能拿空格子当「用户清空」，必填校验要放行（见 buildInstanceSchema）
  const credentialsLoaded = !editing || credentials !== null;
  const schema = useMemo(
    () => buildInstanceSchema(kind, credentialsLoaded),
    [kind, credentialsLoaded],
  );

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<InstanceFormValues>({
    resolver: zodResolver(schema),
    // 首次失焦后跟随输入实时纠错：既不在用户还没写完就报，也不等到提交才一次糊满屏
    mode: "onTouched",
    // 聚焦交给 firstInvalidFieldId：RHF 自己那套按注册 ref 的顺序找，会把焦点丢给备注框
    // （它在 handleSubmit 的 invalid 回调之后再抢一次焦点），而凭据格走 Controller 没有 ref
    shouldFocusError: false,
    defaultValues: defaultsFor(instance, kind),
  });

  const credentialValues = useWatch({ control, name: "credentials" }) ?? {};
  const watchedSite = useWatch({ control, name: "site" });
  const [message, setMessage] = useState<SaveMessage>(null);

  // 打开时重置表单：编辑模式回填备注/开关/阈值/站点（凭据明文由下方 effect 补）
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) return;
    reset(defaultsFor(instance, kind));
    seeded.current = false;
    setMessage(null);
  }, [open, instance, kind, reset]);

  // 凭据明文是异步读出来的，整个编辑会话只回填一次：之后 reload()（比如清了某格）
  // 不能再把用户刚删空的格子灌回去——表单值就是事实源，回填只负责建立初值
  useEffect(() => {
    if (!open || !editing || !credentials || seeded.current) return;
    const current = getValues("credentials");
    const next = { ...current };
    for (const field of spec.fields) {
      if (!current[field.slot]) next[field.slot] = credentials[field.slot] ?? "";
    }
    seeded.current = true;
    setValue("credentials", next, { shouldValidate: false, shouldDirty: false });
  }, [open, editing, credentials, spec.fields, getValues, setValue]);

  const kindTitle = t(providerName(kind));

  const notice = !vaultStatus
    ? undefined
    : vaultStatus.needsMigration
      ? t("凭据库待迁移，请先完成一次性迁移，再保存凭据。")
      : vaultStatus.keychainLost
        ? t("本机设备密钥已丢失，保存时将重建凭据库。")
        : undefined;

  /** 「清除」只清输入框：写库统一发生在保存，中途取消就什么都没被改掉 */
  function clearCredential(slot: string) {
    setValue(`credentials.${slot}`, "", { shouldValidate: true });
  }

  const submit = handleSubmit(async (values) => {
    setMessage(null);
    try {
      // 表单值就是事实源：非空写新值，空写 null（即删掉该槽）。必填格不会以空值走到这里，
      // 所以「删不掉」的老毛病（空格子被 if (raw) 跳过、库里旧值原封不动）在这里断掉。
      const written: Record<string, string | null> = {};
      for (const field of spec.fields) {
        const raw = (values.credentials[field.slot] ?? "").trim();
        written[field.slot] = raw ? (field.normalize ? field.normalize(raw) : raw) : null;
      }
      const threshold = values.threshold.trim();
      const balanceThreshold = values.balanceThreshold.trim();
      if (editing && instance) {
        await updateInstance(instance.id, {
          note: values.note.trim(),
          autoRefresh: values.autoRefresh,
          // schema 已保证是范围内整数，不再 Math.min/Math.max 静默改写用户输入
          threshold: threshold === "" ? null : Number(threshold),
          ...(spec.balanceThreshold
            ? { balanceThreshold: balanceThreshold === "" ? null : Number(balanceThreshold) }
            : {}),
          ...(hasMultipleSites(kind) ? { site: values.site } : {}),
        });
        // 凭据没读出来时整段跳过：那时格子里的空是「没读到」，写下去等于把凭据删了
        if (credentialsLoaded) {
          const delta: Record<string, string | null> = {};
          for (const field of spec.fields) {
            const prev = credentials?.[field.slot] ?? null;
            if (written[field.slot] !== prev) delta[field.slot] = written[field.slot];
          }
          if (Object.keys(delta).length > 0) await saveInstanceCredentials(instance.id, delta);
        }
        await reloadInstances();
        await reload();
        await refreshInstance(instance.id);
      } else {
        const filled: Record<string, string> = {};
        for (const [slot, value] of Object.entries(written)) {
          if (value !== null) filled[slot] = value;
        }
        const created = await addInstance(kind, values.note.trim(), filled, {
          autoRefresh: values.autoRefresh,
          threshold: threshold === "" ? null : Number(threshold),
          balanceThreshold:
            spec.balanceThreshold && balanceThreshold !== "" ? Number(balanceThreshold) : null,
          ...(hasMultipleSites(kind) ? { site: values.site } : {}),
        });
        await refreshInstance(created.id);
      }
      onOpenChange(false);
    } catch (error) {
      // 后端拒绝不是字段形状的错误，走顶部横幅（ADR-0024：失败必须可见）
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, (nextErrors) => {
    const id = firstInvalidFieldId(nextErrors, spec);
    if (id) document.getElementById(id)?.focus();
  });

  const thresholdConfig = spec.threshold;
  const balanceThresholdConfig = spec.balanceThreshold;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 保存进行中拦下 ESC/遮罩关闭（ADR-0024 可见性）：半途关掉后保存结果
        // 会写进已关闭的弹窗，新建路径用户完全得不到反馈
        if (!next && isSubmitting) return;
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

          <Field invalid={Boolean(errors.note)} className="space-y-2.5">
            <FieldLabel htmlFor="instance-note">{t("备注")}</FieldLabel>
            <Input
              id="instance-note"
              placeholder={t("如：公司主账号")}
              aria-invalid={Boolean(errors.note) || undefined}
              aria-describedby={
                errors.note ? "instance-note-error instance-note-hint" : "instance-note-hint"
              }
              {...register("note")}
            />
            <FieldErrorMessage id="instance-note-error" error={errors.note} params={{ max: NOTE_MAX_LENGTH }} />
            <FieldDescription id="instance-note-hint">
              {t("备注会作为卡片标题；留空时显示供应商名。")}
            </FieldDescription>
          </Field>

          {hasMultipleSites(kind) && (
            <>
              <Separator />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <FieldLabel htmlFor="instance-site">{t("站点")}</FieldLabel>
                  <p className="mt-1 text-[13px] text-fg-muted">
                    {t("两套登录域互不相通，请选择账号所在的站点；换站后需重新粘贴对应站点的凭据。")}
                  </p>
                </div>
                <Controller
                  name="site"
                  control={control}
                  render={({ field }) => (
                    <Select
                      id="instance-site"
                      // label 是中文源文案（i18n 键），渲染时按界面语言翻译
                      options={siteOptions(kind).map((option) => ({ ...option, label: t(option.label) }))}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      disabled={isSubmitting}
                    />
                  )}
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
              const siteGuide = siteProfiles[kind]?.[watchedSite]?.help;
              const collapsedGuide = spec.fields.length > 1;
              const groupDiagnosis = groupDiagnosisFor(kind, credentialValues, watchedSite);
              return (
                <>
                  {spec.fields.map((field) => {
                    const inlineHelp = field.help ?? (collapsedGuide ? undefined : siteGuide);
                    const diagnosis = groupDiagnosis
                      ? null
                      : diagnosisFor(kind, field.slot, credentialValues, watchedSite);
                    const slotError = errors.credentials?.[field.slot];
                    const hintId = `slot-${field.slot}-hint`;
                    const optionalHintId = `slot-${field.slot}-optional-hint`;
                    const errorId = `slot-${field.slot}-error`;
                    const describedBy = [
                      field.optionalHint && !field.required ? optionalHintId : null,
                      inlineHelp ? hintId : null,
                      slotError ? errorId : null,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <Field key={field.slot} invalid={Boolean(slotError)}>
                        <div className="flex items-center justify-between">
                          <FieldLabel htmlFor={`slot-${field.slot}`} required={field.required}>
                            {t(field.label)}
                          </FieldLabel>
                          {editing && (
                            <StatusBadge configured={Boolean(credentialStatus?.[field.slot])} />
                          )}
                        </div>
                        <Controller
                          name={`credentials.${field.slot}`}
                          control={control}
                          render={({ field: input }) => (
                            <SecretField
                              id={`slot-${field.slot}`}
                              value={input.value ?? ""}
                              placeholder={field.placeholder ? t(field.placeholder) : undefined}
                              disabled={saveDisabled || isSubmitting}
                              invalid={Boolean(slotError)}
                              describedBy={describedBy || undefined}
                              onChange={(value) => input.onChange(value)}
                              onBlur={input.onBlur}
                              onClear={() => void clearCredential(field.slot)}
                              clearDisabled={
                                !(credentialValues[field.slot] ?? "").trim() || !editing
                              }
                            />
                          )}
                        />
                        <FieldErrorMessage id={errorId} error={slotError} />
                        {field.optionalHint && !field.required && (
                          <FieldDescription id={optionalHintId}>{t(field.optionalHint)}</FieldDescription>
                        )}
                        {inlineHelp && (
                          <FieldDescription id={hintId}>{t(inlineHelp)}</FieldDescription>
                        )}
                        {diagnosis && (
                          <DiagnosisButton
                            test={diagnosis.test}
                            disabled={saveDisabled || isSubmitting || diagnosis.disabled}
                          />
                        )}
                      </Field>
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
                      disabled={saveDisabled || isSubmitting || groupDiagnosis.disabled}
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
                <FieldLabel>{t("自动刷新")}</FieldLabel>
                <p className="mt-1 text-[13px] text-fg-muted">
                  {!settings.refreshEnabled
                    ? t("需先在设置中开启自动刷新总开关。")
                    : t("跟随全局刷新间隔，手动刷新不受此开关影响。")}
                </p>
              </div>
              <Controller
                name="autoRefresh"
                control={control}
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    disabled={!settings.refreshEnabled || isSubmitting}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <FieldLabel
                  htmlFor="instance-threshold"
                  className={balanceThresholdConfig ? undefined : "whitespace-nowrap"}
                >
                  {t(thresholdConfig.label)}
                </FieldLabel>
                <p className="mt-1 text-[13px] text-fg-muted">{t(thresholdConfig.hint)}</p>
                <FieldErrorMessage
                  id="instance-threshold-error"
                  error={errors.threshold}
                  params={{ min: thresholdConfig.min, max: thresholdConfig.max }}
                />
              </div>
              <input
                id="instance-threshold"
                type="number"
                min={thresholdConfig.min}
                max={thresholdConfig.max}
                step={1}
                disabled={!settings.alertsEnabled || isSubmitting}
                aria-invalid={Boolean(errors.threshold) || undefined}
                aria-describedby={errors.threshold ? "instance-threshold-error" : undefined}
                {...register("threshold")}
                className="tnum h-9 w-28 shrink-0 rounded-md border border-line bg-surface px-2 text-right text-[13px] text-fg shadow-sm focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 aria-[invalid=true]:border-danger"
              />
            </div>

            {balanceThresholdConfig && (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <FieldLabel htmlFor="instance-balance-threshold">
                    {t(balanceThresholdConfig.label)}
                  </FieldLabel>
                  <p className="mt-1 text-[13px] text-fg-muted">{t(balanceThresholdConfig.hint)}</p>
                  <FieldErrorMessage
                    id="instance-balance-threshold-error"
                    error={errors.balanceThreshold}
                    params={{ min: balanceThresholdConfig.min, max: balanceThresholdConfig.max }}
                  />
                </div>
                <input
                  id="instance-balance-threshold"
                  type="number"
                  min={balanceThresholdConfig.min}
                  max={balanceThresholdConfig.max}
                  step={1}
                  disabled={!settings.alertsEnabled || isSubmitting}
                  aria-invalid={Boolean(errors.balanceThreshold) || undefined}
                  aria-describedby={
                    errors.balanceThreshold ? "instance-balance-threshold-error" : undefined
                  }
                  {...register("balanceThreshold")}
                  className="tnum h-9 w-28 shrink-0 rounded-md border border-line bg-surface px-2 text-right text-[13px] text-fg shadow-sm focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 aria-[invalid=true]:border-danger"
                />
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("取消")}
          </Button>
          <Button size="sm" disabled={saveDisabled || isSubmitting} onClick={() => void submit()}>
            {isSubmitting ? (
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
