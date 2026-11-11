import { useEffect, useState, type RefObject } from "react";

/** 滚动容器底缘的溢出提示：下方还有内容可滚时叠一层向上渐隐遮罩。
 * 面板全程隐藏滚动条（no-scrollbar），滚轮照常滚动，渐隐是唯一的「还有内容」提示；
 * 滚到底部即消失。遮罩颜色跟随画布底色 token，深浅色主题自动适配。 */
export function ScrollFadeHint({ viewportRef }: { viewportRef: RefObject<HTMLElement | null> }) {
  const overflowed = useBottomOverflow(viewportRef);
  if (!overflowed) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-canvas to-transparent"
    />
  );
}

/** 「下方还可滚」判定：scroll 与容器/内容尺寸变化时都重算——
 * 数据刷新让内容增高、窗口封顶变矮，两种翻转入溢出态的路径都覆盖 */
function useBottomOverflow(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowed, setOverflowed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setOverflowed(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref]);
  return overflowed;
}
