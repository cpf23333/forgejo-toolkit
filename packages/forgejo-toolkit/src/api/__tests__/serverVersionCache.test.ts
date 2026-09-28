import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimSharedServerVersionProbe,
  clearSharedServerVersions,
  createMementoServerVersionCache,
  deleteSharedServerVersion,
  isPidAlive,
  readActiveServerVersionProbe,
  readSharedServerVersion,
  readSharedServerVersionNotice,
  readSharedServerVersions,
  recordSharedServerVersionNotice,
  releaseSharedServerVersionProbe,
  SERVER_VERSION_CACHE_TTL_MS,
  SERVER_VERSION_PROBE_MARKER_TTL_MS,
  SERVER_VERSION_PROBE_WAIT_TIMEOUT_MS,
  setServerVersionCacheStorage,
  versionCacheKey,
  withSharedServerVersion,
  writeSharedServerVersion,
  type ServerVersionCacheEntry,
} from '../serverVersionCache';
import { makeMemoryVersionCacheStore, type MemoryVersionCacheStore } from './serverVersionCacheTestHelpers';

/**
 * The shared, timestamped probe cache of §9 route 2 (§10.1.10), plus the two
 * decisions that follow from it: the single-flight marker that stops a second
 * window from probing while the first one is (and bounds how long it waits), and
 * the notice record that keeps the low-version warning with the window that
 * actually probed.
 *
 * The properties under test are the ones the decision names: the TTL turns an
 * expired entry into "unknown" rather than a value, the write merges by key so
 * one window cannot drop another window's entry, and a store that is missing,
 * unreadable or unwritable degrades to "no shared cache" instead of failing the
 * caller — the process-local map is the fallback, never a wrong gate.
 */

const NOW = 1_700_000_000_000;
const URL_A = 'https://forgejo.example.com';
const URL_B = 'https://codeberg.org';
/** A pid that is not this process; liveness is injected, so it need not exist. */
const OTHER_PID = 999_999;

function entry(version: string, writtenAt: number): ServerVersionCacheEntry {
  return { version, writtenAt };
}

describe('the shared server-version cache (§9 route 2)', () => {
  let store: MemoryVersionCacheStore;

  beforeEach(() => {
    store = makeMemoryVersionCacheStore();
    setServerVersionCacheStorage(store.storage);
  });

  afterEach(() => {
    setServerVersionCacheStorage(undefined);
  });

  it('keys entries by the normalised instance URL', () => {
    expect(versionCacheKey('https://forgejo.example.com/')).toBe('https://forgejo.example.com');
    expect(versionCacheKey('https://forgejo.example.com///')).toBe('https://forgejo.example.com');
    expect(versionCacheKey('https://forgejo.example.com')).toBe('https://forgejo.example.com');
  });

  it('reports a fresh entry with its write time and no staleness', () => {
    store.seed({ [URL_A]: entry('16.0.1', NOW) });

    expect(readSharedServerVersion(URL_A, NOW)).toEqual({ version: '16.0.1', writtenAt: NOW, stale: false });
    // The boundary belongs to the fresh side: an entry is stale only once it is
    // older than the TTL, so a reader at exactly `writtenAt + TTL` still uses it.
    expect(readSharedServerVersion(URL_A, NOW + SERVER_VERSION_CACHE_TTL_MS)?.stale).toBe(false);
    expect(readSharedServerVersion(URL_A, NOW + SERVER_VERSION_CACHE_TTL_MS + 1)?.stale).toBe(true);
  });

  it('reports an expired entry as stale instead of hiding or ignoring it', () => {
    // The value travels with `stale: true` so the diagnostics payload can show
    // what the store holds; it is the *callers* that must treat it as unknown.
    store.seed({ [URL_A]: entry('16.0.1', NOW) });

    expect(readSharedServerVersion(URL_A, NOW + SERVER_VERSION_CACHE_TTL_MS + 1)).toEqual({
      version: '16.0.1',
      writtenAt: NOW,
      stale: true,
    });
  });

  it('reports nothing for a missing entry, a detached store or an unreadable one', () => {
    expect(readSharedServerVersion(URL_A, NOW)).toBeUndefined();

    store.seed({ [URL_B]: entry('17.0.0', NOW) });
    expect(readSharedServerVersion(URL_A, NOW)).toBeUndefined();

    store.failReads();
    expect(readSharedServerVersion(URL_B, NOW)).toBeUndefined();

    setServerVersionCacheStorage(undefined);
    expect(readSharedServerVersion(URL_B, NOW)).toBeUndefined();
  });

  it('treats a hand-edited or corrupt slot as no entry rather than a value', () => {
    store.seed({
      [URL_A]: entry('16.0.1', NOW),
      bare: '16.0.1',
      wrongTypes: { version: 16, writtenAt: NOW },
      noVersion: { writtenAt: NOW },
      futureish: { version: '17.0.0', writtenAt: Number.NaN },
      emptyVersion: { version: '', writtenAt: NOW },
      nullish: null,
    });

    expect(readSharedServerVersion(URL_A, NOW)?.version).toBe('16.0.1');
    for (const key of ['bare', 'wrongTypes', 'noVersion', 'futureish', 'emptyVersion', 'nullish']) {
      expect(readSharedServerVersion(key, NOW)).toBeUndefined();
    }
    store.seed(['not', 'a', 'snapshot']);
    expect(readSharedServerVersion(URL_A, NOW)).toBeUndefined();
  });

  it('merge-writes only the key it is responsible for, keeping the other window’s entry', async () => {
    store.seed({ [URL_A]: entry('16.0.0', NOW - 1_000), [URL_B]: entry('17.0.0', NOW - 2_000) });

    await writeSharedServerVersion(URL_A, '16.0.1', NOW);

    expect(readSharedServerVersions()).toEqual({
      [URL_A]: entry('16.0.1', NOW),
      [URL_B]: { version: '17.0.0', writtenAt: NOW - 2_000 },
    });
    expect(store.writes()).toBe(1);
  });

  it('re-reads the slot immediately before writing, so a concurrent entry survives', async () => {
    // This window read the cache earlier and knows about A only; another window
    // then recorded B. The write must not resurrect this window's stale view.
    store.seed({ [URL_A]: entry('16.0.0', NOW - 1_000) });
    expect(readSharedServerVersion(URL_A, NOW)?.version).toBe('16.0.0');
    store.seed({ [URL_A]: entry('16.0.0', NOW - 1_000), [URL_B]: entry('17.0.0', NOW - 100) });

    await writeSharedServerVersion(URL_A, '16.0.1', NOW);

    expect(readSharedServerVersions()).toEqual({
      [URL_A]: entry('16.0.1', NOW),
      [URL_B]: { version: '17.0.0', writtenAt: NOW - 100 },
    });
  });

  it('deletes one entry without touching the others, and clears the whole slot on request', async () => {
    store.seed({ [URL_A]: entry('16.0.1', NOW), [URL_B]: entry('17.0.0', NOW) });

    await deleteSharedServerVersion(URL_A);
    expect(readSharedServerVersions()).toEqual({ [URL_B]: { version: '17.0.0', writtenAt: NOW } });

    await clearSharedServerVersions();
    expect(store.raw()).toEqual({});
  });

  it('turns a failing or unreadable store into a no-op, never an error', async () => {
    store.seed({ [URL_A]: entry('16.0.1', NOW) });
    store.failWrites();

    await expect(writeSharedServerVersion(URL_B, '17.0.0', NOW)).resolves.toBeUndefined();
    await expect(deleteSharedServerVersion(URL_A)).resolves.toBeUndefined();
    // The failed writes left the slot as it was, which is the cache's problem,
    // not the caller's.
    expect(readSharedServerVersions()).toEqual({ [URL_A]: { version: '16.0.1', writtenAt: NOW } });

    store.failReads();
    // A merge write cannot read the slot; an empty snapshot is the safest merge
    // base, and the write itself still has to be attempted.
    await expect(writeSharedServerVersion(URL_B, '17.0.0', NOW)).resolves.toBeUndefined();

    setServerVersionCacheStorage(undefined);
    await expect(writeSharedServerVersion(URL_B, '17.0.0', NOW)).resolves.toBeUndefined();
    await expect(deleteSharedServerVersion(URL_B)).resolves.toBeUndefined();
    await expect(clearSharedServerVersions()).resolves.toBeUndefined();
  });
});

describe('the memento-backed store', () => {
  it('reads and writes one whole-value slot', async () => {
    const slots = new Map<string, unknown>();
    const memento = {
      get: <T>(key: string, fallback: T): T => (slots.has(key) ? (slots.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        slots.set(key, value);
      },
    };
    const storage = createMementoServerVersionCache(memento, 'forgejoToolkit.serverVersions');

    expect(storage.read()).toBeUndefined();
    await storage.write({ [URL_A]: entry('16.0.1', NOW) });
    expect(storage.read()).toEqual({ [URL_A]: entry('16.0.1', NOW) });
    expect(slots.has('forgejoToolkit.serverVersions')).toBe(true);
  });

  it('reports a store failure through the hook and keeps its promise resolved', async () => {
    const onError = vi.fn();
    const memento = {
      get<T>(_key: string, _fallback: T): T {
        throw new Error('state store unavailable');
      },
      update: async (): Promise<void> => {
        throw new Error('read-only profile');
      },
    };
    const storage = createMementoServerVersionCache(memento, 'forgejoToolkit.serverVersions', onError);

    expect(storage.read()).toBeUndefined();
    await expect(storage.write({})).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toContain('read');
    expect(onError.mock.calls[0]?.[0]).toContain('state store unavailable');
    expect(onError.mock.calls[1]?.[0]).toContain('write');
    expect(onError.mock.calls[1]?.[0]).toContain('read-only profile');
  });
});

/**
 * The single-flight marker (decision A). What is under test is the *policy*: a
 * live marker makes a second window wait and adopt instead of probing, a dead or
 * expired marker does not, and the wait is always bounded and always fails open.
 * Whether `process.kill(pid, 0)` identifies a live pid is `isPidAlive`'s own
 * contract (and `leaseStore.test.ts` pins it), so liveness is injected here.
 */
describe('the single-flight probe marker', () => {
  let store: MemoryVersionCacheStore;

  beforeEach(() => {
    store = makeMemoryVersionCacheStore();
    setServerVersionCacheStorage(store.storage);
  });

  afterEach(() => {
    setServerVersionCacheStorage(undefined);
  });

  it('pins the marker TTL above the probe’s own request timeout', () => {
    // `API_REQUEST_TIMEOUT_MS` is 30 s and is declared in `client.ts`, which
    // this module must not import; the number is repeated here on purpose, so
    // that raising it without revisiting the marker TTL fails a test instead of
    // silently letting a slow-but-alive prober be declared dead.
    expect(SERVER_VERSION_PROBE_MARKER_TTL_MS).toBeGreaterThan(30_000);
    expect(SERVER_VERSION_PROBE_WAIT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(SERVER_VERSION_PROBE_WAIT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(SERVER_VERSION_PROBE_WAIT_TIMEOUT_MS).toBeLessThan(SERVER_VERSION_PROBE_MARKER_TTL_MS);
  });

  it('reads a live marker as active and a dead or expired one as absent', () => {
    const alive = () => true;
    store.seed({ '#inflight': { [URL_A]: { pid: OTHER_PID, at: NOW } } });
    expect(readActiveServerVersionProbe(URL_A, NOW, alive)).toEqual({ pid: OTHER_PID, at: NOW });

    // A marker nobody believes any more, because its writer is gone …
    expect(readActiveServerVersionProbe(URL_A, NOW, () => false)).toBeUndefined();
    // … or because it is past its TTL, whatever the pid says.
    const expiredAt = NOW + SERVER_VERSION_PROBE_MARKER_TTL_MS + 1;
    expect(readActiveServerVersionProbe(URL_A, expiredAt, alive)).toBeUndefined();
  });

  it('refuses the claim while another window’s marker is live', async () => {
    store.seed({ '#inflight': { [URL_A]: { pid: OTHER_PID, at: NOW } } });

    await expect(claimSharedServerVersionProbe(URL_A, 42, NOW, () => true)).resolves.toBe(false);
    // The other window's marker is untouched.
    expect(readActiveServerVersionProbe(URL_A, NOW, () => true)?.pid).toBe(OTHER_PID);
  });

  it('takes a dead window’s marker over immediately', async () => {
    store.seed({ '#inflight': { [URL_A]: { pid: OTHER_PID, at: NOW } } });

    await expect(claimSharedServerVersionProbe(URL_A, 42, NOW, () => false)).resolves.toBe(true);
    expect(readActiveServerVersionProbe(URL_A, NOW, () => true)?.pid).toBe(42);
  });

  it('releases only its own marker', async () => {
    store.seed({ '#inflight': { [URL_A]: { pid: OTHER_PID, at: NOW } } });

    await releaseSharedServerVersionProbe(URL_A, 42);
    expect(readActiveServerVersionProbe(URL_A, NOW, () => true)?.pid).toBe(OTHER_PID);

    await releaseSharedServerVersionProbe(URL_A, OTHER_PID);
    expect(readActiveServerVersionProbe(URL_A, NOW, () => true)).toBeUndefined();
  });

  it('waits for a live marker’s entry and adopts it without fetching', async () => {
    const now = Date.now();
    store.seed({ '#inflight': { [URL_A]: { pid: OTHER_PID, at: now } } });
    const fetched = vi.fn(async () => '17.0.0');
    // The other window's merged write lands while this window is waiting.
    const timer = setTimeout(() => {
      store.seed({
        '#inflight': { [URL_A]: { pid: OTHER_PID, at: now } },
        '#instances': { [URL_A]: entry('16.0.1', Date.now()) },
      });
    }, 20);

    try {
      await expect(
        withSharedServerVersion(URL_A, fetched, { pidAlive: () => true, timeoutMs: 2_000, pollIntervalMs: 10 }),
      ).resolves.toEqual({ version: '16.0.1', probed: false });
    } finally {
      clearTimeout(timer);
    }
    expect(fetched).not.toHaveBeenCalled();
  });

  it('probes itself when the marker’s owner is dead', async () => {
    store.seed({
      '#inflight': { [URL_A]: { pid: OTHER_PID, at: NOW } },
      '#instances': { [URL_A]: entry('16.0.1', NOW - SERVER_VERSION_CACHE_TTL_MS - 1) },
    });
    const fetched = vi.fn(async () => '17.0.0');
    const pidAlive = vi.fn(() => false);

    await expect(
      withSharedServerVersion(URL_A, fetched, { pidAlive, timeoutMs: 2_000, pollIntervalMs: 10 }),
    ).resolves.toEqual({ version: '17.0.0', probed: true });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('probes itself when the marker has expired', async () => {
    store.seed({
      '#inflight': { [URL_A]: { pid: OTHER_PID, at: NOW - SERVER_VERSION_PROBE_MARKER_TTL_MS - 1 } },
    });
    const fetched = vi.fn(async () => '17.0.0');

    await expect(
      withSharedServerVersion(URL_A, fetched, { pidAlive: () => true, timeoutMs: 2_000, pollIntervalMs: 10 }),
    ).resolves.toEqual({ version: '17.0.0', probed: true });
    expect(fetched).toHaveBeenCalledTimes(1);
    // The stale marker was replaced by this window's own, and released again.
    expect(readActiveServerVersionProbe(URL_A)).toBeUndefined();
  });

  it('gives up after the bounded wait and probes itself', async () => {
    // A live prober that never publishes anything: exactly the case the bound
    // exists for. The waiter must not sit there for the whole marker TTL.
    store.seed({ '#inflight': { [URL_A]: { pid: OTHER_PID, at: NOW } } });
    const fetched = vi.fn(async () => '17.0.0');

    await expect(
      withSharedServerVersion(URL_A, fetched, { pidAlive: () => true, timeoutMs: 40, pollIntervalMs: 10 }),
    ).resolves.toEqual({ version: '17.0.0', probed: true });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('adopts the entry a second read finds already there, without fetching', async () => {
    store.seed({ '#instances': { [URL_A]: entry('16.0.1', Date.now() - 1) } });
    const fetched = vi.fn(async () => '17.0.0');

    await expect(withSharedServerVersion(URL_A, fetched, { pidAlive: () => true })).resolves.toEqual({
      version: '16.0.1',
      probed: false,
    });
    expect(fetched).not.toHaveBeenCalled();
    // An entry this window may not use is not adopted either.
    const skipped = vi.fn(async () => '17.0.0');
    await expect(withSharedServerVersion(URL_A, skipped, { pidAlive: () => true, skip: () => true })).resolves.toEqual({
      version: '17.0.0',
      probed: true,
    });
    expect(skipped).toHaveBeenCalledTimes(1);
  });

  it('probes when there is no store at all and reports the probed version', async () => {
    // The MCP server process: no shared slot, but the caller still needs the
    // answer for its own process-local record.
    setServerVersionCacheStorage(undefined);
    const fetched = vi.fn(async () => '16.0.1');

    await expect(withSharedServerVersion(URL_A, fetched)).resolves.toEqual({ version: '16.0.1', probed: true });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('ignores a corrupt marker rather than waiting on it', () => {
    store.seed({
      '#inflight': {
        [URL_A]: { pid: 'not-a-number', at: NOW },
        badTime: { pid: OTHER_PID, at: Number.NaN },
        zero: { pid: 0, at: NOW },
      },
    });

    for (const key of [URL_A, 'badTime', 'zero']) {
      expect(readActiveServerVersionProbe(key, NOW, () => true)).toBeUndefined();
    }
  });

  it('reads a slot written by the previous build as entries-only', () => {
    // The shape before this feature: a bare map, no metadata sections.
    const bare = { [URL_A]: entry('16.0.1', NOW), [URL_B]: entry('17.0.0', NOW) };
    store.seed(bare);

    expect(readSharedServerVersions()).toEqual(bare);
    expect(readActiveServerVersionProbe(URL_A, NOW)).toBeUndefined();
    expect(readSharedServerVersionNotice(URL_A, '16.0.1')).toBeUndefined();
  });

  it('drops a corrupt entry while keeping the readable ones', () => {
    store.seed({
      '#instances': {
        [URL_A]: entry('16.0.1', NOW),
        broken: { version: 16, writtenAt: NOW },
        noTime: { version: '16.0.1' },
      },
    });

    expect(readSharedServerVersions()).toEqual({ [URL_A]: entry('16.0.1', NOW) });
  });
});

/** The notice record (decision B): whoever probed warns, and only once. */
describe('the low-version notice record', () => {
  let store: MemoryVersionCacheStore;

  beforeEach(() => {
    store = makeMemoryVersionCacheStore();
    setServerVersionCacheStorage(store.storage);
  });

  afterEach(() => {
    setServerVersionCacheStorage(undefined);
  });

  it('lets exactly one window record the notice for a version', async () => {
    await expect(recordSharedServerVersionNotice(URL_A, '7.0.0', NOW)).resolves.toBe(true);
    await expect(recordSharedServerVersionNotice(URL_A, '7.0.0', NOW + 5)).resolves.toBe(false);

    expect(readSharedServerVersionNotice(URL_A, '7.0.0')).toEqual({ version: '7.0.0', notifiedAt: NOW });
  });

  it('does not let one version’s notice cover another', async () => {
    await recordSharedServerVersionNotice(URL_A, '7.0.0', NOW);

    expect(readSharedServerVersionNotice(URL_A, '15.0.0')).toBeUndefined();
    await expect(recordSharedServerVersionNotice(URL_A, '15.0.0', NOW + 1)).resolves.toBe(true);
  });

  it('clears the notice when a new version is recorded, so a moved server warns again', async () => {
    store.seed({
      '#instances': { [URL_A]: { version: '7.0.0', writtenAt: NOW, notifiedAt: NOW } },
      '#notices': { [URL_A]: { version: '7.0.0', notifiedAt: NOW } },
    });

    await writeSharedServerVersion(URL_A, '16.0.1', NOW + 1);

    expect(readSharedServerVersionNotice(URL_A, '7.0.0')).toBeUndefined();
    await expect(recordSharedServerVersionNotice(URL_A, '16.0.1', NOW + 2)).resolves.toBe(true);
  });

  it('drops the notice with the instance', async () => {
    await recordSharedServerVersionNotice(URL_A, '7.0.0', NOW);
    await deleteSharedServerVersion(URL_A);

    expect(readSharedServerVersionNotice(URL_A, '7.0.0')).toBeUndefined();
  });

  it('reports first-ness from an unusable store instead of suppressing the notice', async () => {
    // A store that cannot be read cannot prove another window warned, and
    // repeating a notice is far better than dropping one.
    store.failReads();
    await expect(recordSharedServerVersionNotice(URL_A, '7.0.0', NOW)).resolves.toBe(true);

    setServerVersionCacheStorage(undefined);
    await expect(recordSharedServerVersionNotice(URL_A, '7.0.0', NOW)).resolves.toBe(true);
  });
});

describe('isPidAlive', () => {
  it('accepts this process and rejects invalid or absent pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it('counts EPERM as alive, exactly as the lease store does', () => {
    // Windows returns EPERM for a live pid this user may not signal; treating it
    // as dead would take over a healthy window's probe.
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
    });
    try {
      expect(isPidAlive(4242)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
