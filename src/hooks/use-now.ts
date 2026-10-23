import { useEffect, useState } from "react";

/**
 * 每 intervalMs 重新取一次当前时刻：重置倒计时、相对时间展示用。
 * 30 秒足够（文案按分钟级展示），不跟随系统时钟。
 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}
