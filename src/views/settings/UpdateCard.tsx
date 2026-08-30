import { useEffect } from "react";
import { ArrowUpCircle, Download, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Progress } from "../../components/ui/progress";
import { cn, formatBytes } from "../../lib/utils";
import { updateSupported, useUpdateStore } from "../../store/useUpdateStore";
import { useT } from "../../i18n";

export function UpdateCard() {
  const {
    status,
    version,
    notes,
    currentVersion,
    downloadedBytes,
    contentLength,
    error,
    check,
    downloadAndInstall,
    loadCurrentVersion,
  } = useUpdateStore();

  const supported = updateSupported();
  const t = useT();

  useEffect(() => {
    if (supported) void loadCurrentVersion();
  }, [supported, loadCurrentVersion]);

  const busy = status === "checking" || status === "downloading";
  const percent = contentLength ? Math.min(100, (downloadedBytes / contentLength) * 100) : 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
            <CardTitle>{t("检查更新")}</CardTitle>
          <CardDescription>
            {currentVersion ? `${t("当前版本")} v${currentVersion}` : t("更新会修复问题并带来新功能。")}
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!supported || busy}
          onClick={() => void check()}
          aria-label={status === "checking" ? t("检查中") : t("检查更新")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", status === "checking" && "animate-spin")} />
          {status === "checking" ? t("检查中…") : t("检查更新")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!supported && (
          <p className="text-[13px] text-fg-muted">{t("开发构建不支持检查更新，安装正式包后可用。")}</p>
        )}

        {supported && status === "idle" && (
          <p className="text-[13px] text-fg-muted">启动后会自动在后台检查新版本，也可以随时手动检查。</p>
        )}

        {status === "up-to-date" && (
          <p className="text-[13px] text-success">{t("已是最新版本。")}</p>
        )}

        {status === "available" && (
          <div className="space-y-3 rounded-md border border-brand/30 bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center text-sm font-medium text-fg">
                <ArrowUpCircle className="mr-1.5 h-4 w-4 text-brand" />
                {t("发现新版本")} v{version}
              </p>
              <Button size="sm" onClick={() => void downloadAndInstall()}>
                <Download className="h-3.5 w-3.5" /> {t("下载并安装")}
              </Button>
            </div>
            {notes && (
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-fg-secondary">
                {notes}
              </p>
            )}
          </div>
        )}

        {status === "downloading" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[13px] text-fg-muted">
              <span>{t("正在下载")} v{version}…</span>
              <span>
                {contentLength
                  ? `${formatBytes(downloadedBytes)} / ${formatBytes(contentLength)}`
                  : `已下载 ${formatBytes(downloadedBytes)}`}
              </span>
            </div>
            <Progress value={percent} />
          </div>
        )}

        {status === "ready" && (
          <p className="text-[13px] text-success">{t("下载完成，即将安装…")}</p>
        )}

        {status === "error" && (
          <div className="space-y-2 rounded-md border border-danger/30 bg-danger-soft p-3">
            <p className="text-[13px] leading-relaxed text-danger-soft-fg">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void check()}>
              {t("重试")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
