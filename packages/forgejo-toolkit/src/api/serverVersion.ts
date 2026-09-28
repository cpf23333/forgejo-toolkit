import { passthroughTranslate, type TranslateFn } from './translate';
import {
  clearSharedServerVersions,
  deleteSharedServerVersion,
  readSharedServerVersion,
  SERVER_VERSION_CACHE_TTL_MS,
  versionCacheKey,
  writeSharedServerVersion,
  type SharedServerVersion,
} from './serverVersionCache';

export interface ServerVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses a `/api/v1/version` payload such as "1.21.5", "v1.19.2" or
 * "7.0.1+gitea-1.22.0". Returns undefined for anything unparseable — callers
 * must fail open (an unknown version never blocks a feature).
 */
export function parseServerVersion(raw: string): ServerVersion | undefined {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

export function isVersionAtLeast(version: ServerVersion, minimum: ServerVersion): boolean {
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

// The Actions API first shipped (experimentally) with Gitea/Forgejo 1.19;
// older instances answer 404 on every /actions endpoint.
export const MIN_ACTIONS_VERSION: ServerVersion = { major: 1, minor: 19, patch: 0 };

const MIN_ACTIONS_VERSION_TEXT = `${MIN_ACTIONS_VERSION.major}.${MIN_ACTIONS_VERSION.minor}.${MIN_ACTIONS_VERSION.patch}`;

// The oldest Forgejo release the extension supports as a whole. Instances
// below it get a soft per-session warning; nothing is blocked. The floor is
// v16 because several features the extension ships rely on endpoints that
// first appeared in v16 (the Actions run jobs/artifacts/job-log/cancel/delete
// endpoints and multi-line review comments); older instances would hit 404s on
// them instead of degrading gracefully. Forgejo's 1.x line (1.21 and earlier,
// long predating the v7+ renumbering) compares below 16 naturally with plain
// semver ordering.
export const MIN_SUPPORTED_VERSION: ServerVersion = { major: 16, minor: 0, patch: 0 };

export const MIN_SUPPORTED_VERSION_TEXT = `${MIN_SUPPORTED_VERSION.major}.${MIN_SUPPORTED_VERSION.minor}.${MIN_SUPPORTED_VERSION.patch}`;

/**
 * Whether a probed server version meets the supported floor. Unknown or
 * unparseable versions pass — a failed probe must never trigger a warning.
 */
export function isVersionSupported(version: string | undefined): boolean {
  if (!version) {
    return true;
  }
  const parsed = parseServerVersion(version);
  if (!parsed) {
    return true;
  }
  return isVersionAtLeast(parsed, MIN_SUPPORTED_VERSION);
}

/**
 * This process's own probe results, keyed by normalized instance URL. Populated
 * on extension activation and after a successful connection test / instance
 * save, and read whenever the shared cache (§9 route 2, `serverVersionCache.ts`)
 * has nothing to offer: a host without a usable `globalState` (the MCP server
 * process), or a URL no window has written there yet.
 */
const serverVersions = new Map<string, { version: string; writtenAt: number }>();

/**
 * When this window invalidated an instance's cached version (an instance was
 * saved or edited), keyed by the normalized URL.
 *
 * `clearServerVersion` deletes the shared entry, but that write is asynchronous:
 * for a moment afterwards the entry it invalidated is still readable — and, if
 * it was written less than a TTL ago, still *fresh*, so a probe reading it would
 * skip the network. The probe that follows a save runs in that same moment, so
 * without this record the refresh the caller asked for would silently not
 * happen. A record written *after* the invalidation (any window's) is usable
 * again, so this heals itself instead of pinning the URL to "unknown".
 */
const versionInvalidatedAt = new Map<string, number>();

function versionKey(url: string): string {
  return versionCacheKey(url);
}

/**
 * Whether a shared entry written at `writtenAt` may be used by this window: an
 * entry this window invalidated itself (`clearServerVersion`) may not, however
 * fresh it still looks — the delete is asynchronous, and adopting the entry the
 * caller just asked to refresh would skip that refresh.
 *
 * Exported because the probe path needs the same notion of "usable" while it
 * waits for a marker holder's entry.
 */
export function isSharedEntryUsable(url: string, writtenAt: number): boolean {
  const invalidatedAt = versionInvalidatedAt.get(versionKey(url));
  return invalidatedAt === undefined || writtenAt > invalidatedAt;
}

export function setServerVersion(url: string, version: string): void {
  const key = versionKey(url);
  serverVersions.set(key, { version, writtenAt: Date.now() });
  // Record it beside the instance configuration as well, so the other windows
  // reuse this probe instead of each running one (§9 route 2). The write is not
  // awaited: this call site is synchronous, the value is already recorded here,
  // and a lost or failed write costs at most one extra probe elsewhere — it can
  // never make a window poll when it should not (the cache is not an arbiter).
  void writeSharedServerVersion(key, version);
}

/**
 * The shared entry a probe may reuse, or `undefined` when the probe has to reach
 * the network: no shared cache, no entry for that URL, an entry past its TTL, or
 * an entry this window invalidated itself (`clearServerVersion`). The last case
 * is why the probe does not read the cache directly.
 */
export function reusableSharedServerVersion(url: string): SharedServerVersion | undefined {
  const shared = readSharedServerVersion(versionKey(url));
  if (shared === undefined || shared.stale || !isSharedEntryUsable(url, shared.writtenAt)) {
    return undefined;
  }
  return shared;
}

/**
 * The version known for an instance, or `undefined` when it is unknown.
 *
 * The shared cache wins when it has a fresh entry; an *expired* entry — and one
 * this window invalidated itself — is "unknown", never a value. This feeds the
 * feature gates, and an expired "high version" would otherwise let a window run
 * gated behaviour for the rest of the session without probing. The one exception
 * is a probe this window made after the shared entry was written (its merged
 * write may still be in flight): that is newer knowledge about the same URL, and
 * it is used if it is still fresh itself.
 */
export function getServerVersion(url: string): string | undefined {
  const key = versionKey(url);
  const now = Date.now();
  const shared = readSharedServerVersion(key, now);
  if (shared !== undefined && isSharedEntryUsable(url, shared.writtenAt)) {
    if (!shared.stale) {
      return shared.version;
    }
    const local = serverVersions.get(key);
    const localIsNewer = local !== undefined && local.writtenAt > shared.writtenAt;
    return localIsNewer && now - local.writtenAt <= SERVER_VERSION_CACHE_TTL_MS ? local.version : undefined;
  }
  return serverVersions.get(key)?.version;
}

/**
 * Drops the cached version for one instance. Call before re-probing on
 * instance save/edit: a stale entry (e.g. recorded before a server upgrade)
 * would otherwise keep gating features until the session ends.
 *
 * The shared copy goes with it. Leaving it behind would be worse than the
 * problem this solves: the next probe would find a "fresh" entry and skip the
 * network, so the pre-edit version would keep gating.
 */
export function clearServerVersion(url: string): void {
  const key = versionKey(url);
  serverVersions.delete(key);
  // Stamped before the delete is issued, so the entry this call invalidates is
  // never usable by this window again, however long the delete takes to land.
  versionInvalidatedAt.set(key, Date.now());
  void deleteSharedServerVersion(key);
}

/** Drops every cached version, this process's and the shared one (tests). */
export function clearServerVersions(): void {
  serverVersions.clear();
  versionInvalidatedAt.clear();
  void clearSharedServerVersions();
}

/**
 * The on-demand half of the gate: what a *gated call site* has to do before it
 * evaluates the version.
 *
 * §9 route 2's TTL is what makes the shared cache safe (an expired "high version"
 * must never keep gating), but on its own it also means the gate decays: nothing
 * re-probes on a schedule, so after 60 s of a long session the recorded version
 * is "unknown" and `isVersionSupported(undefined) === true` opens every gate for
 * the rest of that session. The answer is not a background timer — it is to ask
 * at the one moment the answer is about to be used.
 *
 * `probe` is the caller's own probe (it holds the token). It goes through the
 * shared single-flight coordination and is only consulted when the known version
 * is missing or stale, so a fresh entry costs a store read and no request. Its
 * own failure is swallowed: the gates below then see "unknown" and allow, which
 * is exactly the fail-open direction the extension has always had.
 */
export async function assertActionsSupportedAfterProbe(
  url: string,
  probe: () => Promise<string | undefined>,
  t: TranslateFn = passthroughTranslate,
): Promise<void> {
  if (getServerVersion(url) === undefined) {
    try {
      await probe();
    } catch {
      // A probe must never turn into a failed action: unknown fails open below.
    }
  }
  assertActionsSupported(url, t);
}

/**
 * Throws a localized, actionable error when the cached server version is
 * known to predate the Actions API. Unknown or unparseable versions pass —
 * the version probe is best-effort and must never block a working instance.
 * The extension passes vscode.l10n.t as `t`; headless consumers keep the
 * English passthrough default.
 *
 * Gated call sites reach this through {@link assertActionsSupportedAfterProbe}
 * rather than calling it directly, so a version the TTL has expired does not
 * silently disable the gate for the rest of the session.
 */
export function assertActionsSupported(url: string, t: TranslateFn = passthroughTranslate): void {
  const raw = getServerVersion(url);
  if (!raw) {
    return;
  }
  const version = parseServerVersion(raw);
  if (!version || isVersionAtLeast(version, MIN_ACTIONS_VERSION)) {
    return;
  }
  throw new Error(
    t(
      'This feature requires Forgejo {0} or newer, but this server reports version {1}.',
      MIN_ACTIONS_VERSION_TEXT,
      raw,
    ),
  );
}
