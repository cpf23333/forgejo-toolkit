export interface TimedCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
}

export function createTimedCache<T>(ttlMs: number): TimedCache<T> {
  const cache = new Map<string, { value: T; timestamp: number }>();

  function isExpired(entry: { value: T; timestamp: number }): boolean {
    return Date.now() - entry.timestamp > ttlMs;
  }

  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry) {
        return undefined;
      }
      if (isExpired(entry)) {
        cache.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      cache.set(key, { value, timestamp: Date.now() });
    },
    has(key) {
      const entry = cache.get(key);
      if (!entry) {
        return false;
      }
      if (isExpired(entry)) {
        cache.delete(key);
        return false;
      }
      return true;
    },
    delete(key) {
      return cache.delete(key);
    },
    clear() {
      cache.clear();
    },
  };
}
