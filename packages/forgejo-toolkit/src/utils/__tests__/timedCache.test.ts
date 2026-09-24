import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  createTimedCache,
  estimateValueBytes,
  type TimedCacheOptions,
} from '../timedCache';

afterEach(() => {
  vi.useRealTimers();
});

describe('createTimedCache bounds', () => {
  it('evicts the least recently used entry when the count cap is reached', () => {
    const cache = createTimedCache<string>(60_000, { maxEntries: 3 });
    cache.set('a', 'v-a');
    cache.set('b', 'v-b');
    cache.set('c', 'v-c');
    // Reading 'a' makes 'b' the least recently used.
    expect(cache.get('a')).toBe('v-a');

    cache.set('d', 'v-d');

    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('v-a');
    expect(cache.get('d')).toBe('v-d');
  });

  it('evicts by total bytes so a large diff cannot be retained indefinitely', () => {
    // Entries are counted for real; each "value" is a string whose length stands
    // in for its size, as the parsed-diff memo does.
    const cache = createTimedCache<string>(60_000, {
      sizeOf: (value) => value.length,
      maxBytes: 10,
    });
    cache.set('one', 'aa');
    cache.set('two', 'bb');
    cache.set('three', 'cc');
    expect(cache.byteSize()).toBe(6);

    cache.set('four', 'dddddddd');

    // 6 + 8 exceeds the 10-byte budget, so the oldest entries go.
    expect(cache.byteSize()).toBeLessThanOrEqual(10);
    expect(cache.get('one')).toBeUndefined();
    expect(cache.get('two')).toBeUndefined();
    expect(cache.get('four')).toBe('dddddddd');
  });

  it('releases the replaced size when a key is overwritten', () => {
    const cache = createTimedCache<string>(60_000, { sizeOf: (value) => value.length, maxBytes: 100 });
    cache.set('key', 'aaaaaaaaaa');
    expect(cache.byteSize()).toBe(10);

    cache.set('key', 'bb');

    expect(cache.size).toBe(1);
    expect(cache.byteSize()).toBe(2);
  });

  it('does not cache a single value larger than the whole byte budget', () => {
    const cache = createTimedCache<string>(60_000, { sizeOf: (value) => value.length, maxBytes: 8 });
    cache.set('small', 'aaaa');
    cache.set('huge', 'x'.repeat(64));

    // Caching it would evict every sibling and still break the bound.
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('small')).toBe('aaaa');
    expect(cache.byteSize()).toBe(4);
  });

  it('does not count bytes when no size function is given', () => {
    const cache = createTimedCache<string>(60_000);
    cache.set('key', 'value');
    expect(cache.byteSize()).toBe(0);
    expect(cache.get('key')).toBe('value');
  });

  it('still expires entries after the TTL', () => {
    vi.useFakeTimers();
    const cache = createTimedCache<string>(1_000);
    cache.set('key', 'value');

    vi.setSystemTime(Date.now() + 2_000);

    expect(cache.get('key')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('drops expired entries before evicting live ones', () => {
    vi.useFakeTimers();
    const cache = createTimedCache<string>(1_000, { maxEntries: 2 });
    cache.set('dead', 'value');
    vi.setSystemTime(Date.now() + 5_000);
    cache.set('live-a', 'a');
    cache.set('live-b', 'b');

    cache.set('live-c', 'c');

    expect(cache.get('dead')).toBeUndefined();
    expect(cache.get('live-b')).toBe('b');
    expect(cache.get('live-c')).toBe('c');
  });

  it('clears every entry and the byte count', () => {
    const cache = createTimedCache<string>(60_000, { sizeOf: (value) => value.length });
    cache.set('a', 'aaaa');
    cache.set('b', 'bb');

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.byteSize()).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('reports delete() only for a key that was present', () => {
    const cache = createTimedCache<string>(60_000, { sizeOf: (value) => value.length });
    cache.set('a', 'aaaa');

    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.byteSize()).toBe(0);
  });

  it('uses the documented defaults when no options are given', () => {
    // With defaults, an entry that fits the byte budget and the count cap stays.
    const options: TimedCacheOptions<string> = {};
    const cache = createTimedCache<string>(60_000, options);
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');
    expect(cache.size).toBe(1);
    // The default budgets themselves are exported so callers do not have to
    // repeat the numbers.
    expect(DEFAULT_MAX_ENTRIES).toBe(64);
    expect(DEFAULT_MAX_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe('estimateValueBytes', () => {
  it('counts strings, arrays and nested objects', () => {
    expect(estimateValueBytes('abcd')).toBe(8);
    expect(estimateValueBytes(['ab', 'cd'])).toBe(8);
    expect(estimateValueBytes({ key: 'ab' })).toBe(6 + 4);
  });

  it('walks Map and Set contents, as the parsed diff is a Map of Maps', () => {
    const diff = new Map([['src/index.ts', new Map([[1, 'added']])]]);
    const estimate = estimateValueBytes(diff);
    expect(estimate).toBeGreaterThan('added'.length * 2);
  });

  it('does not loop forever on a self-referencing value', () => {
    const value: Record<string, unknown> = { name: 'x' };
    value.self = value;
    expect(estimateValueBytes(value)).toBeGreaterThan(0);
  });
});
