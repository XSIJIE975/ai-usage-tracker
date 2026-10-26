/**
 * 三段数字版本号比较（"0.14.0" 式）。大于返回正数、相等 0、小于负数。
 * 前缀 v 忽略；缺段与非数字段按 0 处理（"0.14" 与 "0.14.0" 相等）。
 * 项目版本号一直是纯三段，预发布后缀等形态不在此处理范围内。
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const parsedLeft = parse(left);
  const parsedRight = parse(right);
  const length = Math.max(parsedLeft.length, parsedRight.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (parsedLeft[index] ?? 0) - (parsedRight[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
