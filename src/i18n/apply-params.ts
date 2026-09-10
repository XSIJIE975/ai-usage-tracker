/** 替换模板文案中的 {name} 占位符（与诊断文案的 {detail} 约定一致，中文模板同样适用）。
 *  独立纯模块：i18n/index 会经 useAppStore 牵起整个 store 图，告警评估等非 React、
 *  且处于 store 导入链上的模块不能从那里取纯函数，否则循环导入（ADR-0021 修复）。 */
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
