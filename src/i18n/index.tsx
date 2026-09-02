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

/** 翻译函数：返回当前语言的文案；en 缺失键回退中文源文案 */
export function useT() {
  const language = useContext(LanguageContext);
  const dict = dictionaries[language];
  return (text: string): string => (dict ? (dict[text] ?? text) : text);
}

/** 替换模板文案中的 {name} 占位符（与诊断文案的 {detail} 约定一致，中文模板同样适用） */
export function applyParams(
  text: string,
  params: Record<string, string | number> | undefined,
): string {
  if (!params) return text;
  return Object.entries(params).reduce(
    (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
    text,
  );
}

/** 当前解析后的语言（供非字典的模板格式化使用，如预测文案） */
export function useLanguage(): Language {
  return useContext(LanguageContext);
}
