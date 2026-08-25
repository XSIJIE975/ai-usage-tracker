/**
 * 极简 Promise 记忆缓存：同 key 进行中的 Promise 直接复用（防抖并发）。
 * resolve 后保留成功值；reject 后清除失败值以便重试。不设 TTL。
 */
export interface UsageCache {
  load: <T>(key: string, loader: () => Promise<T>) => Promise<T>;
  invalidate: (key?: string) => void;
}

export const createUsageCache = (): UsageCache => {
  const entries = new Map<string, Promise<unknown>>();

  const load = <T>(key: string, loader: () => Promise<T>): Promise<T> => {
    const existing = entries.get(key);
    if (existing !== undefined) {
      return existing as Promise<T>;
    }
    const promise: Promise<T> = loader();
    void promise.catch(() => {
      // 失败值不缓存；仅在仍是当前条目时清除，避免误删 invalidate 之后的新条目
      if (entries.get(key) === promise) {
        entries.delete(key);
      }
    });
    entries.set(key, promise);
    return promise;
  };

  const invalidate = (key?: string): void => {
    if (key === undefined) {
      entries.clear();
      return;
    }
    entries.delete(key);
  };

  return { load, invalidate };
};
