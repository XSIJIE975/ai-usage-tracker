/**
 * @vitest-environment jsdom
 *
 * 更新日志弹窗（ADR-0044）：单实例挂在 Dashboard，两个模式——
 * manual：顶栏更新 icon 与设置抽屉「查看更新日志」入口打开，展示内嵌全量历史；
 *   有待安装的新版本时，顶部多一块「新版本」区块（updater 变更说明 + 安装操作）。
 * whats-new：升级后首次启动由对账逻辑打开，按 (升级前, 当前] 区间聚合，跨版本
 *   升级能看到中间所有版本；升级前=null（弹窗功能之前的升级用户）只展示当前一条，
 *   副题相应不带来源版本。数据来自新安装包内嵌的 changelog.json。
 */
import { useEffect, useState } from "react";
import { ArrowUpCircle, ExternalLink, History } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { applyParams, useT } from "../i18n";
import { releaseTagUrl } from "../lib/app-meta";
import { loadChangelog, resolveChangelogPrompt, type ChangelogEntry } from "../lib/changelog";
import { useChangelogDialogStore } from "../store/useChangelogDialogStore";
import { useUpdateStore } from "../store/useUpdateStore";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { EmptyState } from "./ui/empty-state";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { ReleaseNotes } from "./ReleaseNotes";
import { UpdateInstallButton } from "./UpdateInstallButton";

export function ChangelogDialog() {
  const open = useChangelogDialogStore((state) => state.open);
  const mode = useChangelogDialogStore((state) => state.mode);
  const fromVersion = useChangelogDialogStore((state) => state.fromVersion);
  const toVersion = useChangelogDialogStore((state) => state.toVersion);
  const close = useChangelogDialogStore((state) => state.close);

  const updateStatus = useUpdateStore((state) => state.status);
  const updateVersion = useUpdateStore((state) => state.version);
  const updateNotes = useUpdateStore((state) => state.notes);

  const t = useT();
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setEntries(null);
    setLoadError(false);
    loadChangelog()
      .then((loaded) => {
        if (!disposed) setEntries(loaded);
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(true);
        console.warn("更新日志加载失败：", error);
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const visibleEntries =
    mode === "whats-new" && toVersion && entries
      ? resolveChangelogPrompt(fromVersion, toVersion, entries)
      : entries;

  const hasPendingUpdate =
    updateStatus === "available" || updateStatus === "downloading" || updateStatus === "ready";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent aria-describedby={undefined} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "whats-new" ? t("本次更新内容") : t("更新日志")}</DialogTitle>
          {/* 副题是视觉说明，不接 Radix Description 关联（两种模式描述形态不同，统一不关联） */}
          {mode === "whats-new" && toVersion && (
            <p className="text-[13px] leading-relaxed text-fg-muted">
              {fromVersion
                ? applyParams(t("从 {from} 更新到 {to}"), { from: `v${fromVersion}`, to: `v${toVersion}` })
                : applyParams(t("已更新到 {to}"), { to: `v${toVersion}` })}
            </p>
          )}
        </DialogHeader>
        <DialogBody className="space-y-4">
          {loadError ? (
            <EmptyState
              icon={<History className="h-5 w-5" />}
              title={t("更新日志加载失败")}
              description={t("重启应用后可重试。")}
            />
          ) : visibleEntries === null ? null : (
            <>
              {mode === "manual" && hasPendingUpdate && (
                <UpdateAvailableSection
                  version={updateVersion}
                  notes={updateNotes}
                  hasNotes={Boolean(updateNotes)}
                />
              )}
              {visibleEntries.length === 0 && !(mode === "manual" && hasPendingUpdate) ? (
                <EmptyState
                  icon={<History className="h-5 w-5" />}
                  title={t("暂无更新日志")}
                  description={t("发布版本后会出现在这里。")}
                />
              ) : (
                visibleEntries.map((entry) => <ChangelogEntryItem key={entry.version} entry={entry} />)
              )}
            </>
          )}
        </DialogBody>
        {mode === "whats-new" && (
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={close}>
              {t("知道了")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** manual 模式顶部的「新版本」区块：updater 变更说明 + 安装操作（与设置抽屉共用状态源）。
 *  说明不自滚：滚动只由 DialogBody 一层负责（多层内滚没法看，ADR-0044） */
function UpdateAvailableSection({
  version,
  notes,
  hasNotes,
}: {
  version: string | null;
  notes: string | null;
  hasNotes: boolean;
}) {
  const t = useT();
  return (
    <section className="space-y-3 rounded-md border border-brand/30 bg-surface-2 p-3">
      <p className="flex items-center text-sm font-medium text-fg">
        <ArrowUpCircle className="mr-1.5 h-4 w-4 shrink-0 text-brand" />
        {t("发现新版本")} v{version}
      </p>
      {hasNotes && <ReleaseNotes markdown={notes ?? ""} scrollable={false} />}
      <UpdateInstallButton />
    </section>
  );
}

function ChangelogEntryItem({ entry }: { entry: ChangelogEntry }) {
  const t = useT();
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium text-fg">
        <span className="tnum">v{entry.version}</span>
        <span className="text-xs font-normal text-fg-muted">{entry.date}</span>
        <IconButton
          size="sm"
          className="ml-auto text-fg-muted"
          title={applyParams(t("在 GitHub 查看 v{version} 的发布"), { version: entry.version })}
          aria-label={applyParams(t("在 GitHub 查看 v{version} 的发布"), { version: entry.version })}
          onClick={() => void openUrl(releaseTagUrl(entry.version))}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </IconButton>
      </h3>
      <ReleaseNotes markdown={entry.notes} scrollable={false} />
    </section>
  );
}
