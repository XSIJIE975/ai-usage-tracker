import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, FolderGit2, UserRound } from "lucide-react";
import { Card, CardContent } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import appIcon from "../../assets/app-icon.png";

const REPO_URL = "https://github.com/XSIJIE975/ai-usage-tracker";
const RELEASES_URL = `${REPO_URL}/releases`;

/** 关于：应用标识、当前版本、开发者信息与 GitHub 入口 */
export function AboutCard() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <img
            src={appIcon}
            alt="AI 用量助手图标"
            className="h-14 w-14 shrink-0 rounded-xl border border-line shadow-sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-fg">AI 用量助手</h3>
              <span className="text-xs text-fg-muted">AI Usage Tracker</span>
              {version && (
                <Badge variant="neutral" className="tnum">
                  v{version}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-secondary">
              跨平台桌面工具，在系统托盘快速查看 AI 订阅与 API 用量。数据全程仅保存在本机。
            </p>
            <div className="mt-2.5 flex items-center gap-1.5 text-[13px] text-fg-secondary">
              <UserRound className="h-3.5 w-3.5 text-fg-muted" />
              开发者
              <span className="font-medium text-fg">XSIJIE</span>
            </div>
            <div className="mt-3.5 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void openUrl(RELEASES_URL)}>
                <Download className="h-3.5 w-3.5" />
                发布页
              </Button>
              <Button variant="outline" size="sm" onClick={() => void openUrl(REPO_URL)}>
                <FolderGit2 className="h-3.5 w-3.5" />
                GitHub 仓库
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
