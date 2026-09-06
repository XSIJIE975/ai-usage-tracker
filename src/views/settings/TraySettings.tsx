import type { ReactNode } from "react";
import { useAppStore } from "../../store/useAppStore";
import { useAlertStore } from "../../store/useAlertStore";
import { displayName } from "../../lib/instance";
import { providerName } from "../../providers";
import type { AppSettings } from "../../types/ipc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { HintTooltip } from "../../components/ui/tooltip";
import { Label } from "../../components/ui/label";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { Separator } from "../../components/ui/separator";
import { Switch } from "../../components/ui/switch";
import { BrandIcon } from "../../components/BrandIcon";
import { GlanceCards } from "../../components/glance/GlanceCards";
import { GlanceRows } from "../../components/glance/GlanceRows";
import {
  buildGlanceInstances,
  statusDotColor,
  type GlanceInstance,
} from "../../components/glance/data";
import type { GlanceFieldFlags } from "../../components/glance/GlanceRows";
import { buildTrayCandidates, selectTrayMeter } from "../../hooks/use-tray-sync";
import { cn } from "../../lib/utils";
import { useT } from "../../i18n";
import { SavedHint, useSaveFlash } from "./save-flash";

/** 托盘计量图标（环/柱）的静态色：品牌色不随用量档位变化，仅告警强制红。
    与 Rust 端 tray_scheme 的 meter_color 同口径；面板内的档位配色不受影响 */
function trayMeterColor(alert: boolean): string {
  return alert ? "var(--danger)" : "var(--brand)";
}

/**
 * 托盘与速览设置（ADR-0016），拆为两张卡：
 * 「托盘图标」——方案选择做成预览卡（用量环按真实最紧实例数据渲染）+ 钉选实例（含实时最紧提示）；
 * 「速览面板」——迷你实时预览（复用面板本体组件）+ 展示形态/范围/字段。
 * 保存即生效：托盘经 useTraySync 推送 Rust 重绘，面板经 settings-changed 广播同步。
 */
export function TraySettings() {
  const settings = useAppStore((state) => state.settings);
  const instances = useAppStore((state) => state.instances);
  const snapshots = useAppStore((state) => state.snapshots);
  const refreshingInstances = useAppStore((state) => state.refreshingInstances);
  const loading = useAppStore((state) => state.loading);
  const alertActiveMap = useAlertStore((state) => state.active);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const trayFlash = useSaveFlash();
  const glanceFlash = useSaveFlash();
  const t = useT();

  async function save(patch: Partial<AppSettings>, target: "tray" | "glance") {
    const current = useAppStore.getState().settings;
    await saveSettings({ ...current, ...patch });
    (target === "tray" ? trayFlash : glanceFlash).flash();
  }

  function toggleInstanceId(instanceId: string, checked: boolean) {
    const current = useAppStore.getState().settings;
    const ids = new Set(current.glanceInstanceIds);
    if (checked) ids.add(instanceId);
    else ids.delete(instanceId);
    void save({ glanceInstanceIds: [...ids] }, "glance");
  }

  // 与托盘实际呈现同一口径：显式钉选 → 置顶分组 → 告警/最紧窗口/全窗之和（ADR-0016）
  const candidates = buildTrayCandidates(instances, snapshots, t);
  const chosen = selectTrayMeter(candidates, settings.trayPinnedInstanceId, alertActiveMap);
  const percentById = new Map(candidates.map((item) => [item.instance.id, item.percent]));
  const anyAlert = Object.values(alertActiveMap).some(Boolean);
  // 计量方案（环/柱）共用钉选选择器；默认图标方案无计量含义，隐藏该行
  const meterEnabled = settings.trayIconScheme !== "default";
  const customScope = settings.glanceInstanceScope === "custom";

  const scopedInstances =
    settings.glanceInstanceScope === "custom"
      ? instances.filter((instance) => settings.glanceInstanceIds.includes(instance.id))
      : instances;
  const glanceItems = buildGlanceInstances(scopedInstances, snapshots, {
    alertActive: alertActiveMap,
    refreshing: refreshingInstances,
    loading,
    translate: t,
  });
  const glanceFields: GlanceFieldFlags = {
    showAlerts: settings.glanceShowAlerts,
    showBalance: settings.glanceShowBalance,
    showReset: settings.glanceShowReset,
    showWindows: settings.glanceShowWindows,
  };

  return (
    <>
      {/* ---- 托盘图标 ---- */}
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
          <div className="space-y-1.5">
            <CardTitle>{t("托盘图标")}</CardTitle>
            <CardDescription>{t("系统托盘中图标的展示形态。")}</CardDescription>
          </div>
          <SavedHint visible={trayFlash.visible} />
        </CardHeader>
        <CardContent className="space-y-5">
          <div role="radiogroup" aria-label={t("图标方案")} className="grid max-w-2xl grid-cols-3 gap-3">
            <SchemeCard
              selected={settings.trayIconScheme === "default"}
              title={t("默认图标")}
              preview={<BrandIcon size={34} className="rounded-[7px]" />}
              onClick={() => void save({ trayIconScheme: "default" }, "tray")}
            />
            <SchemeCard
              selected={settings.trayIconScheme === "usage-ring"}
              title={t("环形计量")}
              caption={chosen ? `${Math.round(chosen.percent)}%` : "—"}
              preview={<TrayRingPreview percent={chosen?.percent ?? null} alert={anyAlert} />}
              onClick={() => void save({ trayIconScheme: "usage-ring" }, "tray")}
            />
            <SchemeCard
              selected={settings.trayIconScheme === "usage-bars"}
              title={t("条形计量")}
              caption={
                chosen && chosen.barWindows.length > 0
                  ? chosen.barWindows.map((window) => `${Math.round(window.percent)}%`).join(" · ")
                  : "—"
              }
              preview={
                <TrayBarsPreview
                  top={chosen?.barWindows[0]?.percent ?? null}
                  bottom={chosen?.barWindows[1]?.percent ?? null}
                  alert={anyAlert}
                />
              }
              onClick={() => void save({ trayIconScheme: "usage-bars" }, "tray")}
            />
          </div>

          {meterEnabled && (
            <>
              <Separator />
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="tray-pinned-instance">{t("图标展示的实例")}</Label>
                    <HintTooltip
                      tip={t("默认自动选择用量最高的实例（谁最接近用完就显示谁）。也可以固定显示某个实例；如果它暂时没有数据，会自动退回显示用量最高的实例。")}
                    />
                  </div>
                  <p className="mt-1 text-[13px] text-fg-muted">
                    {chosen
                      ? `${t("当前展示")}：${displayName(chosen.instance, chosen.providerName)}（${chosen.tightestWindow.label} ${Math.round(chosen.tightestWindow.percent)}%）`
                      : t("暂无用量数据")}
                  </p>
                </div>
                <Select
                  id="tray-pinned-instance"
                  value={settings.trayPinnedInstanceId}
                  onChange={(value) => void save({ trayPinnedInstanceId: value }, "tray")}
                  options={[
                    { value: "", label: t("自动（用量最高的实例）") },
                    ...instances.map((instance) => {
                      const name = displayName(instance, providerName(instance.providerId));
                      const percent = percentById.get(instance.id);
                      return {
                        value: instance.id,
                        label: percent !== undefined ? `${name}（${Math.round(percent)}%）` : name,
                      };
                    }),
                  ]}
                  aria-label={t("图标展示的实例")}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---- 速览面板 ---- */}
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
          <div className="space-y-1.5">
            <CardTitle>{t("速览面板")}</CardTitle>
            <CardDescription>{t("托盘左键单击弹出的速览面板的内容与行为。")}</CardDescription>
          </div>
          <SavedHint visible={glanceFlash.visible} />
        </CardHeader>
        <CardContent className="space-y-5">
          <GlancePreview
            layout={settings.glanceLayout}
            fields={glanceFields}
            items={glanceItems}
            translate={t}
          />

          <div className="flex items-center justify-between gap-4">
            <Label>{t("展示形态")}</Label>
            <Segmented
              size="sm"
              value={settings.glanceLayout}
              onChange={(value) => void save({ glanceLayout: value }, "glance")}
              options={[
                { value: "list", label: t("列表") },
                { value: "cards", label: t("卡片") },
              ]}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <Label>{t("展示范围")}</Label>
            <Segmented
              size="sm"
              value={settings.glanceInstanceScope}
              onChange={(value) => void save({ glanceInstanceScope: value }, "glance")}
              options={[
                { value: "all", label: t("全部实例") },
                { value: "custom", label: t("自选实例") },
              ]}
            />
          </div>

          {customScope && (
            <div className="rounded-lg border border-line bg-surface-2/40 p-3">
              <div className="flex items-center justify-between pb-1.5">
                <span className="text-xs text-fg-muted">
                  {t("已选")} {settings.glanceInstanceIds.length}/{instances.length}
                </span>
                <span className="flex gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      void save({ glanceInstanceIds: instances.map((item) => item.id) }, "glance")
                    }
                    className="text-xs text-fg-muted transition-colors duration-fast hover:text-fg"
                  >
                    {t("全选")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void save({ glanceInstanceIds: [] }, "glance")}
                    className="text-xs text-fg-muted transition-colors duration-fast hover:text-fg"
                  >
                    {t("清空")}
                  </button>
                </span>
              </div>
              {instances.length === 0 ? (
                <p className="py-2 text-[13px] text-fg-muted">{t("还没有供应商")}</p>
              ) : (
                <div>
                  {instances.map((instance) => {
                    const percent = percentById.get(instance.id);
                    const snapshot = snapshots.find((item) => item.instanceId === instance.id);
                    return (
                      <label
                        key={instance.id}
                        className="flex cursor-pointer items-center gap-2.5 rounded px-1.5 py-1.5 text-[13px] transition-colors duration-fast hover:bg-surface-2/70"
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 shrink-0"
                          style={{ accentColor: "var(--brand)" }}
                          checked={settings.glanceInstanceIds.includes(instance.id)}
                          onChange={(event) => toggleInstanceId(instance.id, event.target.checked)}
                        />
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: statusDotColor(snapshot ? snapshot.status : "no_data") }}
                          aria-hidden
                        />
                        <span className="min-w-0 truncate text-fg">
                          {displayName(instance, providerName(instance.providerId))}
                        </span>
                        <span className="tnum ml-auto shrink-0 text-fg-muted">
                          {percent !== undefined ? `${Math.round(percent)}%` : "—"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("展示字段")}</Label>
              <HintTooltip tip={t("控制每个实例上显示哪些信息。")} />
            </div>
            <FieldSwitch
              label={t("账户余额")}
              checked={settings.glanceShowBalance}
              onChange={(value) => void save({ glanceShowBalance: value }, "glance")}
            />
            <FieldSwitch
              label={t("重置倒计时")}
              checked={settings.glanceShowReset}
              onChange={(value) => void save({ glanceShowReset: value }, "glance")}
            />
            <FieldSwitch
              label={t("多窗口明细")}
              tip={t("同时显示 5 小时窗口、周配额等多个配额窗口各自的用量。")}
              checked={settings.glanceShowWindows}
              onChange={(value) => void save({ glanceShowWindows: value }, "glance")}
            />
            <FieldSwitch
              label={t("告警标记")}
              tip={t("触发告警的实例会加黄色边框和警示图标。")}
              checked={settings.glanceShowAlerts}
              onChange={(value) => void save({ glanceShowAlerts: value }, "glance")}
            />
          </div>

          <Separator />

          <FieldSwitch
            label={t("底部操作条")}
            tip={t("显示面板底部的通知中心和「打开主窗口」按钮。")}
            checked={settings.glanceShowFooter}
            onChange={(value) => void save({ glanceShowFooter: value }, "glance")}
          />

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <Label>{t("失焦自动隐藏")}</Label>
              <HintTooltip tip={t("点击面板以外的区域时，面板会自动收起。")} />
            </div>
            <Switch
              checked={settings.glanceAutoHide}
              onCheckedChange={(value) => void save({ glanceAutoHide: value }, "glance")}
            />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/** 方案预览卡：radio 语义，选中态品牌色描边 */
function SchemeCard({
  selected,
  title,
  caption,
  preview,
  onClick,
}: {
  selected: boolean;
  title: string;
  caption?: string;
  preview: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-2.5 rounded-lg border p-3 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
        selected
          ? "border-brand bg-brand-soft/40"
          : "border-line hover:border-line-strong hover:bg-surface-2/60",
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-2">
        {preview}
      </span>
      <span className={cn("text-[13px] font-medium", selected ? "text-fg" : "text-fg-secondary")}>
        {title}
        {caption && <span className="tnum ml-1.5 text-fg-muted">{caption}</span>}
      </span>
    </button>
  );
}

/** 用量环预览：与托盘端 draw_usage_ring 同构（顶部起点顺时针、15% 相对描边、留 2% 边距），
    颜色档位复用 metricColor（与面板、托盘 Rust 端同一套阈值），数据为当前真实最紧实例 */
function TrayRingPreview({
  percent,
  alert,
  size = 34,
}: {
  percent: number | null;
  alert: boolean;
  size?: number;
}) {
  const stroke = Math.max(2, size * 0.15);
  const radius = (size - stroke) / 2 - size * 0.02;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(percent ?? 0, 0));
  return (
    <svg width={size} height={size} className="-rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--line-strong)"
        strokeWidth={stroke}
      />
      {percent !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={trayMeterColor(alert)}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
        />
      )}
    </svg>
  );
}

/** 用量柱预览：与托盘端 draw_usage_bars 同构（横向胶囊条、上下堆叠、自左侧填充，
    上/下条由前端按「已用%最高的两个窗口、重置近→远」传入，下条缺失时单条居中），
    颜色为静态品牌色（trayMeterColor），数据为当前真实选中实例 */
function TrayBarsPreview({
  top,
  bottom,
  alert,
  size = 34,
}: {
  top: number | null;
  bottom: number | null;
  alert: boolean;
  size?: number;
}) {
  const barLength = size * 0.68;
  const barHeight = size * 0.2;
  const gap = size * 0.14;
  const radius = barHeight / 2;
  const left = (size - barLength) / 2;
  // 无配额数据时画双空轨道示意结构；单窗实例单条居中（与托盘端一致）
  const percents: (number | null)[] =
    top === null ? [null, null] : bottom === null ? [top] : [top, bottom];
  const totalHeight = barHeight * percents.length + gap * (percents.length - 1);
  const topY = (size - totalHeight) / 2;
  return (
    <svg width={size} height={size} aria-hidden>
      {percents.map((percent, index) => {
        const y = topY + index * (barHeight + gap);
        const fraction =
          percent === null ? 0 : Math.min(100, Math.max(percent, 0)) / 100;
        const fillWidth = radius * 2 + (barLength - radius * 2) * fraction;
        return (
          <g key={index}>
            <rect
              x={left}
              y={y}
              width={barLength}
              height={barHeight}
              rx={radius}
              fill="var(--line-strong)"
              fillOpacity={0.42}
            />
            {percent !== null && fraction > 0 && (
              <rect
                x={left}
                y={y}
                width={fillWidth}
                height={barHeight}
                rx={radius}
                fill={trayMeterColor(alert)}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 迷你实时预览：复用速览面板本体组件灌真数据，只读展示（不可滚动不可交互），
    固定高度 + 底部渐隐示意内容延续。字段/范围/形态开关的效果即时可见 */
function GlancePreview({
  layout,
  fields,
  items,
  translate,
}: {
  layout: "list" | "cards";
  fields: GlanceFieldFlags;
  items: GlanceInstance[];
  translate: (text: string) => string;
}) {
  return (
    <div className="relative mx-auto h-60 w-80 overflow-hidden rounded-lg border border-line bg-canvas">
      <div className="pointer-events-none select-none p-2.5" aria-hidden>
        <div className="mb-2 flex h-8 items-center gap-2 rounded-md border-b border-line bg-surface-2/60 px-2.5">
          <BrandIcon size={14} className="rounded-[4px]" />
          <span className="text-[11px] font-semibold text-fg">{translate("AI 用量助手")}</span>
        </div>
        {items.length === 0 ? (
          <div className="flex h-36 items-center justify-center text-[12px] text-fg-muted">
            {translate("暂无展示内容")}
          </div>
        ) : layout === "cards" ? (
          <GlanceCards items={items} fields={fields} translate={translate} />
        ) : (
          <GlanceRows items={items} fields={fields} translate={translate} />
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-canvas to-transparent" />
    </div>
  );
}

function FieldSwitch({
  label,
  tip,
  checked,
  onChange,
}: {
  label: string;
  tip?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-1.5">
        <Label>{label}</Label>
        {tip && <HintTooltip tip={tip} />}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
