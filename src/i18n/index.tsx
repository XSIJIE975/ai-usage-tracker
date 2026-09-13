import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAppStore } from "../store/useAppStore";
import { resolveLanguage, translateText, type Language } from "./translate";

export type { Language, LanguageSetting } from "./translate";
export { resolveLanguage, translateText } from "./translate";

const LanguageContext = createContext<Language>("zh");

/** 语言上下文：由设置驱动，auto 时按系统语言检测（中文→zh，其余→en） */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const setting = useAppStore((state) => state.settings.interfaceLanguage);
  const language = useMemo(() => resolveLanguage(setting), [setting]);
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

/** 翻译函数：返回当前语言的文案；en 缺失键回退中文源文案（实现见 ./translate.ts） */
export function useT() {
  const language = useContext(LanguageContext);
  return (text: string): string => translateText(text, language);
}

/** 纯函数从 ./apply-params 转发：保持既有导入路径不变；
 *  处于 store 导入链上的非 React 模块请直接走纯模块，避免循环导入 */
export { applyParams, renderTemplate } from "./apply-params";

/** 当前解析后的语言（供非字典的模板格式化使用，如预测文案） */
export function useLanguage(): Language {
  return useContext(LanguageContext);
}
