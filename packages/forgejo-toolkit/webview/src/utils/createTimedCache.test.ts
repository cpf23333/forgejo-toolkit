import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTimedCache } from './createTimedCache';

describe('createTimedCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('stores and retrieves a value', () => {
    const cache = createTimedCache<string>(1000);
    cache.set('a', 'hello');
    expect(cache.get('a')).toBe('hello');
    expect(cache.has('a')).toBe(true);
  });

  it('returns undefined for missing keys', () => {
    const cache = createTimedCache<string>(1000);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.has('missing')).toBe(false);
  });

  it('expires entries after the configured ttl', () => {
    const cache = createTimedCache<string>(1000);
    cache.set('a', 'hello');
    vi.advanceTimersByTime(999);
    expect(cache.has('a')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
  });

  it('deletes a specific entry', () => {
    const cache = createTimedCache<string>(1000);
    cache.set('a', 'hello');
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(cache.delete('a')).toBe(false);
  });

  it('clears all entries', () => {
    const cache = createTimedCache<string>(1000);
    cache.set('a', 'hello');
    cache.set('b', 'world');
    cache.clear();
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(false);
  });

  it('allows different ttl values per cache instance', () => {
    const shortCache = createTimedCache<string>(100);
    const longCache = createTimedCache<string>(10_000);
    shortCache.set('a', 'short');
    longCache.set('b', 'long');
    vi.advanceTimersByTime(101);
    expect(shortCache.has('a')).toBe(false);
    expect(longCache.has('b')).toBe(true);
  });
});

describe('maxEntries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  it('evicts the oldest entry once the cap is reached', () => {
    const cache = createTimedCache<string>(60_000, 2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  it('updating an existing key does not evict', () => {
    const cache = createTimedCache<string>(60_000, 2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', 'updated');
    expect(cache.get('a')).toBe('updated');
    expect(cache.has('b')).toBe(true);
  });

  it('prefers expiring stale entries over evicting live ones at the cap', () => {
    const cache = createTimedCache<string>(1000, 2);
    cache.set('stale', '1');
    vi.advanceTimersByTime(1001);
    cache.set('live', '2');
    cache.set('new', '3');

    // 'stale' was already dead, so the live sibling survives.
    expect(cache.has('live')).toBe(true);
    expect(cache.get('new')).toBe('3');
  });

  it('bounds a cache without an explicit cap instead of growing for the session', () => {
    const cache = createTimedCache<string>(60_000);
    for (let index = 0; index < 200; index += 1) {
      cache.set(`key-${index}`, `value-${index}`);
    }
    // Keys that are never read again (the ones that used to accumulate) are
    // evicted oldest-first once the default bound is reached.
    expect(cache.has('key-0')).toBe(false);
    expect(cache.has('key-199')).toBe(true);
  });

  it('sweeps a whole batch of expired entries when the bound is reached', () => {
    const cache = createTimedCache<string>(1000);
    for (let index = 0; index < 64; index += 1) {
      cache.set(`old-${index}`, `value-${index}`);
    }
    vi.advanceTimersByTime(1001);
    cache.set('fresh', 'value');

    expect(cache.get('fresh')).toBe('value');
    // The expired batch is gone, so the fresh entry is not the only survivor of
    // an eviction that dropped live entries.
    expect(cache.has('old-0')).toBe(false);
  });
});
