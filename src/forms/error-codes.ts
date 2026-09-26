import { renderTemplate } from "../i18n/apply-params";

/**
 * 表单校验错误码 → 中文源文案（即 i18n 键）。
 *
 * schema 只产出**码**，不产出成品文案：RHF 的 resolver 会把 message 冻进 form state，
 * 切语言时已显示的错误不会重算。这里把「码 → 文案」的翻译推迟到渲染时过一次 t()，
 * 语言跟着界面走。校验层与界面层之间流动的永远是码。
 *
 * 需要实参的文案用 {name} 占位符，实参由渲染端从字段规格取（阈值的 min/max 本来就
 * 在规格里），不从 form state 穿参——resolver 的 FieldError 形状里没有 params 的位置。
 */
export const FORM_ERROR_TEXT = {
  required: "该项为必填",
  note_too_long: "备注不能超过 {max} 个字符",
  threshold_not_number: "阈值请填写数字",
  threshold_not_integer: "阈值请填写整数",
  threshold_out_of_range: "阈值需在 {min}–{max} 之间",
  qoder_cookie_value:
    "只粘贴 qoder_session_cookie 的值：不要带「Cookie:」前缀或键名，也不能包含分号、空格、换行或中文",
  workbuddy_cookie_value:
    "只粘贴该 Cookie 的值：不要带键名或「Cookie:」前缀，也不能包含分号、空格、换行或中文",
  workbuddy_ua_value:
    "只粘贴 User-Agent 的值：不要带「User-Agent:」前缀，也不能包含换行或中文",
} as const;

export type FormErrorCode = keyof typeof FORM_ERROR_TEXT;

/** 按当前界面语言渲染错误文案；未知码原样显示（单测保证 schema 只会产出已知码） */
export function renderFormError(
  code: string,
  params: Record<string, string | number> | undefined,
  t: (s: string) => string,
): string {
  return renderTemplate(FORM_ERROR_TEXT[code as FormErrorCode] ?? code, params, t);
}
