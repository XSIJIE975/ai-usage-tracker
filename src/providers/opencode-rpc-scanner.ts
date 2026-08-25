/**
 * opencode.ai RPC 响应解析的字符级扫描原语。
 * 只提供位置状态推进与字面量边界定位，不含语法规则（见 opencode-rpc-parser.ts）。
 */

export interface ScanState {
  readonly text: string;
  pos: number;
}

export const isSpace = (ch: string | undefined): boolean =>
  ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

export const describeChar = (ch: string | undefined): string => ch ?? "输入结束";

/** 抛出带位置信息的解析错误；返回类型 never 便于在表达式位置直接调用。 */
export const fail = (state: ScanState, reason: string): never => {
  throw new Error(`opencode.ai 响应解析失败（位置 ${state.pos}）：${reason}`);
};

export const skipSpacesAt = (text: string, from: number): number => {
  let pos = from;
  while (pos < text.length && isSpace(text[pos])) pos += 1;
  return pos;
};

export const skipSpaces = (state: ScanState): void => {
  state.pos = skipSpacesAt(state.text, state.pos);
};

export const expectChar = (state: ScanState, expected: string): void => {
  skipSpaces(state);
  if (state.text[state.pos] !== expected) {
    fail(state, `期望 "${expected}"，实际为 "${describeChar(state.text[state.pos])}"`);
  }
  state.pos += 1;
};

/** 在当前位置执行粘性正则匹配，命中则推进位置并返回字面量。 */
export const matchPattern = (pattern: RegExp, state: ScanState): string | null => {
  pattern.lastIndex = state.pos;
  const match = pattern.exec(state.text);
  if (!match) return null;
  state.pos = pattern.lastIndex;
  return match[0];
};

/** 返回闭引号之后的位置；未闭合时抛错。 */
export const scanStringEnd = (text: string, start: number): number => {
  let pos = start + 1;
  let escaped = false;
  while (pos < text.length) {
    const ch = text[pos];
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') return pos + 1;
    pos += 1;
  }
  throw new Error(`opencode.ai 响应解析失败（位置 ${start}）：字符串未闭合`);
};
