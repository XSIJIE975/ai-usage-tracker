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

export function resolveLanguage(setting: LanguageSetting): Language {
  if (setting === "zh" || setting === "en") return setting;
  return detectLanguage();
}

/** 纯函数翻译：不依赖 React 上下文。告警 fire 时刻渲染（useAlertStore）等非组件
 *  调用方直接用本模块；React 组件经 useT() 取等价闭包（i18n/index.tsx）。
 *  开发实例的应用名统一在此追加 (dev) 后缀（ADR-0018）：所有 t("AI 用量助手") 出口
 *  （主窗口标题栏、速览/快速面板头部、关于页、托盘预览）一处加缀全局生效，
 *  与 Rust 侧 app_title/tray_tooltip 的后缀约定保持一致。 */
export function translateText(text: string, language: Language): string {
  const dict = dictionaries[language];
  const translated = dict ? (dict[text] ?? text) : text;
  if (import.meta.env.DEV && text === "AI 用量助手") return `${translated} (dev)`;
  return translated;
}
