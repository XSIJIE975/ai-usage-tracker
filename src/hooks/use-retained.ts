import { useRef } from "react";

/**
 * 留住最后一次非空载荷。
 *
 * 抽屉/弹窗的宿主常把 `open` 与载荷一起置空（`onOpenChange` 里 `setInstance(null)`），
 * 这会在同一次渲染里卸载整个 Radix Root，而 Root 的 Presence 是要等 `animationend`
 * 才允许卸载的——于是出场动画被直接吃掉，只剩「啪」地消失。这里让载荷停在最后一次
 * 非空的值，滑出过程中内容保持不变；Root 关闭后本就不渲染 DOM，留着引用不花钱。
 */
export function useRetained<T>(value: T | null): T | null {
  const retained = useRef<T | null>(value);
  if (value !== null) retained.current = value;
  return retained.current;
}
