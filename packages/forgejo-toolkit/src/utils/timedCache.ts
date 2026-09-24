/**
 * Minimal TTL cache for the extension host (the webview has its own
 * createTimedCache). Meant for coalescing bursts of identical loads, not for
 * long-lived storage.
 *
 * Values can be large — a parsed pull-request diff of a 10 MiB patch measures a
 * few MiB — and a TTL alone never releases an entry: only reading a key removes
 * it once expired, so keys that are never read again would hold their memory for
 * the life of the extension host. Every cache is therefore bounded by entry
 * count, and a cache whose values can be sized is bounded by total bytes too.
 */
export interface TimedCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): boolean;
  clear(): void;
  /** Live entry count. */
  readonly size: number;
  /** Sum of the estimated byte sizes of the live entries (0 without `sizeOf`). */
  byteSize(): number;
}

export interface TimedCacheOptions<T> {
  /** Entry count the cache evicts down to. Defaults to `DEFAULT_MAX_ENTRIES`. */
  maxEntries?: number;
  /**
   * Total estimated bytes the cache may hold. Needs `sizeOf` to have an effect;
   * without it only `maxEntries` bounds the cache.
   */
  maxBytes?: number;
  /**
   * Estimated in-memory size of a value in bytes, used for `maxBytes`. A value
   * larger than `maxBytes` on its own is not cached, so one entry can never
   * evict the whole cache.
   */
  sizeOf?: (value: T) => number;
}

/**
 * Entry count a cache without an explicit `maxEntries` evicts down to. Reading a
 * key is what normally removes an expired entry, so an unbounded map would keep
 * the value of every key that is never read again.
 */
export const DEFAULT_MAX_ENTRIES = 64;
/**
 * Default byte budget for caches that can estimate value sizes. Large enough to
 * hold many ordinary responses, small enough that a few oversized entries cannot
 * retain tens of MiB.
 */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Rough in-memory size of a JSON-shaped value, for `maxBytes`. Deliberately
 * approximate — it is an eviction heuristic, not an accounting figure. Map and
 * Set entries are walked so a parsed diff (a Map of Maps) is measured by its
 * content rather than as one object.
 */
export function estimateValueBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') {
    return value.length * 2;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return 8;
  }
  if (typeof value === 'boolean' || value === null || value === undefined) {
    return 8;
  }
  if (typeof value !== 'object') {
    return 0;
  }
  const object = value as object;
  if (seen.has(object)) {
    return 0;
  }
  seen.add(object);
  if (value instanceof Map) {
    let total = 0;
    for (const [key, item] of value) {
      total += estimateValueBytes(key, seen) + estimateValueBytes(item, seen);
    }
    return total;
  }
  if (value instanceof Set) {
    let total = 0;
    for (const item of value) {
      total += estimateValueBytes(item, seen);
    }
    return total;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + estimateValueBytes(item, seen), 0);
  }
  let total = 0;
  for (const [key, item] of Object.entries(value)) {
    total += key.length * 2 + estimateValueBytes(item, seen);
  }
  return total;
}

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  bytes: number;
}

export function createTimedCache<T>(ttlMs: number, options: TimedCacheOptions<T> = {}): TimedCache<T> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.sizeOf ? (options.maxBytes ?? DEFAULT_MAX_BYTES) : Number.POSITIVE_INFINITY;
  const sizeOf = options.sizeOf;
  // Insertion-ordered, and re-inserted on every read, so iteration order is
  // least-recently-used first.
  const cache = new Map<string, CacheEntry<T>>();
  let storedBytes = 0;

  function isExpired(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.timestamp > ttlMs;
  }

  function drop(key: string): void {
    const entry = cache.get(key);
    if (!entry) {
      return;
    }
    cache.delete(key);
    storedBytes -= entry.bytes;
  }

  /** Least-recently-used key, or undefined when the cache is empty. */
  function oldestKey(): string | undefined {
    return cache.keys().next().value;
  }

  /**
   * Expire stale entries first (a live entry is more valuable than an already
   * dead one), then evict least-recently-used ones down to both bounds.
   */
  function evict(): void {
    for (const [key, entry] of [...cache]) {
      if (isExpired(entry)) {
        drop(key);
      }
    }
    while (cache.size > maxEntries || storedBytes > maxBytes) {
      const key = oldestKey();
      if (key === undefined) {
        return;
      }
      drop(key);
    }
  }

  return {
    get size() {
      return cache.size;
    },
    byteSize() {
      return Math.max(0, storedBytes);
    },
    get(key) {
      const entry = cache.get(key);
      if (!entry) {
        return undefined;
      }
      if (isExpired(entry)) {
        drop(key);
        return undefined;
      }
      // Mark as most recently used.
      cache.delete(key);
      cache.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      // The replacement releases its own bytes, and an update keeps its slot
      // instead of evicting a live sibling.
      drop(key);
      const bytes = sizeOf ? sizeOf(value) : 0;
      if (bytes > maxBytes) {
        // A single value over the whole budget: caching it would immediately
        // evict every other entry and still violate the bound.
        return;
      }
      cache.set(key, { value, timestamp: Date.now(), bytes });
      storedBytes += bytes;
      evict();
    },
    delete(key) {
      if (!cache.has(key)) {
        return false;
      }
      drop(key);
      return true;
    },
    clear() {
      cache.clear();
      storedBytes = 0;
    },
  };
}
