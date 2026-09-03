/** 供应商错误信息 → 卡片上的友好占位提示；完整原文在「详情」弹窗中查看 */
export type ErrorKind = "auth" | "network" | "generic";

/**
 * 按报错内容轻分类（只认高置信关键词，宁可用通用提示也不误判）：
 * - auth：HTTP 401/403、authentication、登录/挑战页、Cookie 过期、未开通套餐
 * - network：网络/连接/超时类措辞
 */
export function classifyError(message: string): ErrorKind {
  if (
    /40[13]\b|authentication|未开通|登录|重新复制|cookie|userToken|api\s*key.{0,24}invalid|invalid.{0,24}api\s*key/i.test(
      message,
    )
  ) {
    return "auth";
  }
  if (/network|connection|timed?\s?-?out|超时|网络|连接|fetch failed|dns/i.test(message)) {
    return "network";
  }
  return "generic";
}

const HINT_KEYS: Record<ErrorKind, string> = {
  auth: "凭据无效或已过期",
  network: "网络连接失败",
  generic: "获取用量失败",
};

/** 卡片占位提示的中文源文案（渲染端走 t()，en.ts 提供对照） */
export function errorHintTitle(message: string): string {
  return HINT_KEYS[classifyError(message)];
}
