import { Download } from "lucide-react";

import { applyParams, useT } from "../i18n";
import { useUpdateStore } from "../store/useUpdateStore";
import { formatBytes } from "../lib/utils";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";

/**
 * 更新安装操作区：available→下载按钮、downloading→进度、ready→即将安装提示，
 * 其余状态不渲染。设置抽屉的检查更新卡片与更新日志弹窗两处入口共用同一状态源
 * （useUpdateStore），从哪边操作都是同一件事。
 */
export function UpdateInstallButton() {
  const status = useUpdateStore((state) => state.status);
  const version = useUpdateStore((state) => state.version);
  const downloadedBytes = useUpdateStore((state) => state.downloadedBytes);
  const contentLength = useUpdateStore((state) => state.contentLength);
  const downloadAndInstall = useUpdateStore((state) => state.downloadAndInstall);
  const t = useT();

  if (status === "available") {
    return (
      <Button size="sm" onClick={() => void downloadAndInstall()}>
        <Download className="h-3.5 w-3.5" /> {t("下载并安装")}
      </Button>
    );
  }

  if (status === "downloading") {
    const percent = contentLength ? Math.min(100, (downloadedBytes / contentLength) * 100) : 0;
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[13px] text-fg-muted">
          <span>
            {t("正在下载")} v{version}…
          </span>
          <span>
            {contentLength
              ? `${formatBytes(downloadedBytes)} / ${formatBytes(contentLength)}`
              : applyParams(t("已下载 {downloaded}"), { downloaded: formatBytes(downloadedBytes) })}
          </span>
        </div>
        <Progress value={percent} />
      </div>
    );
  }

  if (status === "ready") {
    return <p className="text-[13px] text-success">{t("下载完成，即将安装…")}</p>;
  }

  return null;
}
