import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertActionsSupported,
  assertActionsSupportedAfterProbe,
  clearServerVersion,
  clearServerVersions,
  getServerVersion,
  isVersionAtLeast,
  isVersionSupported,
  MIN_ACTIONS_VERSION,
  MIN_SUPPORTED_VERSION,
  MIN_SUPPORTED_VERSION_TEXT,
  parseDeclaredServerVersion,
  parseServerVersion,
  resolveServerVersion,
  reusableSharedServerVersion,
  setDeclaredServerVersionResolver,
  setServerVersion,
} from '../serverVersion';
import {
  readSharedServerVersion,
  SERVER_VERSION_CACHE_TTL_MS,
  setServerVersionCacheStorage,
} from '../serverVersionCache';
import { makeMemoryVersionCacheStore, type MemoryVersionCacheStore } from './serverVersionCacheTestHelpers';

afterEach(() => {
  clearServerVersions();
});

describe('parseServerVersion', () => {
  it('parses plain semver strings', () => {
    expect(parseServerVersion('1.21.5')).toEqual({ major: 1, minor: 21, patch: 5 });
    expect(parseServerVersion('7.0.1')).toEqual({ major: 7, minor: 0, patch: 1 });
  });

  it('tolerates a leading v and suffixes', () => {
    expect(parseServerVersion('v1.19.2')).toEqual({ major: 1, minor: 19, patch: 2 });
    expect(parseServerVersion('1.21.5+gitea-1.21')).toEqual({ major: 1, minor: 21, patch: 5 });
  });

  it('defaults a missing patch component to 0', () => {
    expect(parseServerVersion('1.19')).toEqual({ major: 1, minor: 19, patch: 0 });
  });

  it('returns undefined for unparseable input', () => {
    expect(parseServerVersion('')).toBeUndefined();
    expect(parseServerVersion('devel')).toBeUndefined();
    expect(parseServerVersion('1')).toBeUndefined();
  });
});

describe('isVersionAtLeast', () => {
  const min = { major: 1, minor: 19, patch: 0 };

  it('accepts equal and newer versions', () => {
    expect(isVersionAtLeast({ major: 1, minor: 19, patch: 0 }, min)).toBe(true);
    expect(isVersionAtLeast({ major: 1, minor: 21, patch: 5 }, min)).toBe(true);
    expect(isVersionAtLeast({ major: 7, minor: 0, patch: 0 }, min)).toBe(true);
  });

  it('rejects older versions', () => {
    expect(isVersionAtLeast({ major: 1, minor: 18, patch: 9 }, min)).toBe(false);
    expect(isVersionAtLeast({ major: 0, minor: 99, patch: 0 }, min)).toBe(false);
  });
});

describe('server version registry', () => {
  it('keys versions by normalized URL', () => {
    setServerVersion('https://forgejo.example.com/', '1.21.0');
    expect(getServerVersion('https://forgejo.example.com')).toBe('1.21.0');
    expect(getServerVersion('https://forgejo.example.com/')).toBe('1.21.0');
  });

  it('returns undefined for unknown instances', () => {
    expect(getServerVersion('https://unknown.example.com')).toBeUndefined();
  });

  it('clearServerVersion drops only the entry for the given URL', () => {
    setServerVersion('https://forgejo.example.com', '1.18.0');
    setServerVersion('https://other.example.com', '1.21.0');

    clearServerVersion('https://forgejo.example.com/');

    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
    expect(getServerVersion('https://other.example.com')).toBe('1.21.0');
  });

  it('clearServerVersion re-enables the Actions gate after a server upgrade', () => {
    setServerVersion('https://old.example.com', '1.18.3');
    expect(() => assertActionsSupported('https://old.example.com')).toThrow(/requires Forgejo .* or newer/);

    clearServerVersion('https://old.example.com');
    // Unknown versions fail open again until the next probe records one.
    expect(() => assertActionsSupported('https://old.example.com')).not.toThrow();
  });
});

describe('assertActionsSupported', () => {
  it('throws a localized error for servers older than the Actions API', () => {
    setServerVersion('https://old.example.com', '1.18.3');
    expect(() => assertActionsSupported('https://old.example.com')).toThrow(/requires Forgejo .* or newer/);
  });

  it('passes for servers new enough', () => {
    setServerVersion('https://new.example.com', '1.21.0');
    expect(() => assertActionsSupported('https://new.example.com')).not.toThrow();
    setServerVersion('https://newer.example.com', '7.0.1');
    expect(() => assertActionsSupported('https://newer.example.com')).not.toThrow();
  });

  it('fails open for unknown or unparseable versions', () => {
    expect(() => assertActionsSupported('https://unprobed.example.com')).not.toThrow();
    setServerVersion('https://weird.example.com', 'custom-build');
    expect(() => assertActionsSupported('https://weird.example.com')).not.toThrow();
  });

  it('uses 1.19.0 as the Actions threshold', () => {
    expect(MIN_ACTIONS_VERSION).toEqual({ major: 1, minor: 19, patch: 0 });
  });
});

/**
 * Decision C: the gate is renewed at the point of use. With no periodic probe,
 * an expired record means "unknown → allow" for the rest of a long session, so
 * the gated call site is what asks for a fresh version — before it evaluates.
 */
describe('assertActionsSupportedAfterProbe', () => {
  it('probes once for an unknown version, then evaluates the gate', async () => {
    const probe = vi.fn(async () => {
      setServerVersion('https://gated.example.com', '1.18.0');
      return '1.18.0';
    });

    await expect(assertActionsSupportedAfterProbe('https://gated.example.com', probe)).rejects.toThrow(
      /requires Forgejo .* or newer/,
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not probe while a fresh version is known', async () => {
    setServerVersion('https://fresh.example.com', '17.0.0');
    const probe = vi.fn(async () => '17.0.0');

    await expect(assertActionsSupportedAfterProbe('https://fresh.example.com', probe)).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails open when the probe throws or returns nothing', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(assertActionsSupportedAfterProbe('https://broken.example.com', throwing)).resolves.toBeUndefined();

    const empty = vi.fn(async () => undefined);
    await expect(assertActionsSupportedAfterProbe('https://empty.example.com', empty)).resolves.toBeUndefined();
  });
});

describe('isVersionSupported', () => {
  it('pins the supported floor to 16.0.0', () => {
    expect(MIN_SUPPORTED_VERSION).toEqual({ major: 16, minor: 0, patch: 0 });
    expect(MIN_SUPPORTED_VERSION_TEXT).toBe('16.0.0');
  });

  it('accepts the floor itself and newer versions', () => {
    expect(isVersionSupported('16.0.0')).toBe(true);
    expect(isVersionSupported('16.0.1')).toBe(true);
    expect(isVersionSupported('16.2.0')).toBe(true);
    expect(isVersionSupported('17.0.0')).toBe(true);
  });

  it('rejects older versions, including the v15, legacy 1.x and v7 lines', () => {
    expect(isVersionSupported('15.0.0')).toBe(false);
    expect(isVersionSupported('15.9.9')).toBe(false);
    expect(isVersionSupported('14.9.9')).toBe(false);
    expect(isVersionSupported('7.0.0')).toBe(false);
    expect(isVersionSupported('1.21.0')).toBe(false);
  });

  it('fails open for unknown or unparseable versions', () => {
    expect(isVersionSupported(undefined)).toBe(true);
    expect(isVersionSupported('devel')).toBe(true);
  });
});

/**
 * The registry above is the process-local half of §9 route 2. These tests are
 * the shared half: a value another window wrote must be readable here (that is
 * the whole point for a follower's gate), an expired value must never gate, and
 * a store that is missing or broken must leave the process-local behaviour
 * exactly as it was.
 */
describe('the shared probe cache of §9 route 2', () => {
  let store: MemoryVersionCacheStore;

  beforeEach(() => {
    store = makeMemoryVersionCacheStore();
    setServerVersionCacheStorage(store.storage);
  });

  afterEach(() => {
    clearServerVersions();
    setServerVersionCacheStorage(undefined);
  });

  it('gates on a fresh entry another window wrote, which is what a follower reads', () => {
    // 1.18.3 is below both floors, so both gates can be observed firing.
    store.seed({ 'https://forgejo.example.com': { version: '1.18.3', writtenAt: Date.now() } });

    // No probe happened in this window at all: the shared record is the only
    // reason the low-version gate can fire here instead of failing open.
    expect(getServerVersion('https://forgejo.example.com')).toBe('1.18.3');
    expect(isVersionSupported(getServerVersion('https://forgejo.example.com'))).toBe(false);
    expect(() => assertActionsSupported('https://forgejo.example.com')).toThrow(/requires Forgejo .* or newer/);
  });

  it('treats an expired entry as unknown and fails open, whatever the stored value says', () => {
    store.seed({
      'https://forgejo.example.com': { version: '1.18.3', writtenAt: Date.now() - SERVER_VERSION_CACHE_TTL_MS - 1 },
    });

    // The same value gated one assertion ago when it was fresh; expired, it is
    // unknown, and unknown fails open (§9 route 2: the cache is a gate, so an
    // expired value must never gate).
    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
    expect(isVersionSupported(getServerVersion('https://forgejo.example.com'))).toBe(true);
    expect(() => assertActionsSupported('https://forgejo.example.com')).not.toThrow();
    // The value itself is still visible to a reader that asks the cache
    // directly (the diagnostics payload does), marked as unusable.
    expect(readSharedServerVersion('https://forgejo.example.com')?.stale).toBe(true);
  });

  it('keeps gating with a probe this window made after the shared entry expired', () => {
    // The common shape of the race: this window probed, the merged write has not
    // landed yet (or failed), and the entry it would have replaced is expired.
    // Its own, newer result is what must gate — never the expired one.
    store.seed({
      'https://forgejo.example.com': { version: '16.0.1', writtenAt: Date.now() - SERVER_VERSION_CACHE_TTL_MS - 1 },
    });
    store.failWrites();

    setServerVersion('https://forgejo.example.com', '1.18.3');

    expect(getServerVersion('https://forgejo.example.com')).toBe('1.18.3');
    expect(() => assertActionsSupported('https://forgejo.example.com')).toThrow(/requires Forgejo .* or newer/);
  });

  it('records the probe beside the instance configuration, merge-written', () => {
    store.seed({ 'https://codeberg.org': { version: '17.0.0', writtenAt: Date.now() - 5_000 } });

    setServerVersion('https://forgejo.example.com', '16.0.1');

    const written = store.raw() as Record<string, { version: string; writtenAt: number }>;
    expect(Object.keys(written).sort()).toEqual(['https://codeberg.org', 'https://forgejo.example.com']);
    expect(written['https://codeberg.org']?.version).toBe('17.0.0');
    expect(written['https://forgejo.example.com']?.version).toBe('16.0.1');
    expect(readSharedServerVersion('https://forgejo.example.com')).toEqual({
      version: '16.0.1',
      writtenAt: expect.any(Number),
      stale: false,
    });
  });

  it('drops the shared copy too when a saved instance invalidates its version', () => {
    setServerVersion('https://forgejo.example.com', '1.18.3');
    expect(readSharedServerVersion('https://forgejo.example.com')).toBeDefined();

    clearServerVersion('https://forgejo.example.com');

    // Both layers are gone, so the next probe cannot be skipped in favour of a
    // value recorded before the user edited the instance.
    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
    expect(readSharedServerVersion('https://forgejo.example.com')).toBeUndefined();
    expect(store.raw()).toEqual({});
  });

  it('never uses an invalidated entry, and accepts a record written after the invalidation', () => {
    store.seed({ 'https://forgejo.example.com': { version: '1.18.3', writtenAt: Date.now() } });
    expect(reusableSharedServerVersion('https://forgejo.example.com')).toBeDefined();

    // The shared delete is an asynchronous write, so it may not have landed
    // when the probe that follows a save reads the cache. The entry is still
    // there and still looks fresh — and must not be used.
    store.failWrites();
    clearServerVersion('https://forgejo.example.com');

    expect(readSharedServerVersion('https://forgejo.example.com')).toBeDefined();
    expect(reusableSharedServerVersion('https://forgejo.example.com')).toBeUndefined();
    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
    expect(() => assertActionsSupported('https://forgejo.example.com')).not.toThrow();

    // A record written after the invalidation — this window's refresh, or
    // another window's probe — is usable again: the invalidation does not pin
    // the URL to "unknown".
    store.seed({ 'https://forgejo.example.com': { version: '17.0.0', writtenAt: Date.now() + 1 } });
    expect(reusableSharedServerVersion('https://forgejo.example.com')?.version).toBe('17.0.0');
    expect(getServerVersion('https://forgejo.example.com')).toBe('17.0.0');
  });

  it('clears the shared slot as well on the test reset', () => {
    setServerVersion('https://forgejo.example.com', '16.0.1');

    clearServerVersions();

    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
    expect(store.raw()).toEqual({});
  });

  it('degrades to the process-local registry when the store is absent or unreadable', () => {
    setServerVersionCacheStorage(undefined);
    setServerVersion('https://local.example.com', '16.0.1');
    expect(getServerVersion('https://local.example.com')).toBe('16.0.1');

    // A store whose reads throw is "no shared cache" as far as a reader is
    // concerned: the value this window probed itself keeps gating.
    store.failReads();
    setServerVersionCacheStorage(store.storage);
    expect(getServerVersion('https://local.example.com')).toBe('16.0.1');
    expect(getServerVersion('https://never-probed.example.com')).toBeUndefined();
    expect(isVersionSupported(getServerVersion('https://never-probed.example.com'))).toBe(true);
  });
});

/**
 * The declared server version: what the user states for an instance, stored on
 * the instance record (read here through the registered resolver, which is the
 * only thing `ConfigManager` supplies). The resolution order is
 * **declared → probed → unknown**, and a declaration has to survive everything
 * that touches the probe cache — the probe itself, the TTL and the cross-window
 * merge write.
 */
describe('a declared server version', () => {
  const declaredUrl = 'https://declared.example.com';

  /** Registers a record reader that declares exactly one URL's version. */
  function declare(version: string, url: string = declaredUrl): void {
    setDeclaredServerVersionResolver((requested) => (requested === url ? version : undefined));
  }

  it('wins over this window’s own probe result', () => {
    declare('16.0.2');
    // The probe answered something else entirely (the wrong answer the escape
    // hatch exists for).
    setServerVersion(declaredUrl, '1.18.0');

    expect(getServerVersion(declaredUrl)).toBe('16.0.2');
    expect(resolveServerVersion(declaredUrl)).toEqual({
      version: '16.0.2',
      source: 'declared',
      cached: undefined,
    });
    // The gate follows the declaration, not the probe.
    expect(() => assertActionsSupported(declaredUrl)).not.toThrow();
  });

  it('wins over a cached probe and is unaffected by the cache TTL', () => {
    const store = makeMemoryVersionCacheStore({
      [declaredUrl]: { version: '1.18.0', writtenAt: Date.now() },
    });
    setServerVersionCacheStorage(store.storage);
    try {
      declare('17.0.0');
      expect(getServerVersion(declaredUrl)).toBe('17.0.0');
      expect(resolveServerVersion(declaredUrl).source).toBe('declared');

      // Age the entry past the TTL: the cached value becomes unusable, and the
      // declaration is still the answer (it has no TTL of its own).
      store.seed({ [declaredUrl]: { version: '1.18.0', writtenAt: Date.now() - SERVER_VERSION_CACHE_TTL_MS - 1 } });
      expect(getServerVersion(declaredUrl)).toBe('17.0.0');
      expect(resolveServerVersion(declaredUrl)).toEqual({
        version: '17.0.0',
        source: 'declared',
        cached: undefined,
      });
    } finally {
      setServerVersionCacheStorage(undefined);
    }
  });

  it('still declares after a probe wrote the shared cache, and the record is not touched', () => {
    // The merge write of §9 route 2 rewrites the cache slot beside the instance
    // list. A declaration lives on the instance record, so the two cannot
    // collide — and this is the assertion that keeps it that way.
    const store = makeMemoryVersionCacheStore();
    setServerVersionCacheStorage(store.storage);
    try {
      declare('16.0.2');

      setServerVersion(declaredUrl, '17.0.0');

      expect(store.raw()).toEqual({ [declaredUrl]: { version: '17.0.0', writtenAt: expect.any(Number) } });
      expect(getServerVersion(declaredUrl)).toBe('16.0.2');
    } finally {
      setServerVersionCacheStorage(undefined);
    }
  });

  it('falls back to the probe when the instance declares nothing', () => {
    setDeclaredServerVersionResolver(() => undefined);
    setServerVersion(declaredUrl, '16.0.1');

    expect(resolveServerVersion(declaredUrl)).toMatchObject({ version: '16.0.1', source: 'probed' });
    expect(getServerVersion(declaredUrl)).toBe('16.0.1');
  });

  it('never uses a declaration the parser rejects', () => {
    // A hand-edited record (or one written by a build that did not validate) is
    // not a version, so it must not be used as one — the probe still answers.
    declare('devel');
    setServerVersion(declaredUrl, '16.0.1');

    expect(resolveServerVersion(declaredUrl)).toMatchObject({ version: '16.0.1', source: 'probed' });
  });

  it('charges an Actions refusal to the declaration when it is below the floor', () => {
    declare('1.18.0');

    expect(() => assertActionsSupported(declaredUrl)).toThrow(/you declared version 1\.18\.0/);
    // The declaration is what makes it refuse, so the message must not claim the
    // server reported that version.
    expect(() => assertActionsSupported(declaredUrl)).not.toThrow(/this server reports/);
    expect(isVersionSupported(getServerVersion(declaredUrl))).toBe(false);
    // A declared version that clears both floors opens the gate again.
    declare('17.0.0');
    expect(() => assertActionsSupported(declaredUrl)).not.toThrow();
  });

  it('skips the on-demand probe entirely for a declared instance', async () => {
    declare('17.0.0');
    const probe = vi.fn(async () => '1.18.0');

    await expect(assertActionsSupportedAfterProbe(declaredUrl, probe)).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('clears the registration on the test reset, so a later test starts undeclared', () => {
    declare('16.0.2');
    clearServerVersions();

    expect(getServerVersion(declaredUrl)).toBeUndefined();
  });
});

/**
 * The one validation rule every host-side writer applies: the Settings handlers
 * before they save, and `ConfigManager` at the storage boundary. A value the
 * form rejects must never be stored and silently ignored.
 */
describe('parseDeclaredServerVersion', () => {
  it('accepts what /api/v1/version can return', () => {
    expect(parseDeclaredServerVersion('16.0.2')).toEqual({ kind: 'declared', version: '16.0.2' });
    expect(parseDeclaredServerVersion('16.0.2+gitea-1.22.0')).toEqual({
      kind: 'declared',
      version: '16.0.2+gitea-1.22.0',
    });
    expect(parseDeclaredServerVersion('  v1.21.5  ')).toEqual({ kind: 'declared', version: 'v1.21.5' });
    expect(parseDeclaredServerVersion('1.19')).toEqual({ kind: 'declared', version: '1.19' });
  });

  it('reads a missing or empty value as no declaration', () => {
    expect(parseDeclaredServerVersion(undefined)).toEqual({ kind: 'none' });
    expect(parseDeclaredServerVersion(null)).toEqual({ kind: 'none' });
    expect(parseDeclaredServerVersion('')).toEqual({ kind: 'none' });
    expect(parseDeclaredServerVersion('   ')).toEqual({ kind: 'none' });
  });

  it('rejects anything that is not a version', () => {
    expect(parseDeclaredServerVersion('devel')).toEqual({ kind: 'invalid' });
    expect(parseDeclaredServerVersion('latest')).toEqual({ kind: 'invalid' });
    expect(parseDeclaredServerVersion('1')).toEqual({ kind: 'invalid' });
    expect(parseDeclaredServerVersion(16.2)).toEqual({ kind: 'invalid' });
    expect(parseDeclaredServerVersion({ version: '16.0.2' })).toEqual({ kind: 'invalid' });
  });
});
