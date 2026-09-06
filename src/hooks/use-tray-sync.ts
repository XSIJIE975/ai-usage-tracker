import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AppSettings, MetricLine, ProviderInstance, ProviderSnapshot } from "../types/ipc";
import { useAlertStore } from "../store/useAlertStore";
import { displayName, selectOrderedInstances } from "../lib/instance";
import { applyParams, useT } from "../i18n";
import type { Language } from "../i18n";

type Translate = (text: string) => string;

/** 托盘计量展示的一个配额窗口 */
export interface TrayMeterWindow {
  /** 已用百分比 */
  percent: number;
  /** 本地化窗口名（如「5 小时请求配额」「本周额度」） */
  label: string;
  /** 重置时刻（ISO）；null = 未知（GLM 滚动窗口的 nextResetTime 常缺失） */
  resetsAt: string | null;
}

export interface TrayMeterCandidate {
  instance: ProviderInstance;
  providerName: string;
  /** 全部配额窗口，按重置时间近→远排序（柱的上→下渲染顺序） */
  windows: TrayMeterWindow[];
  /** 最紧窗口已用百分比（全部窗口的最大值）：环/macOS 数字展示它，也是自动排序主键 */
  percent: number;
  /** 最紧窗口（设置页「当前展示」的原因标注用它） */
  tightestWindow: TrayMeterWindow;
  /** 全部窗口已用百分比之和（max 平手时的裁定键："两扇都快用完"排在"只烧一扇"前） */
  totalPercent: number;
  /** 柱渲染对：已用%最高的两个窗口，按重置近→远排（[上条, 下条]）；单窗实例只有一个 */
  barWindows: TrayMeterWindow[];
}

function resetTimestamp(resetsAt: string | null): number {
  if (!resetsAt) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(resetsAt);
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

/** 参与托盘计量的候选：刷新成功且至少一条有效配额窗口行。
    不要求 resetsAt：GLM 滚动窗口可能没有 nextResetTime，但仍是百分比量纲。
    余额等金额量纲实例（DeepSeek）无窗口，不参与展示，仅通过告警影响图标颜色 */
export function buildTrayCandidates(
  instances: ProviderInstance[],
  snapshots: ProviderSnapshot[],
  translate: Translate,
): TrayMeterCandidate[] {
  return selectOrderedInstances(instances)
    .map<TrayMeterCandidate | null>((instance) => {
      const snapshot = snapshots.find((item) => item.instanceId === instance.id);
      if (!snapshot || snapshot.status !== "ok") return null;
      const windows = snapshot.lines
        .filter(
          (line): line is MetricLine & { percentUsed: number } =>
            line.type === "progress" && typeof line.percentUsed === "number",
        )
        .map((line) => ({
          percent: line.percentUsed,
          label: applyParams(translate(line.label), line.params),
          resetsAt: line.resetsAt ?? null,
        }))
        .sort((a, b) => resetTimestamp(a.resetsAt) - resetTimestamp(b.resetsAt));
      if (windows.length === 0) return null;
      const percent = Math.max(...windows.map((window) => window.percent));
      const tightestWindow = windows.find((window) => window.percent === percent) ?? windows[0];
      // 柱渲染对：已用%最高的两个（稳定排序保序），再按 windows 既有的近→远顺序输出
      const top2 = [...windows].sort((a, b) => b.percent - a.percent).slice(0, 2);
      const barWindows = windows.filter((window) => top2.includes(window));
      return {
        instance,
        providerName: snapshot.providerName,
        windows,
        percent,
        tightestWindow,
        totalPercent: windows.reduce((sum, window) => sum + window.percent, 0),
        barWindows,
      };
    })
    .filter((item): item is TrayMeterCandidate => item !== null);
}

/**
 * 图标展示谁（ADR-0016 自动选例规则）：
 * 1. 显式钉选（trayPinnedInstanceId）最高优先，未命中候选时走自动；
 * 2. 自动先按实例列表「置顶」分组：候选中有置顶实例时只在置顶集合内选（用户的主力名单，行为可预期）；
 * 3. 组内排序：告警中的优先 → 最紧窗口%降序（谁下一次撞限额最近）→ 全窗之和降序
 *    （"两扇都快用完"排在"只烧一扇"前）→ 列表顺序稳定兜底。
 */
export function selectTrayMeter(
  candidates: TrayMeterCandidate[],
  pinnedId: string,
  alertActive: Record<string, boolean>,
): TrayMeterCandidate | null {
  const pinned = candidates.find((item) => item.instance.id === pinnedId);
  if (pinned) return pinned;
  const pinnedGroup = candidates.filter((item) => item.instance.pinned);
  const pool = pinnedGroup.length > 0 ? pinnedGroup : candidates;
  return [...pool].sort((a, b) => {
    const alertDiff =
      Number(alertActive[b.instance.id] === true) - Number(alertActive[a.instance.id] === true);
    if (alertDiff !== 0) return alertDiff;
    if (a.percent !== b.percent) return b.percent - a.percent;
    if (a.totalPercent !== b.totalPercent) return b.totalPercent - a.totalPercent;
    return 0;
  })[0] ?? null;
}

/**
 * 托盘呈现同步（ADR-0016）：主窗口是唯一写入方，在快照/告警态/相关设置变化时
 * 按自动规则（或钉选）选出实例，推送最紧窗口与柱窗口供 Rust 重绘托盘。
 * 方案切换单独推送（切换即生效）。静默启动/关窗驻留时主窗口 webview 仍常驻，此推送持续工作。
 */
export function useTraySync(
  instances: ProviderInstance[],
  snapshots: ProviderSnapshot[],
  settings: AppSettings,
  language: Language,
) {
  const alertActiveMap = useAlertStore((state) => state.active);
  const t = useT();
  const lastPushRef = useRef("");

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_tray_icon_scheme", { scheme: settings.trayIconScheme }).catch(() => undefined);
  }, [settings.trayIconScheme]);

  useEffect(() => {
    if (!isTauri()) return;
    const alert = Object.values(alertActiveMap).some(Boolean);
    const chosen = selectTrayMeter(
      buildTrayCandidates(instances, snapshots, t),
      settings.trayPinnedInstanceId,
      alertActiveMap,
    );
    const ringPercent = chosen?.percent ?? null;
    const barTop = chosen?.barWindows[0]?.percent ?? null;
    const barBottom = chosen?.barWindows[1]?.percent ?? null;
    // tooltip 多行摘要：首行实例名，其后每个配额窗口一行（顺序与柱的上→下一致）
    const windowText = (window: TrayMeterWindow) =>
      `${window.label}（${t("已用")} ${Math.round(window.percent)}%）`;
    const summary = chosen
      ? [
          displayName(chosen.instance, chosen.providerName),
          ...chosen.windows.map(windowText),
        ].join("\n")
      : null;
    const key = `${ringPercent}|${barTop}|${barBottom}|${alert}|${summary}|${language}`;
    if (key === lastPushRef.current) return;
    lastPushRef.current = key;
    void invoke("update_tray_meter", {
      ringPercent,
      barTop,
      barBottom,
      alert,
      summary,
      language,
    }).catch(() => undefined);
  }, [instances, snapshots, alertActiveMap, settings.trayPinnedInstanceId, language]);
}
