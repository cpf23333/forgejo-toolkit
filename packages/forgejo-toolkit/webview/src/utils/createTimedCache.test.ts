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
