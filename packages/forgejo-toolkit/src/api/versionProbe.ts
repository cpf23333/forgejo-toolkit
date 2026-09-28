import { redactUrlUserinfo } from '../utils/redactUrlUserinfo';
import { ForgejoClient, type ClientLogger } from './client';
import { getForgejoClientHost } from './clientHost';
import {
  isSharedEntryUsable,
  isVersionSupported,
  MIN_SUPPORTED_VERSION_TEXT,
  reusableSharedServerVersion,
  setServerVersion,
} from './serverVersion';
import {
  readSharedServerVersionNotice,
  recordSharedServerVersionNotice,
  withSharedServerVersion,
} from './serverVersionCache';

/**
 * An instance URL with its credentials removed, for logs.
 *
 * A configured instance URL may embed credentials (`https://user:token@host`),
 * and the log lines below reach the output channel and the MCP server's stderr.
 * The rule lives in `utils/redactUrlUserinfo.ts`, which imports nothing and so
 * is safe for this MCP-bundle module; this name is kept for the callers that
 * already use it.
 */
export const redactInstanceUrl = redactUrlUserinfo;

/**
 * The versions this window has already warned about, keyed by
 * `normalized url \n version`. The in-process half of the notice dedupe: a
 * window that probes twice for the same still-unsupported instance must warn
 * once, and a probe that discovers a *different* version must be able to warn
 * again — so the key carries the version rather than the URL alone.
 */
const warnedUnsupportedVersions = new Set<string>();

function alreadyWarnedLocally(url: string, version: string): boolean {
  return warnedUnsupportedVersions.has(`${url}\n${version}`);
}

/**
 * Best-effort server version probe: the result feeds the feature gates in
 * `serverVersion.ts`. Failures are logged at debug level and swallowed —
 * an instance that cannot be probed simply keeps every feature enabled
 * (the gates fail open for unknown versions). A probed version below the
 * supported floor triggers a soft host notification; nothing is blocked.
 *
 * The logger is the client-facing interface on purpose: the MCP server process
 * runs this too, and it only has the console-backed `ClientLogger` (the editor's
 * `Logger` implements it, so both callers work).
 *
 * Before reaching the network the shared probe cache is consulted (§9 route 2):
 * another window — the polling leader, or any window that got there first — may
 * already have probed this instance and recorded the result beside the instance
 * list. A fresh entry is reused as it is, so the steady state is one request per
 * instance for the whole machine instead of one per window; a missing entry and
 * an entry past its TTL are both probed here and merged back. An expired entry
 * is deliberately not used for the gates either (`serverVersion.ts`), so the
 * safe direction for an old value is "unknown", which fails open. A window that
 * invalidated the entry itself (`clearServerVersion`, i.e. the refresh that
 * follows an instance save) also probes: the entry is still readable for a
 * moment, and adopting it would skip exactly the refresh the caller asked for.
 *
 * A fresh entry alone is not enough to stop two windows probing at once, so the
 * probe goes through the shared single-flight marker: a window that finds
 * another live window's marker waits — bounded — for that window's entry and
 * adopts it instead of issuing its own request. The wait always fails open: on
 * timeout, on a marker whose owner died, and on a store that cannot be read, the
 * window probes itself. Nothing here can block activation or a user action beyond
 * that bound, and the marker is a cache, so losing it costs one extra probe.
 *
 * A version adopted from the cache does not re-raise the low-version notice:
 * whichever window probed it reported it then (§9 route 1). Two windows can still
 * probe at once when both claim the marker in the same instant, so the notice
 * itself is deduped across windows too: the window that probed re-reads the
 * shared record and stays quiet when a notice for that same version is already
 * there.
 */
export async function probeServerVersion(
  url: string,
  token: string,
  logger?: ClientLogger,
  syncApiUrlsToInstanceUrl?: boolean,
): Promise<void> {
  const cached = reusableSharedServerVersion(url);
  if (cached !== undefined) {
    logger?.debug(
      `Server version for ${redactInstanceUrl(url)}: ${cached.version} (shared probe cache, written ${Date.now() - cached.writtenAt} ms ago)`,
    );
    return;
  }
  try {
    const client = new ForgejoClient(url, token, logger, syncApiUrlsToInstanceUrl);
    const outcome = await withSharedServerVersion(
      url,
      () => client.getServerVersion(),
      // The probe path's own notion of "usable": an entry this window
      // invalidated must not be adopted, and an entry that was missing or stale
      // when the probe was requested must not become usable mid-wait.
      {
        skip: (entry) => !isSharedEntryUsable(url, entry.writtenAt),
      },
    );
    if (outcome === undefined) {
      return;
    }
    setServerVersion(url, outcome.version);
    logger?.debug(
      `Server version for ${redactInstanceUrl(url)}: ${outcome.version}${outcome.probed ? '' : ' (adopted from another window)'}`,
    );
    // Only the window that probed warns: a value adopted from the cache was
    // already reported by whichever window produced it (§9 route 1).
    if (outcome.probed) {
      await warnIfUnsupported(url, outcome.version);
    }
  } catch (error) {
    // The failure detail can echo the request URL (fetch refuses a URL that
    // carries credentials and quotes it back), so the raw URL is replaced
    // wherever it appears, not just in the prefix.
    const detail = error instanceof Error ? error.message : String(error);
    const redactedUrl = redactInstanceUrl(url);
    logger?.debug(`Server version probe failed for ${redactedUrl}: ${detail.split(url).join(redactedUrl)}`);
  }
}

/**
 * Raises the low-version notice for a version this window probed, unless it is
 * already covered.
 *
 * The shared record is read *before* notifying and written before notifying on
 * purpose: the window that loses a simultaneous-marker race re-reads this record
 * after its own probe, sees the notice, and stays quiet. The in-process set
 * remains the fast path for the ordinary repeat (activation, a save, a
 * connection test in the same session).
 */
async function warnIfUnsupported(url: string, version: string): Promise<void> {
  if (isVersionSupported(version) || alreadyWarnedLocally(url, version)) {
    return;
  }
  if (readSharedServerVersionNotice(url, version) !== undefined) {
    return;
  }
  if (!(await recordSharedServerVersionNotice(url, version))) {
    return;
  }
  warnedUnsupportedVersions.add(`${url}\n${version}`);
  getForgejoClientHost().notifyUnsupportedInstance(url, MIN_SUPPORTED_VERSION_TEXT, version);
}

/** Drops the in-process notice dedupe (tests). */
export function clearUnsupportedVersionWarnings(): void {
  warnedUnsupportedVersions.clear();
}
