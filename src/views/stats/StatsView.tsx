import { useState } from "react";
import { Sparkles, TerminalSquare } from "lucide-react";
import { Tabs } from "../../components/ui/tabs";
import { DeepSeekStats } from "./DeepSeekStats";
import { OpenCodeStats } from "./OpenCodeStats";

type ProviderTab = "deepseek" | "opencode";

/**
 * 用量统计页：同一页面整合多个供应商统计模块。
 * 新增供应商时：在 tabs 中注册一项，并在下方挂载对应的独立模块组件即可。
 */
export function StatsView() {
  const [tab, setTab] = useState<ProviderTab>("deepseek");

  return (
    <div className="space-y-4">
      <Tabs<ProviderTab>
        value={tab}
        onChange={setTab}
        items={[
          { value: "deepseek", label: "DeepSeek 官方", icon: <Sparkles className="h-3.5 w-3.5" /> },
          { value: "opencode", label: "OpenCode Go", icon: <TerminalSquare className="h-3.5 w-3.5" /> },
        ]}
      />
      {tab === "deepseek" ? <DeepSeekStats /> : <OpenCodeStats />}
    </div>
  );
}
