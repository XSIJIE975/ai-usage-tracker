/**
 * 统计数据取数的统一结果形态。
 * 三种状态：成功、缺少凭据配置（引导用户去设置）、请求或解析失败。
 */
export type StatsResult<T> =
  | { status: "ok"; data: T }
  | { status: "needs_config"; message: string }
  | { status: "error"; message: string };
