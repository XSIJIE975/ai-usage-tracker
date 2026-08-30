/** 全局快捷键的规范格式与展示格式转换。
 *  规范格式供 tauri-plugin-global-shortcut 解析（修饰键 + Code 名，如 "Alt+KeyU"）；展示格式面向用户（如 "Alt + U"）。 */

const MODIFIER_DISPLAY: Record<string, string> = {
  Control: "Ctrl",
  Super: "Win",
  Alt: "Alt",
  Shift: "Shift",
};

const KEY_DISPLAY: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Space: "Space",
  Period: ".",
  Comma: ",",
  Minus: "-",
  Equal: "=",
  Slash: "/",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
};

/** 修饰键 → 展示名；主键 Code → 展示名（KeyU→U、Digit3→3、F5→F5，其余回退原名） */
export function displayShortcut(canonical: string): string {
  if (!canonical) return "未设置";
  return canonical
    .split("+")
    .map((token) => {
      if (MODIFIER_DISPLAY[token]) return MODIFIER_DISPLAY[token];
      if (token.startsWith("Key")) return token.slice(3);
      if (token.startsWith("Digit")) return token.slice(5);
      return KEY_DISPLAY[token] ?? token;
    })
    .join(" + ");
}

/** KeyboardEvent 组合 → 规范格式；无修饰键或仅修饰键返回 null */
export function canonicalFromEvent(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  code: string;
}): string | null {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push("Super");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (["Control", "Meta", "Alt", "Shift", "AltGraph"].includes(event.key)) return null;
  if (modifiers.length === 0) return null;
  return [...modifiers, event.code].join("+");
}
