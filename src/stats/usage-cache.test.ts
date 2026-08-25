import { describe, expect, it, vi } from "vitest";
import { createUsageCache } from "./usage-cache";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("createUsageCache", () => {
  it("reuses the in-flight loader for concurrent loads of the same key", async () => {
    const cache = createUsageCache();
    const deferred = createDeferred<string>();
    const loader = vi.fn(() => deferred.promise);

    const first = cache.load("k", loader);
    const second = cache.load("k", loader);
    deferred.resolve("value");

    await expect(first).resolves.toBe("value");
    await expect(second).resolves.toBe("value");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keeps the resolved value so later loads skip the loader", async () => {
    const cache = createUsageCache();
    const loader = vi.fn(async () => 42);

    await expect(cache.load("hit", loader)).resolves.toBe(42);
    await expect(cache.load("hit", loader)).resolves.toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("clears a failed load so the next load retries", async () => {
    const cache = createUsageCache();
    let attempts = 0;
    const loader = vi.fn(async (): Promise<number> => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return attempts;
    });

    await expect(cache.load("flaky", loader)).rejects.toThrow("boom");
    await expect(cache.load("flaky", loader)).resolves.toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not share entries between different keys", async () => {
    const cache = createUsageCache();
    const loaderA = vi.fn(async () => "a");
    const loaderB = vi.fn(async () => "b");

    await expect(cache.load("a", loaderA)).resolves.toBe("a");
    await expect(cache.load("b", loaderB)).resolves.toBe("b");
    expect(loaderA).toHaveBeenCalledTimes(1);
    expect(loaderB).toHaveBeenCalledTimes(1);
  });

  it("invalidate(key) drops only the given key", async () => {
    const cache = createUsageCache();
    const loaderKept = vi.fn(async () => "kept");
    const loaderDropped = vi.fn(async () => "dropped");

    await cache.load("kept", loaderKept);
    await cache.load("dropped", loaderDropped);
    cache.invalidate("dropped");

    await cache.load("kept", loaderKept);
    await expect(cache.load("dropped", loaderDropped)).resolves.toBe("dropped");
    expect(loaderKept).toHaveBeenCalledTimes(1);
    expect(loaderDropped).toHaveBeenCalledTimes(2);
  });

  it("invalidate() clears every key", async () => {
    const cache = createUsageCache();
    const loaderA = vi.fn(async () => 1);
    const loaderB = vi.fn(async () => 2);

    await cache.load("a", loaderA);
    await cache.load("b", loaderB);
    cache.invalidate();

    await cache.load("a", loaderA);
    await cache.load("b", loaderB);
    expect(loaderA).toHaveBeenCalledTimes(2);
    expect(loaderB).toHaveBeenCalledTimes(2);
  });
});
