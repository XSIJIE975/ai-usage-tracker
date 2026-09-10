import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAppStore } from "../store/useAppStore";
import { en } from "./en";

export type Language = "zh" | "en";
export type LanguageSetting = "auto" | "zh" | "en";

/** 英文字典：键为中文源文案 */
type Dict = Record<string, string>;

const dictionaries: Record<Language, Dict | undefined> = {
  zh: undefined, // 源语言即兜底，无需字典
  en,
};

function detectLanguage(): Language {
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function resolveLanguage(setting: LanguageSetting): Language {
  if (setting === "zh" || setting === "en") return setting;
  return detectLanguage();
}

const LanguageContext = createContext<Language>("zh");

/** 语言上下文：由设置驱动，auto 时按系统语言检测（中文→zh，其余→en） */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const setting = useAppStore((state) => state.settings.interfaceLanguage);
  const language = useMemo(() => resolveLanguage(setting), [setting]);
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

/** 翻译函数：返回当前语言的文案；en 缺失键回退中文源文案。
 *  开发实例的应用名统一在此追加 (dev) 后缀（ADR-0018）：所有 t("AI 用量助手") 出口
 *  （主窗口标题栏、速览/快速面板头部、关于页、托盘预览）一处加缀全局生效，
 *  与 Rust 侧 app_title/tray_tooltip 的后缀约定保持一致。 */
export function useT() {
  const language = useContext(LanguageContext);
  const dict = dictionaries[language];
  return (text: string): string => {
    const translated = dict ? (dict[text] ?? text) : text;
    if (import.meta.env.DEV && text === "AI 用量助手") return `${translated} (dev)`;
    return translated;
  };
}

/** 纯函数从 ./apply-params 转发：保持既有导入路径不变；
 *  处于 store 导入链上的非 React 模块请直接走纯模块，避免循环导入 */
export { applyParams } from "./apply-params";

/** 当前解析后的语言（供非字典的模板格式化使用，如预测文案） */
export function useLanguage(): Language {
  return useContext(LanguageContext);
}
