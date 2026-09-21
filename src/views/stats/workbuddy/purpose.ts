/** agentPurpose → 可读名（i18n）；已知枚举之外的用途（官方扩充时）原样展示 */
export const purposeLabel = (purpose: string, t: (text: string) => string): string => {
  if (purpose === "conversation") return t("对话");
  if (purpose === "enhance-prompt") return t("提示词增强");
  if (purpose === "conversation_topic") return t("会话摘要");
  if (purpose === "webfetch") return t("网页阅读");
  if (purpose.startsWith("subagent:")) return t("子代理");
  return purpose || t("未知用途");
};
