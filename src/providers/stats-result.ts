/**
 * 统计数据取数的统一结果形态。
 * 三种状态：成功、缺少凭据配置（引导用户去设置）、请求或解析失败。
 * message 为中文模板串（含 {placeholder}），params 提供占位符实参，渲染端翻译。
 */
export type StatsResult<T> =
  | { status: "ok"; data: T }
  | { status: "needs_config"; message: string; params?: Record<string, string | number> }
  | { status: "error"; message: string; params?: Record<string, string | number> };
