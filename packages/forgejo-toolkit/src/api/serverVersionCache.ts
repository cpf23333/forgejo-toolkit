/**
 * The shared, timestamped server-version cache of §9 route 2 — plus the two
 * consequences the design left open: a **single-flight marker** so a window that
 * finds the cache entry missing waits for the window already probing instead of
 * probing again, and a **notice record** so only the window that actually probed
 * raises the low-version warning.
 *
 * A probe result is a property of an instance, so it is stored beside the
 * instance configuration — in the editor's `globalState`, under a key of its own
 * next to `forgejoToolkit.instances` — instead of per process. The window that
 * probes first records the version there and every other window reuses it,
 * which is what turns "one probe per instance per window" into "one probe per
 * instance for the whole machine" while the record is fresh.
 *
 * Six properties of that decision shape this module:
 *
 * - **It is a cache, not an arbiter.** `globalState` has no cross-window change
 *   event and `get`→`update` is not atomic (`config.ts` says so in writing), so a
 *   concurrent write can be lost. That is acceptable here and only here: a lost
 *   update costs one extra probe, and it can never decide who polls (the
 *   election is file-only; §2 decision 1). The merge write below narrows the
 *   window the same way `_writeInstancesMerged` does: re-read immediately before
 *   writing, then replace only the keys this window is responsible for.
 * - **The in-flight marker is a cache too.** It exists only to save one of two
 *   racing windows a request. A marker that is lost, overwritten in the same
 *   instant by another window's, or ignored because its writer died costs one
 *   extra probe — never a wrong gate, and never a blocked user action, because
 *   every wait in here is bounded and fails open. Two windows that write a
 *   marker within the same read-check-write span can still both go on to probe;
 *   `globalState` cannot make that span atomic, so that residue is knowingly
 *   accepted rather than papered over.
 * - **A stale entry is unknown, never a value.** The cache gates features (a
 *   low-version instance must be flagged and its Actions calls refused), so an
 *   expired "high version" would let a window run gated behaviour for the rest
 *   of the session without probing. Every entry therefore carries its write time
 *   and expires after `SERVER_VERSION_CACHE_TTL_MS`; an expired entry is
 *   reported as `stale` and the caller must probe again. The safe default for an
 *   unknown version is the existing one (`isVersionSupported(undefined) === true`).
 * - **One place, one slot.** Entries, in-flight markers and the notice record
 *   are three sections of the *same* whole-value slot. No new file and no new
 *   `globalState` key: the slot is written as one merged value, so every section
 *   is read and written through the same narrow-the-window discipline. The two
 *   metadata sections are named under `#`, which no normalised instance URL can
 *   collide with.
 * - **Two shapes are tolerated.** This feature is unreleased, so the previous
 *   build's bare `{ [urlKey]: { version, writtenAt } }` map (and a hand-edited or
 *   half-written slot) must still read correctly: a bare map yields its instance
 *   entries and no metadata, and a corrupt entry is dropped rather than used as a
 *   value. Nothing needs migrating, and the next write of any kind upgrades the
 *   slot in place.
 * - **Storage is optional.** The MCP server process, a host without a usable
 *   `globalState`, and every module-level unit test run without a store: reads
 *   then report "nothing shared" and the caller keeps using its process-local
 *   map. Nothing in this module throws at a caller; unavailability is expressed
 *   as `undefined` from a read and as a no-op write.
 *
 * The module deliberately imports nothing — not `vscode`, not the logger — so
 * the MCP bundle can keep pulling it in through `serverVersion.ts` (the build
 * enforces that entry's no-`vscode` guarantee with a metafile graph check).
 */

/** One instance's probe result as it is persisted. */
export interface ServerVersionCacheEntry {
  /** The raw version string the probe returned (e.g. `16.0.1`). */
  version: string;
  /** `Date.now()` in the writing window, compared against the reader's clock. */
  writtenAt: number;
  /**
   * When a window raised the low-version notice for *this* version. Written by
   * the window that probed, so a second window that probed anyway (it lost the
   * simultaneous-marker race) can see the notice is already covered. Cleared
   * whenever a new version is recorded: a server that moves, or moves back, must
   * be able to warn again.
   */
  notifiedAt?: number;
}

/** One window's claim that it is probing an instance right now. */
export interface ServerVersionProbeMarker {
  /** The claiming window's process id, checked with `process.kill(pid, 0)`. */
  pid: number;
  /** `Date.now()` in the claiming window. */
  at: number;
}

/** The notice record for one instance: which version was warned about, and when. */
export interface ServerVersionNotice {
  version: string;
  notifiedAt: number;
}

/** One instance's result as the whole-map reader reports it. */
export interface SharedServerVersionEntry {
  version: string;
  writtenAt: number;
  notifiedAt?: number;
}

/** Every instance entry in the slot, keyed by normalised URL. */
export type SharedServerVersionMap = Record<string, SharedServerVersionEntry>;

/**
 * The `#`-prefixed metadata sections of the slot. An instance key can never
 * collide with them: every instance key this module writes comes from
 * `versionCacheKey(url)`, and a normalised instance URL always names an
 * authority (`https://forgejo.example.com`), never a bare `#name`.
 */
const MARKERS_KEY = '#inflight';
const NOTICES_KEY = '#notices';
const INSTANCES_KEY = '#instances';

/**
 * How long a shared probe result stays usable. A starting value: §9 route 2
 * settles it together with the other measured parameters, and it is deliberately
 * short (an upgrade or downgrade must not be dragged to the end of a session),
 * not chosen to save requests.
 */
export const SERVER_VERSION_CACHE_TTL_MS = 60_000;

/**
 * How long a probe marker stays believable. It must outlast the probe's own
 * request timeout (`API_REQUEST_TIMEOUT_MS`, 30 s) with room for the merge write
 * that follows it, or a slow-but-alive prober would be declared dead and probed
 * over — exactly the duplicate the marker exists to remove. It is *not* the wait
 * bound below: a dead pid takes the marker over immediately, so this TTL only
 * covers the window in which nothing can be concluded.
 */
export const SERVER_VERSION_PROBE_MARKER_TTL_MS = 45_000;

/**
 * How long a window that found a live probe marker waits for that probe's entry
 * before giving up and probing itself. Chosen inside the 5–15 s the design
 * allows: a healthy probe of `/api/v1/version` answers in well under a second,
 * so 10 s covers a slow link with margin, while it stays short enough that an
 * action gated on the version is never held up perceptibly. It is unrelated to
 * the marker TTL above — that is the marker's believability, this is the
 * waiter's patience, and the waiter always gives up long before the marker
 * expires.
 */
export const SERVER_VERSION_PROBE_WAIT_TIMEOUT_MS = 10_000;

/**
 * How often the waiter re-reads the slot. Long enough not to spin on a store
 * read in a poll loop that will usually last a few hundred milliseconds, short
 * enough that adopting a fast probe's result is not perceptibly delayed.
 */
export const SERVER_VERSION_PROBE_POLL_INTERVAL_MS = 200;

/**
 * The persistence behind the cache: one whole-value slot, read synchronously.
 *
 * `read` returns whatever is stored (validated by this module, so a
 * hand-edited store cannot inject a broken entry into a gate), and `write`
 * replaces the slot. Both may throw or reject: this module treats that as "the
 * shared cache is unavailable" and the caller falls back to its process-local
 * map.
 */
export interface ServerVersionCacheStorage {
  read(): unknown;
  write(next: unknown): Promise<void>;
}

/** The subset of `vscode.Memento` the adapter below needs. */
export interface ServerVersionCacheMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Builds a storage port over an editor state store (`context.globalState`).
 *
 * Failures are reported through `onError` and then swallowed: a store that
 * cannot be read or written must degrade to the in-process behaviour, never
 * break a probe or a request. The caller passes the extension logger, which
 * this module must not import itself.
 */
export function createMementoServerVersionCache(
  memento: ServerVersionCacheMemento,
  key: string,
  onError?: (message: string) => void,
): ServerVersionCacheStorage {
  const report = (operation: string, error: unknown): void => {
    onError?.(
      `Shared server-version cache ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  return {
    read: () => {
      try {
        return memento.get<unknown>(key, undefined);
      } catch (error) {
        report('read', error);
        return undefined;
      }
    },
    write: (next) => {
      try {
        return Promise.resolve(memento.update(key, next)).catch((error: unknown) => {
          report('write', error);
        });
      } catch (error) {
        // A store that throws instead of rejecting must not escape either.
        report('write', error);
        return Promise.resolve();
      }
    },
  };
}

/**
 * The normalised cache key for an instance: the same trailing-slash form the
 * probe cache has always used, so an instance configured as
 * `https://forgejo.example.com/` and its canonical spelling share one entry.
 */
export function versionCacheKey(url: string): string {
  return url.replace(/\/+$/, '');
}

let storage: ServerVersionCacheStorage | undefined;

/**
 * Installs the store the cache reads and writes, or `undefined` to detach it.
 * Called by `ConfigManager`, which owns the extension context and the key beside
 * the instance list; the MCP server process never calls it and so keeps the
 * process-local behaviour.
 */
export function setServerVersionCacheStorage(next: ServerVersionCacheStorage | undefined): void {
  storage = next;
}

/** One shared entry as a reader sees it, with the TTL already applied. */
export interface SharedServerVersion {
  version: string;
  writtenAt: number;
  /**
   * True when `now - writtenAt > SERVER_VERSION_CACHE_TTL_MS`: the entry is
   * unknown and the caller must probe rather than use it.
   */
  stale: boolean;
}

/**
 * Reads one instance's shared entry, or `undefined` when there is no shared
 * cache, no entry for that URL, or the store could not be read. The staleness is
 * reported rather than hidden, so the diagnostics payload can show an expired
 * record while the gates still treat it as unknown.
 */
export function readSharedServerVersion(url: string, now: number = Date.now()): SharedServerVersion | undefined {
  const entry = readSnapshot()?.instances[versionCacheKey(url)];
  if (entry === undefined) {
    return undefined;
  }
  return { version: entry.version, writtenAt: entry.writtenAt, stale: isStale(entry.writtenAt, now) };
}

/**
 * Every validated instance entry in the slot, keyed by normalised URL. For the
 * consumers that need the whole map (diagnostics, tests) rather than one
 * instance's gate value; an unusable or detached store reads as `{}`.
 */
export function readSharedServerVersions(): SharedServerVersionMap {
  const snapshot = readSnapshot();
  return snapshot === undefined ? {} : { ...snapshot.instances };
}

/**
 * Merges one probe result into the shared cache and returns when the write has
 * settled. The returned promise never rejects: this is a cache, and a failed
 * write must not turn into a failed probe.
 *
 * Any notice recorded against the entry being replaced goes with it, so a server
 * that is downgraded and then upgraded warns again about the new version instead
 * of inheriting the replaced version's silence.
 */
export function writeSharedServerVersion(url: string, version: string, now: number = Date.now()): Promise<void> {
  const key = versionCacheKey(url);
  return mergeWrite((fresh) => {
    const previous = fresh.instances[key];
    fresh.instances[key] = { version, writtenAt: now };
    if (previous !== undefined && previous.notifiedAt !== undefined) {
      // A notice is about a version, not about an instance: carrying it across a
      // version change is what would silence the next one.
      delete fresh.notices[key];
    }
  });
}

/**
 * Drops one instance's shared entry (the instance was removed, or its saved
 * configuration invalidated the value), so the next probe cannot be skipped in
 * favour of a result that no longer describes the instance. The instance's
 * in-flight marker and notice record go with it: neither describes the instance
 * any more, and a leftover notice would suppress the warning for the version the
 * fresh configuration ends up reporting.
 */
export function deleteSharedServerVersion(url: string): Promise<void> {
  const key = versionCacheKey(url);
  return mergeWrite((fresh) => {
    delete fresh.instances[key];
    delete fresh.markers[key];
    delete fresh.notices[key];
  });
}

/**
 * Drops the whole shared cache. Exported for the test reset
 * (`clearServerVersions`), not for a product path: it deliberately replaces the
 * slot instead of merging, so it cannot be mistaken for the merge write above.
 */
export function clearSharedServerVersions(): Promise<void> {
  if (storage === undefined) {
    return Promise.resolve();
  }
  try {
    return storage.write(toStoredValue(emptySnapshot())).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

/**
 * The notice a window has already raised for an instance, or `undefined`. A
 * notice for a *different* version does not count: the value moved, so the
 * question has to be asked again (and `writeSharedServerVersion` has already
 * cleared the replaced notice).
 */
export function readSharedServerVersionNotice(url: string, version: string): ServerVersionNotice | undefined {
  const notice = readSnapshot()?.notices[versionCacheKey(url)];
  if (notice === undefined || notice.version !== version) {
    return undefined;
  }
  return notice;
}

/**
 * Records that a window raised the low-version notice for `version`, and reports
 * whether *this* call was the one that recorded it. Only the first caller for a
 * given version is told `true`, so the notice is raised once for the whole
 * machine while a window that adopted the version from the cache — or one that
 * probed anyway because two windows claimed the marker in the same instant —
 * stays quiet.
 *
 * A store that cannot be written reports the caller's own first-ness honestly:
 * suppressing a notice the user needs is worse than repeating one, so `false`
 * means "another window already recorded this", never "the store failed".
 */
export function recordSharedServerVersionNotice(
  url: string,
  version: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = versionCacheKey(url);
  if (readSnapshot()?.notices[key]?.version === version) {
    return Promise.resolve(false);
  }
  let first = true;
  return mergeWrite((fresh) => {
    if (fresh.notices[key]?.version === version) {
      first = false;
      return;
    }
    fresh.notices[key] = { version, notifiedAt: now };
  }).then(() => first);
}

/**
 * The live in-flight claim on an instance, or `undefined` when no window is
 * probing it. A marker whose pid is no longer alive reads as `undefined`
 * immediately — never "believable until the TTL runs out" — because waiting on a
 * dead prober is the one case the wait bound cannot settle quickly.
 *
 * `pidAlive` is injectable so a test can decide the outcome instead of hunting
 * for a pid that is guaranteed dead on every platform; production callers leave
 * it out.
 */
export function readActiveServerVersionProbe(
  url: string,
  now: number = Date.now(),
  pidAlive: (pid: number) => boolean = isPidAlive,
): ServerVersionProbeMarker | undefined {
  const marker = readSnapshot()?.markers[versionCacheKey(url)];
  if (marker === undefined || !isMarkerBelievable(marker, now) || !pidAlive(marker.pid)) {
    return undefined;
  }
  return marker;
}

/**
 * Records this window's in-flight claim and reports whether it won the right to
 * probe. `false` means another window's marker is live and this window must wait
 * for that window's entry instead.
 *
 * The check and the claim happen in one synchronous span (`read` then `write`,
 * with no `await` between them), which is as narrow as `globalState` allows:
 * `get`→`update` is not atomic, so two windows writing in the same instant can
 * still both be told `true`. That is deliberate residue — the marker is a cache,
 * so the cost is one extra probe, and both windows then race
 * `recordSharedServerVersionNotice` to decide which one warns.
 */
export function claimSharedServerVersionProbe(
  url: string,
  pid: number = process.pid,
  now: number = Date.now(),
  pidAlive: (pid: number) => boolean = isPidAlive,
): Promise<boolean> {
  const key = versionCacheKey(url);
  if (readActiveServerVersionProbe(key, now, pidAlive) !== undefined) {
    return Promise.resolve(false);
  }
  return mergeWrite((fresh) => {
    fresh.markers[key] = { pid, at: now };
  }).then(() => true);
}

/**
 * Ends this window's claim. Best-effort, and conditional on the marker still
 * being this window's, so a window that took the marker over after a false
 * "owner is dead" reading is not disarmed by the previous owner.
 */
export function releaseSharedServerVersionProbe(url: string, pid: number = process.pid): Promise<void> {
  const key = versionCacheKey(url);
  return mergeWrite((fresh) => {
    if (fresh.markers[key]?.pid === pid) {
      delete fresh.markers[key];
    }
  });
}

/**
 * What one coordination pass produced: the version, and whether *this* window
 * was the one that probed for it. The distinction is what keeps the low-version
 * notice with the window that probed (§9 route 1): a window that adopted the
 * value from the cache must not warn again.
 */
export interface SharedServerVersionOutcome {
  version: string;
  /** True when this window issued the request that produced `version`. */
  probed: boolean;
}

/**
 * The coordination every prober shares: if this window can already answer, use
 * that; otherwise, if another live window is probing, wait — bounded — for its
 * entry and adopt it; otherwise claim the marker, probe, record the result beside
 * the instance list, and release the marker.
 *
 * `skip` lets a caller that cannot use the shared entry make that explicit: the
 * probe path passes it when *this* window invalidated that entry itself. It is
 * consulted on the first read and on every poll, so a window that invalidates an
 * entry mid-wait is not then talked into adopting it.
 *
 * `fetched` is called only by the window that owns the marker, so a probe that
 * throws, hangs, or returns nothing costs only that window's caller — which
 * fails open. Every wait here is bounded by `timeoutMs` (and resolves to whatever
 * the last read saw, including `undefined`); the only unbounded part is the probe
 * itself, which carries the API client's own request timeout. Nothing in this
 * function throws.
 */
export async function withSharedServerVersion(
  url: string,
  fetched: () => Promise<string | undefined>,
  options: {
    now?: () => number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    pid?: number;
    pidAlive?: (pid: number) => boolean;
    skip?: (entry: SharedServerVersion) => boolean;
  } = {},
): Promise<SharedServerVersionOutcome | undefined> {
  const now = options.now ?? (() => Date.now());
  const pid = options.pid ?? process.pid;
  const pidAlive = options.pidAlive ?? isPidAlive;
  const key = versionCacheKey(url);
  const timeoutMs = options.timeoutMs ?? SERVER_VERSION_PROBE_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SERVER_VERSION_PROBE_POLL_INTERVAL_MS;
  const skip = options.skip;

  const usable = (): SharedServerVersion | undefined => {
    const latest = readSharedServerVersion(key, now());
    if (latest === undefined || latest.stale || skip?.(latest) === true) {
      return undefined;
    }
    return latest;
  };

  const existing = usable();
  if (existing !== undefined) {
    return { version: existing.version, probed: false };
  }

  const wait = (): Promise<string | undefined> =>
    waitForSharedServerVersion(key, timeoutMs, pollIntervalMs, now, pid, pidAlive, skip);

  if (readActiveServerVersionProbe(key, now(), pidAlive) !== undefined) {
    const adopted = await wait();
    if (adopted !== undefined) {
      return { version: adopted, probed: false };
    }
  }

  if (!(await claimSharedServerVersionProbe(key, pid, now(), pidAlive))) {
    // Another window claimed the marker between the two reads above. Wait for
    // its entry rather than probing over it; on timeout, probe anyway.
    const adopted = await wait();
    if (adopted !== undefined) {
      return { version: adopted, probed: false };
    }
  }

  let probed: string | undefined;
  try {
    const version = await fetched();
    if (version) {
      probed = version;
      await writeSharedServerVersion(key, version, now());
    }
  } finally {
    await releaseSharedServerVersionProbe(key, pid);
  }

  // The version this window probed is the answer even when there is no shared
  // slot to read it back from (the MCP server process, a host without a usable
  // `globalState`): the caller's process-local record must not go empty just
  // because the cross-window cache is unavailable. A read that now finds a
  // *different* value is another window's, not this window's probe.
  const settled = usable();
  if (settled !== undefined) {
    return { version: settled.version, probed: probed === settled.version };
  }
  return probed === undefined ? undefined : { version: probed, probed: true };
}

/**
 * Waits for a shared entry this window may use, re-reading on an interval. It
 * gives up when the bound expires, and when the marker it is waiting on is gone
 * or its owner is dead — nobody is coming then, and the caller should probe
 * rather than sit out the rest of the bound.
 */
async function waitForSharedServerVersion(
  key: string,
  timeoutMs: number,
  pollIntervalMs: number,
  now: () => number,
  pid: number,
  pidAlive: (pid: number) => boolean,
  skip: ((entry: SharedServerVersion) => boolean) | undefined,
): Promise<string | undefined> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const entry = readSharedServerVersion(key, now());
    if (entry !== undefined && !entry.stale && skip?.(entry) !== true) {
      return entry.version;
    }
    const marker = readSnapshot()?.markers[key];
    if (marker === undefined || marker.pid === pid || !isMarkerBelievable(marker, now()) || !pidAlive(marker.pid)) {
      // Nothing to wait for: the entry is still missing and the caller probes.
      // A marker this window owns ends the wait too — it won a claim elsewhere
      // and must not sit waiting on itself.
      return undefined;
    }
    if (now() >= deadline) {
      return undefined;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
}

/**
 * True while the process exists — `process.kill(pid, 0)` sends no signal, throws
 * `ESRCH` for a dead pid and `EPERM` for a live process this user may not signal,
 * and `EPERM` counts as alive because taking over a live window's probe is worse
 * than waiting (§3.5).
 *
 * Three lines, deliberately duplicated rather than imported from `src/lease/**`:
 * that module carries fs and logging machinery this file must keep out of the
 * MCP bundle it is compiled into, and the same rule is already written out
 * separately in `mcpBroker.ts`, `mcpWorkspaceState.ts` and `leaseStore.ts` for
 * the same reason.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* -------------------------------------------------------------------------- */
/* The slot                                                                    */
/* -------------------------------------------------------------------------- */

/** The validated contents of one slot read. */
interface ServerVersionSnapshot {
  /** Instance entries, keyed by normalised URL. */
  instances: Record<string, ServerVersionCacheEntry>;
  /** In-flight probe markers, keyed by normalised URL. */
  markers: Record<string, ServerVersionProbeMarker>;
  /** Notice records, keyed by normalised URL. */
  notices: Record<string, ServerVersionNotice>;
}

function emptySnapshot(): ServerVersionSnapshot {
  return { instances: {}, markers: {}, notices: {} };
}

/**
 * The merge write: re-read the slot immediately before writing and hand the
 * caller the fresh snapshot to modify, so entries written by other windows since
 * this window last read survive. The race cannot be closed (`get`→`update` is
 * not atomic); it is only as narrow as the synchronous span between the two
 * calls, exactly like `_writeInstancesMerged` in `config.ts`.
 *
 * The whole snapshot is written back, so a slot in the older bare shape is
 * upgraded in place by the next write of any kind.
 */
async function mergeWrite(mutate: (fresh: ServerVersionSnapshot) => void): Promise<void> {
  if (storage === undefined) {
    return;
  }
  const fresh = readSnapshot() ?? emptySnapshot();
  mutate(fresh);
  try {
    await storage.write(toStoredValue(fresh));
  } catch {
    // Best-effort: a lost update costs one extra probe, and the caller has
    // already recorded its own result in its process-local map.
  }
}

/**
 * A validated copy of the stored slot, or `undefined` when it cannot be read.
 *
 * Both slot shapes are accepted. A record carrying any of the three section keys
 * is the current shape; anything else is the older bare instance map. Sections
 * that are missing or malformed read as empty, and a malformed entry or marker or
 * notice is dropped rather than used — a half-written or hand-edited slot must
 * never reach a gate as a value.
 */
function readSnapshot(): ServerVersionSnapshot | undefined {
  if (storage === undefined) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = storage.read();
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const sections = isRecord(raw[INSTANCES_KEY]) || isRecord(raw[MARKERS_KEY]) || isRecord(raw[NOTICES_KEY]);
  const instancesSource = sections ? (raw[INSTANCES_KEY] as Record<string, unknown> | undefined) : raw;
  const snapshot = emptySnapshot();
  for (const [key, value] of Object.entries(isRecord(instancesSource) ? instancesSource : {})) {
    const entry = normalizeEntry(value);
    if (entry !== undefined) {
      snapshot.instances[key] = entry;
    }
  }
  for (const [key, value] of Object.entries(isRecord(raw[MARKERS_KEY]) ? raw[MARKERS_KEY] : {})) {
    const marker = normalizeMarker(value);
    if (marker !== undefined) {
      snapshot.markers[key] = marker;
    }
  }
  for (const [key, value] of Object.entries(isRecord(raw[NOTICES_KEY]) ? raw[NOTICES_KEY] : {})) {
    const notice = normalizeNotice(value);
    if (notice !== undefined) {
      snapshot.notices[key] = notice;
    }
  }
  return snapshot;
}

/**
 * The value a snapshot is persisted as. A slot that holds instance entries and no
 * metadata is written in the older, bare shape — that is the shape a build
 * without this coordination wrote, and it is what this module reads back — and
 * anything else carries the three named sections.
 */
function toStoredValue(snapshot: ServerVersionSnapshot): unknown {
  if (Object.keys(snapshot.markers).length === 0 && Object.keys(snapshot.notices).length === 0) {
    return { ...snapshot.instances };
  }
  return {
    [INSTANCES_KEY]: { ...snapshot.instances },
    [MARKERS_KEY]: { ...snapshot.markers },
    [NOTICES_KEY]: { ...snapshot.notices },
  };
}

/** Accepts only a well-formed entry; anything else is treated as no entry. */
function normalizeEntry(value: unknown): ServerVersionCacheEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { version, writtenAt, notifiedAt } = value as {
    version?: unknown;
    writtenAt?: unknown;
    notifiedAt?: unknown;
  };
  if (typeof version !== 'string' || version === '' || typeof writtenAt !== 'number' || !Number.isFinite(writtenAt)) {
    return undefined;
  }
  const entry: ServerVersionCacheEntry = { version, writtenAt };
  if (typeof notifiedAt === 'number' && Number.isFinite(notifiedAt)) {
    entry.notifiedAt = notifiedAt;
  }
  return entry;
}

/** Accepts only a well-formed marker; anything else is treated as no marker. */
function normalizeMarker(value: unknown): ServerVersionProbeMarker | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { pid, at } = value as { pid?: unknown; at?: unknown };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return undefined;
  }
  return { pid, at };
}

/** Accepts only a well-formed notice; anything else is treated as no notice. */
function normalizeNotice(value: unknown): ServerVersionNotice | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { version, notifiedAt } = value as { version?: unknown; notifiedAt?: unknown };
  if (typeof version !== 'string' || version === '') {
    return undefined;
  }
  if (typeof notifiedAt !== 'number' || !Number.isFinite(notifiedAt)) {
    return undefined;
  }
  return { version, notifiedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMarkerBelievable(marker: ServerVersionProbeMarker, now: number): boolean {
  return now - marker.at <= SERVER_VERSION_PROBE_MARKER_TTL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isStale(writtenAt: number, now: number): boolean {
  return now - writtenAt > SERVER_VERSION_CACHE_TTL_MS;
}
