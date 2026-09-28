import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as vscode from 'vscode';
import { clearUnsupportedVersionWarnings, probeServerVersion } from '../versionProbe';
import { clearServerVersion, clearServerVersions, getServerVersion } from '../serverVersion';
import {
  readSharedServerVersion,
  readSharedServerVersionNotice,
  SERVER_VERSION_CACHE_TTL_MS,
  SERVER_VERSION_PROBE_MARKER_TTL_MS,
  setServerVersionCacheStorage,
} from '../serverVersionCache';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../test/mocks/server';
import { MOCK_SERVER_VERSION } from '../../test/mocks/handlers';
import { makeMemoryVersionCacheStore, type MemoryVersionCacheStore } from './serverVersionCacheTestHelpers';

const showWarningMessage = vi.mocked(vscode.window.showWarningMessage);

/**
 * A pid that is not running. `leaseStore.test.ts` uses the same value for the
 * same purpose: it is inside the valid range and no process on a real machine
 * has it.
 */
const DEAD_PID = 0x7fff_fffe;

function mockVersion(version: string): void {
  mockServer.use(http.get('https://*/api/v1/version', () => HttpResponse.json({ version })));
}

/**
 * The marker section of the slot, as stored: `readActiveServerVersionProbe`
 * applies liveness and the TTL, so a test that wants to assert "this window
 * released its claim" has to look at the section itself.
 */
function storedMarkers(store: MemoryVersionCacheStore): Record<string, unknown> {
  const raw = store.raw() as Record<string, unknown> | undefined;
  return (raw?.['#inflight'] as Record<string, unknown> | undefined) ?? {};
}

/**
 * Counts the notices raised for one probed version. The rendered message names
 * the version and the supported floor, never the instance URL, so the version is
 * the only per-instance signal a call carries.
 */
function warningsForVersion(version: string): number {
  return showWarningMessage.mock.calls.filter((call) => String(call[0]).includes(version)).length;
}

describe('probeServerVersion', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
    clearServerVersions();
    // The per-window notice dedupe is module state; clear it so a later test's
    // expectation is about the shared record and not about an earlier test.
    clearUnsupportedVersionWarnings();
    showWarningMessage.mockClear();
  });

  it('caches the probed version in the registry', async () => {
    await probeServerVersion('https://forgejo.example.com', 'mock-token');
    expect(getServerVersion('https://forgejo.example.com')).toBe(MOCK_SERVER_VERSION);
  });

  it('swallows probe failures and leaves the registry empty', async () => {
    mockServer.use(http.get('https://*/api/v1/version', () => new HttpResponse(null, { status: 500 })));
    await expect(probeServerVersion('https://forgejo.example.com', 'mock-token')).resolves.toBeUndefined();
    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
  });

  it.each(['16.0.0', '16.0.5', '17.0.0'])('does not warn for supported version %s', async (version) => {
    mockVersion(version);
    await probeServerVersion(`https://supported-${version}.example.com`, 'mock-token');
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it.each(['1.21.0', '7.0.0', '14.9.9', '15.0.0', '15.0.1'])(
    'warns once for unsupported version %s',
    async (version) => {
      mockVersion(version);
      await probeServerVersion(`https://unsupported-${version}.example.com`, 'mock-token');
      expect(warningsForVersion(version)).toBe(1);
      const message = showWarningMessage.mock.calls[0][0] as string;
      expect(message).toContain(version);
      expect(message).toContain('16.0.0');
    },
  );

  it('does not warn when the probe fails and the version stays unknown', async () => {
    mockServer.use(http.get('https://*/api/v1/version', () => new HttpResponse(null, { status: 500 })));
    await probeServerVersion('https://unprobed.example.com', 'mock-token');
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('dedupes the warning per instance URL for the session', async () => {
    mockVersion('7.0.0');
    await probeServerVersion('https://dup.example.com', 'mock-token');
    await probeServerVersion('https://dup.example.com', 'mock-token');
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('warns again when the same instance reports a different unsupported version', async () => {
    // The in-process guard and the shared record are both keyed by the version,
    // not by the URL alone: a server that moves to a different (still
    // unsupported) version is a new fact and must be reportable.
    mockVersion('15.0.0');
    await probeServerVersion('https://moved.example.com', 'mock-token');
    mockVersion('14.0.0');
    await probeServerVersion('https://moved.example.com', 'mock-token');

    expect(warningsForVersion('15.0.0')).toBe(1);
    expect(warningsForVersion('14.0.0')).toBe(1);
  });

  /**
   * §9 route 2: the second (and third, …) window of a profile finds the first
   * window's result beside the instance list and does not probe at all. The
   * storage is registered only inside this suite so the tests above keep
   * exercising the process-local path they were written for.
   */
  describe('with a shared probe cache', () => {
    let store: MemoryVersionCacheStore;

    beforeEach(() => {
      store = makeMemoryVersionCacheStore();
      setServerVersionCacheStorage(store.storage);
    });

    // The store is deliberately left attached for the outer `afterEach`, which
    // resets the slot through it; the next `beforeEach` replaces it anyway.

    /** Counts the probes that actually reach the server. */
    function countProbes(version: string): () => number {
      let probes = 0;
      mockServer.use(
        http.get('https://*/api/v1/version', () => {
          probes += 1;
          return HttpResponse.json({ version });
        }),
      );
      return () => probes;
    }

    it('reuses a fresh entry from another window instead of probing', async () => {
      store.seed({ 'https://shared.example.com': { version: '16.0.1', writtenAt: Date.now() } });
      const probes = countProbes('17.0.0');

      await probeServerVersion('https://shared.example.com', 'mock-token');

      expect(probes()).toBe(0);
      // The reused value is what this window's gates read, which is the point:
      // a follower is no longer stuck on "unknown".
      expect(getServerVersion('https://shared.example.com')).toBe('16.0.1');
    });

    it('does not re-raise the low-version notice for a value it adopted from the cache', async () => {
      // The window that probed reported it then (§9 route 1 owns the dedupe);
      // raising it again here is exactly the repetition the cache removes.
      store.seed({ 'https://shared-low.example.com': { version: '7.0.0', writtenAt: Date.now() } });
      const probes = countProbes('7.0.0');

      await probeServerVersion('https://shared-low.example.com', 'mock-token');

      expect(probes()).toBe(0);
      expect(showWarningMessage).not.toHaveBeenCalled();
    });

    it('probes an entry past its TTL and merges the fresh result back', async () => {
      store.seed({
        'https://stale.example.com': {
          version: '16.0.1',
          writtenAt: Date.now() - SERVER_VERSION_CACHE_TTL_MS - 1,
        },
      });
      const probes = countProbes('17.0.0');

      await probeServerVersion('https://stale.example.com', 'mock-token');

      expect(probes()).toBe(1);
      expect(getServerVersion('https://stale.example.com')).toBe('17.0.0');
      expect(readSharedServerVersion('https://stale.example.com')).toMatchObject({
        version: '17.0.0',
        stale: false,
      });
    });

    it('probes a missing entry and records it for the other windows', async () => {
      const probes = countProbes('16.0.1');

      await probeServerVersion('https://missing.example.com', 'mock-token');

      expect(probes()).toBe(1);
      expect(readSharedServerVersion('https://missing.example.com')).toMatchObject({
        version: '16.0.1',
        stale: false,
      });
    });

    it('probes after an instance save, even while the invalidated entry is still readable', async () => {
      // The save path is `clearServerVersion(url)` followed immediately by a
      // probe, and the shared deletion is asynchronous. Until it lands the old
      // entry is still readable *and* still fresh, so a probe that trusted the
      // cache would skip exactly the refresh the save asked for.
      store.seed({ 'https://saved.example.com': { version: '16.0.1', writtenAt: Date.now() } });
      store.failWrites();
      clearServerVersion('https://saved.example.com');
      const probes = countProbes('17.0.0');

      await probeServerVersion('https://saved.example.com', 'mock-token');

      expect(probes()).toBe(1);
      // The old entry is unusable here, so the freshly probed value (kept in
      // this process, since the shared write is the one that failed) is what
      // gates.
      expect(getServerVersion('https://saved.example.com')).toBe('17.0.0');
    });

    /**
     * Decision A: the single-flight marker. A window that finds another live
     * window already probing waits for that window's entry instead of issuing
     * its own request — and, because it adopted rather than probed, raises no
     * notice of its own (decision B).
     */
    describe('while another window is probing', () => {
      /**
       * A live marker for `url`, as another window would have written it. It is
       * merged into the slot rather than reseeded, so a test can seed the stale
       * entry and the marker together — `seed` replaces the whole slot.
       */
      function withLiveMarker(url: string, at: number = Date.now()): void {
        const raw = (store.raw() ?? {}) as Record<string, unknown>;
        store.seed({ ...raw, '#inflight': { [url.replace(/\/+$/, '')]: { pid: process.pid + 1, at } } });
      }

      it('waits, issues no request, adopts the entry and stays quiet', async () => {
        const url = 'https://waiter.example.com';
        const entryAt = Date.now();
        // Stale, so the probe path has to go through the coordination rather
        // than returning early on the fresh-entry shortcut.
        store.seed({
          '#instances': { [url]: { version: '7.0.0', writtenAt: entryAt - SERVER_VERSION_CACHE_TTL_MS - 1 } },
        });
        withLiveMarker(url, entryAt);
        const probes = countProbes('7.0.0');
        // The probing window publishes while this one waits. The handler is
        // appended *after* the one above, so a probe that escaped the wait would
        // be counted rather than silently served.
        const timer = setTimeout(() => {
          const raw = (store.raw() ?? {}) as Record<string, unknown>;
          store.seed({
            ...raw,
            '#instances': { [url]: { version: '7.0.0', writtenAt: Date.now() } },
          });
        }, 20);

        try {
          await probeServerVersion(url, 'mock-token');
        } finally {
          clearTimeout(timer);
        }

        expect(probes()).toBe(0);
        expect(getServerVersion(url)).toBe('7.0.0');
        expect(showWarningMessage).not.toHaveBeenCalled();
      });

      it('takes over a dead window’s marker at once and probes', async () => {
        const url = 'https://dead-prober.example.com';
        // An entry older than the TTL, so the probe is genuinely needed, and a
        // marker whose writer is gone: waiting on it can only waste the bound.
        store.seed({
          '#instances': { [url]: { version: '16.0.1', writtenAt: Date.now() - SERVER_VERSION_CACHE_TTL_MS - 1 } },
          '#inflight': { [url]: { pid: DEAD_PID, at: Date.now() } },
        });
        const probes = countProbes('17.0.0');

        await probeServerVersion(url, 'mock-token');

        expect(probes()).toBe(1);
        expect(getServerVersion(url)).toBe('17.0.0');
      });

      it('takes over an expired marker at once and probes', async () => {
        const url = 'https://stale-marker.example.com';
        store.seed({
          '#instances': { [url]: { version: '16.0.1', writtenAt: Date.now() - SERVER_VERSION_CACHE_TTL_MS - 1 } },
          '#inflight': { [url]: { pid: process.pid + 1, at: Date.now() - SERVER_VERSION_PROBE_MARKER_TTL_MS - 1 } },
        });
        const probes = countProbes('17.0.0');

        await probeServerVersion(url, 'mock-token');

        expect(probes()).toBe(1);
        expect(getServerVersion(url)).toBe('17.0.0');
      });

      it('leaves no marker behind after its own probe', async () => {
        const probes = countProbes('16.0.1');

        await probeServerVersion('https://released.example.com', 'mock-token');

        expect(probes()).toBe(1);
        // The whole point of releasing: the next window must not wait on this
        // one after it is done.
        expect(storedMarkers(store)).toEqual({});
      });
    });

    /**
     * Decision B: the notice belongs to whoever probed, and the shared record
     * is the cross-window half of the dedupe. Two windows can still probe at
     * once (they claimed the marker in the same instant), so the second one has
     * to check the record before it warns.
     */
    describe('sharing the low-version notice', () => {
      it('stays quiet when a notice for the same version is already recorded', async () => {
        const url = 'https://already-noticed.example.com';
        const noticedAt = Date.now();
        store.seed({
          '#instances': { [url]: { version: '16.0.1', writtenAt: noticedAt - SERVER_VERSION_CACHE_TTL_MS - 1 } },
          '#notices': { [url]: { version: '7.0.0', notifiedAt: noticedAt } },
        });
        const probes = countProbes('7.0.0');

        await probeServerVersion(url, 'mock-token');

        // It did probe — this is the window that lost the marker race — but the
        // notice was already covered by the window that won it.
        expect(probes()).toBe(1);
        expect(showWarningMessage).not.toHaveBeenCalled();
        // And the existing record is left exactly as the other window wrote it.
        expect(readSharedServerVersionNotice(url, '7.0.0')?.notifiedAt).toBe(noticedAt);
      });

      it('records the notice so the next window can skip its own', async () => {
        const url = 'https://records-notice.example.com';
        const probes = countProbes('7.0.0');

        await probeServerVersion(url, 'mock-token');

        expect(probes()).toBe(1);
        expect(showWarningMessage).toHaveBeenCalledTimes(1);
        expect(readSharedServerVersionNotice(url, '7.0.0')).toMatchObject({ version: '7.0.0' });
      });

      it('does not record a notice for a supported version', async () => {
        const probes = countProbes('17.0.0');

        await probeServerVersion('https://supported-notice.example.com', 'mock-token');

        expect(probes()).toBe(1);
        expect(readSharedServerVersionNotice('https://supported-notice.example.com', '17.0.0')).toBeUndefined();
      });
    });
  });
});
