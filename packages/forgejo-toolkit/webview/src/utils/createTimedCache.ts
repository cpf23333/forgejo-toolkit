export interface TimedCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  /**
   * Drops every entry whose key satisfies `predicate`. Used to release exactly
   * one repository's slots: keys are namespaced by
   * `${instanceId}:${owner}/${repo}` (with a `:`/`#` separator before any
   * suffix), so a prefix alone would also match a longer repository name.
   */
  deleteWhere(predicate: (key: string) => boolean): void;
  clear(): void;
}

/**
 * Entry count at which a cache without an explicit `maxEntries` starts dropping
 * its oldest entries. Reading a key is what normally removes it once expired,
 * so keys that are never read again would otherwise hold their value (and, for
 * response caches, its memory) until the window reloads.
 */
const DEFAULT_MAX_ENTRIES = 64;

export function createTimedCache<T>(ttlMs: number, maxEntries?: number): TimedCache<T> {
  const cache = new Map<string, { value: T; timestamp: number }>();

  function isExpired(entry: { value: T; timestamp: number }): boolean {
    return Date.now() - entry.timestamp > ttlMs;
  }

  /**
   * Called before inserting a new key: expire stale entries first (a live entry
   * is more valuable than an already-dead one), then evict oldest-first down to
   * the bound. Map iteration order is insertion order.
   */
  function enforceBound(): void {
    const limit = maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (cache.size < limit) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.timestamp > ttlMs) {
        cache.delete(key);
      }
    }
    while (cache.size >= limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
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
      // Updates keep their slot and must not evict a live sibling.
      if (!cache.has(key)) {
        enforceBound();
      }
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
    deleteWhere(predicate) {
      for (const key of [...cache.keys()]) {
        if (predicate(key)) {
          cache.delete(key);
        }
      }
    },
    clear() {
      cache.clear();
    },
  };
}
