/**
 * Minimal TTL cache for the extension host (the webview has its own
 * createTimedCache). Meant for coalescing bursts of identical loads, not for
 * long-lived storage.
 */
export interface TimedCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): boolean;
  clear(): void;
}

export function createTimedCache<T>(ttlMs: number): TimedCache<T> {
  const cache = new Map<string, { value: T; timestamp: number }>();
  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry) {
        return undefined;
      }
      if (Date.now() - entry.timestamp > ttlMs) {
        cache.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      cache.set(key, { value, timestamp: Date.now() });
    },
    delete(key) {
      return cache.delete(key);
    },
    clear() {
      cache.clear();
    },
  };
}
