/**
 * opencode.ai SolidStart server-function RPC 响应解析器。
 *
 * 响应体不是标准 JSON，而是构建产物中的 JS 对象字面量：
 *   ;0x0000115e;
 *   ((self.$R = self.$R || {})["server-fn:0"] = [],
 *   ($R => $R[0] = { ...目标值... })($R["server-fn:0"]))
 *
 * 目标值位于首个 `$R[0] =` 之后；内部散布的 `$R[<n>] = ` 内联赋值视为透明。
 * 语法支持：无引号键名、双引号字符串、!0/!1、null、数字（含科学计数法）、
 * 数组、嵌套对象、new Date("ISO")（还原为 ISO 字符串本身）。
 * 采用字符级递归下降扫描，不使用 eval/new Function，不做全文正则替换。
 */

import {
  describeChar,
  expectChar,
  fail,
  matchPattern,
  scanStringEnd,
  skipSpaces,
  skipSpacesAt,
  type ScanState,
} from "./opencode-rpc-scanner";

const TARGET_MARKER = "$R[0]";
const DATE_CALL_PREFIX = "new Date(";
const INLINE_REF_PREFIX = "$R[";

const IDENTIFIER_KEY_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const DIGITS_PATTERN = /\d+/y;
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

const parseString = (state: ScanState): string => {
  const end = scanStringEnd(state.text, state.pos);
  const literal = state.text.slice(state.pos, end);
  state.pos = end;
  try {
    return JSON.parse(literal) as string;
  } catch {
    return fail(state, "字符串包含无效的转义序列");
  }
};

const parseNumber = (state: ScanState): number => {
  const literal = matchPattern(NUMBER_PATTERN, state);
  if (literal === null) {
    return fail(state, `意外的内容 "${describeChar(state.text[state.pos])}"，应为数字`);
  }
  return Number(literal);
};

/** new Date("ISO") → ISO 字符串本身。 */
const parseDateCall = (state: ScanState): string => {
  state.pos += DATE_CALL_PREFIX.length;
  const iso = parseString(state);
  expectChar(state, ")");
  return iso;
};

/** `$R[<n>] = <value>` 内联赋值：跳过引用部分，返回右侧的值。 */
const parseInlineRef = (state: ScanState): unknown => {
  state.pos += INLINE_REF_PREFIX.length;
  const index = matchPattern(DIGITS_PATTERN, state);
  if (index === null) return fail(state, "$R 内联引用缺少数组下标");
  expectChar(state, "]");
  expectChar(state, "=");
  return parseValue(state);
};

const parseArray = (state: ScanState): unknown[] => {
  const items: unknown[] = [];
  state.pos += 1;
  skipSpaces(state);
  if (state.text[state.pos] === "]") {
    state.pos += 1;
    return items;
  }
  for (;;) {
    items.push(parseValue(state));
    skipSpaces(state);
    const ch = state.text[state.pos];
    if (ch === ",") {
      state.pos += 1;
      continue;
    }
    if (ch === "]") {
      state.pos += 1;
      return items;
    }
    fail(state, `数组中意外的内容 "${describeChar(ch)}"，应为 "," 或 "]"`);
  }
};

const parseKey = (state: ScanState): string => {
  skipSpaces(state);
  if (state.text[state.pos] === '"') return parseString(state);
  const key = matchPattern(IDENTIFIER_KEY_PATTERN, state);
  if (key === null) return fail(state, "对象键名缺失或格式非法");
  return key;
};

const parseObject = (state: ScanState): Record<string, unknown> => {
  const entries: Record<string, unknown> = {};
  state.pos += 1;
  skipSpaces(state);
  if (state.text[state.pos] === "}") {
    state.pos += 1;
    return entries;
  }
  for (;;) {
    const key = parseKey(state);
    expectChar(state, ":");
    entries[key] = parseValue(state);
    skipSpaces(state);
    const ch = state.text[state.pos];
    if (ch === ",") {
      state.pos += 1;
      continue;
    }
    if (ch === "}") {
      state.pos += 1;
      return entries;
    }
    fail(state, `对象中意外的内容 "${describeChar(ch)}"，应为 "," 或 "}"`);
  }
};

const parseValue = (state: ScanState): unknown => {
  skipSpaces(state);
  const text = state.text;
  const ch = text[state.pos];
  if (ch === "{") return parseObject(state);
  if (ch === "[") return parseArray(state);
  if (ch === '"') return parseString(state);
  if (text.startsWith(INLINE_REF_PREFIX, state.pos)) return parseInlineRef(state);
  if (text.startsWith(DATE_CALL_PREFIX, state.pos)) return parseDateCall(state);
  if (text.startsWith("!0", state.pos)) {
    state.pos += 2;
    return true;
  }
  if (text.startsWith("!1", state.pos)) {
    state.pos += 2;
    return false;
  }
  if (text.startsWith("null", state.pos)) {
    state.pos += 4;
    return null;
  }
  if (ch === undefined) return fail(state, "输入在值开始前意外结束");
  return parseNumber(state);
};

/** 跳过字符串字面量后定位 `$R[0] =` 的赋值位置，避免误命中字符串内的同形文本。 */
const locateTarget = (text: string): number => {
  let pos = 0;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '"') {
      pos = scanStringEnd(text, pos);
      continue;
    }
    if (text.startsWith(TARGET_MARKER, pos)) {
      const afterMarker = skipSpacesAt(text, pos + TARGET_MARKER.length);
      if (text[afterMarker] === "=" && text[afterMarker + 1] !== "=") return afterMarker + 1;
    }
    pos += 1;
  }
  throw new Error("opencode.ai 响应解析失败：响应体中未找到 $R[0] 目标值标记");
};

/**
 * 解析 server-function RPC 响应体为目标值；失败时抛出带位置信息的 Error。
 * 根值之后的尾随内容（如 `))($R["server-fn:N"]))`）与空白被容忍。
 */
export const parseRpcResponse = (bodyText: string): unknown => {
  const valueStart = locateTarget(bodyText);
  const state: ScanState = { text: bodyText, pos: valueStart };
  return parseValue(state);
};
