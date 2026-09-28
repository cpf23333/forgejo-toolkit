import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';
import * as vscode from 'vscode';

/**
 * The first-run guide's cross-window coordination token.
 *
 * The design is `docs/design/multi-window-polling-lease.md` §9 ("首次运行向导"):
 * the extension activates per window (`onStartupFinished`), so windows restored
 * together on a fresh install can each open the setup guide. The guide used to
 * be arbitrated by a boolean in the editor's state store, whose read-then-write
 * is not atomic across windows (§1.2) — the same class of race as the polling
 * lease, with a completely different lifetime. Rather than fold a one-shot flag
 * into the lease protocol, the guide borrows the lease's one primitive:
 * `fs.open(path, 'wx')` is a genuine mutual exclusion on one machine and one
 * filesystem, so among windows activating at the same moment exactly one
 * creates the token and opens the guide.
 *
 * **The token is an offer in flight, not a permanent record.** It says "some
 * window is showing the guide right now", and it is live only while that is
 * plausibly true: the recorded owner process still exists *and* the token is
 * younger than `WELCOME_MARKER_MAX_AGE_MS`. Once the owner is gone or the token
 * is older than that bound, the next activation takes the token over and offers
 * the guide again — which is the behaviour the guide has always had for a
 * profile with no configured instance ("the guide keeps offering itself until
 * an instance exists or the guide is actually completed", see `src/welcome.ts`).
 * The permanent record is the legacy state-store flag, not this file.
 *
 * Failure direction (the same rule as §8): the token is an *optimization*, not
 * a gate. A token that cannot be created — a read-only profile directory, a
 * denied create, a full disk — makes this window show the guide exactly as it
 * did before this file existed. Never a suppressed guide.
 */

/**
 * The token's fixed name, next to the other per-profile files the extension
 * keeps in globalStorage (`mcp-instances.json`, `mcp-leader-lease.json`,
 * `mcp-workspace-<pid>-<nonce>.json`). Fixed and not pid/nonce-keyed on purpose:
 * the whole point is that every window of the profile looks at the same name.
 * Named for the *offer* it represents, not for a "has been shown" record — the
 * file is taken over or removed when the offer ends, so a name promising
 * permanence would mislead whoever inspects the profile — and named after the
 * guide rather than the lease file, because it is deliberately *not* part of the
 * lease.
 */
export const WELCOME_MARKER_FILE_NAME = 'first-run-guide-offer.json';

/** The token's record version, first field like the other files this extension leaves behind. */
const WELCOME_MARKER_VERSION = 1;

/**
 * How long an offer token may suppress other windows, whatever its owner pid
 * says (30 minutes). The pid rule below does the real work for the case this
 * mechanism exists for — windows restored together — and this bound is the
 * second, independent way out of the suppression: a window still open half an
 * hour later has had a long look at the guide, so a no-instance profile may be
 * nudged again rather than kept quiet until that window closes. It also covers
 * a token whose owner pid cannot be probed (a recycled pid, a process of
 * another user, a suspended host): no offer may suppress the guide forever.
 */
export const WELCOME_MARKER_MAX_AGE_MS = 30 * 60_000;

/**
 * How many times an unparseable token is re-read, and the delay between reads
 * (3 × 20 ms, so a writer gets ~40 ms of patience on top of the write grace
 * below). The only writer that can publish an unparseable token is the winner of
 * the `wx` create, and only for the microseconds between its create and its
 * payload write; this window is far more than that, and it keeps a second window
 * activating at the same instant from misreading the winner's empty file as
 * "nobody is offering the guide".
 */
const WELCOME_MARKER_READ_ATTEMPTS = 3;
const WELCOME_MARKER_READ_RETRY_MS = 20;

/**
 * How recently an unparseable token must have been touched to count as an offer
 * still being written (150 ms), on top of the re-reads above. Deliberately short
 * and *not* the maximum age: this only has to cover one writer's
 * create-to-payload gap, while the maximum age is how long a *readable* offer
 * may suppress the guide. Treating a corrupt leftover as live for the full
 * maximum age is what would make a no-instance profile wait half an hour for a
 * nudge it should get now. Compared against the clock read *after* the re-reads,
 * so the wait itself cannot push a fresh file over the bound.
 */
const WELCOME_MARKER_WRITE_GRACE_MS = 150;

/** What one `createWelcomeMarker` call achieved. */
export type WelcomeMarkerOutcome = 'created' | 'live' | 'unavailable';

/** The absolute token path: the lease directory and the per-window files' own directory. */
export function welcomeMarkerFilePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, WELCOME_MARKER_FILE_NAME);
}

/** The token's payload: who is offering, and since when. */
interface WelcomeMarkerPayload {
  version: number;
  pid: number;
  at: number;
}

/**
 * The payload of a token's file content, or `undefined` when it is not a token
 * this build can act on (empty, torn, foreign, or from an older design of this
 * file).
 */
function parseMarkerPayload(raw: string): WelcomeMarkerPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.pid !== 'number' ||
    !Number.isFinite(record.pid) ||
    typeof record.at !== 'number' ||
    !Number.isFinite(record.at)
  ) {
    return undefined;
  }
  return { version: typeof record.version === 'number' ? record.version : 0, pid: record.pid, at: record.at };
}

/**
 * True while the process exists. `process.kill(pid, 0)` is the probe: it sends
 * no signal, throws `ESRCH` for a dead pid, and throws `EPERM` for a live
 * process owned by another user — which counts as alive, because a token whose
 * owner *might* be showing the guide is not ours to take. The rule is the one
 * the lease and the broker already use for their own files (`leaseStore.ts`'s
 * `isPidAlive`, `mcpWorkspaceState.ts`'s `isPidAlive`), deliberately repeated
 * here rather than imported: it is three lines, and this module must not drag
 * another subsystem's module graph along for it.
 */
function isPidAlive(pid: number): boolean {
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

/**
 * Is the offer token at this path still live, i.e. is another window plausibly
 * showing the guide?
 *
 * A **readable token** is live when its owner process still exists and its `at`
 * is younger than `WELCOME_MARKER_MAX_AGE_MS`; a dead owner or an expired `at`
 * makes it stale, and the caller takes it over.
 *
 * A **token that does not parse** (empty, torn, from an older design of this
 * file) is never a *dead* owner's problem to clean up: the only window that can
 * briefly publish such a file is the winner of the `wx` create, between its
 * create and its payload write, and a second window activating in that
 * microsecond must not read it as "nobody is offering" — that is exactly how two
 * panels appear at once (a test drives both activations concurrently and caught
 * it). So an unparseable token is read a few times before it is judged, and if
 * it still does not parse, its **mtime** is the fallback: touched within the
 * write grace (measured against the clock read after those re-reads) means
 * "someone is writing it right now" (live), anything older is a corrupt leftover
 * (stale, so the caller offers the guide). A missing file — the ordinary
 * fresh-profile answer — is not live.
 */
export async function isWelcomeMarkerLive(
  markerPath: string,
  now: number,
  options: {
    /**
     * Re-reads of an unparseable token, `WELCOME_MARKER_READ_ATTEMPTS` by
     * default. Injectable so a test can judge a corrupt leftover without paying
     * the write grace the re-reads exist to cover.
     */
    readAttempts?: number;
  } = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.readAttempts ?? WELCOME_MARKER_READ_ATTEMPTS);
  let payload: WelcomeMarkerPayload | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await delay(WELCOME_MARKER_READ_RETRY_MS);
    }
    let raw: string;
    try {
      raw = await fs.promises.readFile(markerPath, 'utf8');
    } catch {
      // Missing (the ordinary fresh-profile answer) or unreadable: nothing is
      // offering the guide here.
      return false;
    }
    payload = parseMarkerPayload(raw);
    if (payload) {
      break;
    }
  }
  if (!payload) {
    // Unparseable after every attempt: fall back to how recently the file was
    // touched, so a token whose writer is slow is still treated as an offer —
    // but only for the write grace, never for the full maximum age.
    const stats = await fs.promises.stat(markerPath).catch(() => undefined);
    if (!stats) {
      return false;
    }
    return Date.now() - stats.mtimeMs < WELCOME_MARKER_WRITE_GRACE_MS;
  }
  if (!isPidAlive(payload.pid)) {
    return false;
  }
  return now - payload.at < WELCOME_MARKER_MAX_AGE_MS;
}

/**
 * One `wx` create with the token payload written through the open handle.
 *
 * `EEXIST` (another window got there first) and every other failure are the
 * caller's to interpret: the create is the only step that must be atomic, and
 * the payload is written through the open handle before it is closed, so the
 * file only exists in its final shape (or is removed again by the branch below).
 */
async function createExclusive(markerPath: string, now: number, pid: number): Promise<WelcomeMarkerOutcome> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    await fs.promises.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    handle = await fs.promises.open(markerPath, 'wx', 0o600);
    const payload: WelcomeMarkerPayload = { version: WELCOME_MARKER_VERSION, pid, at: now };
    await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
    await handle.close();
    return 'created';
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle) {
      // The create won but the payload never landed: remove this call's own
      // shell (`wx` guarantees it is ours), so an empty token cannot suppress
      // the guide, and fail open.
      await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
      return 'unavailable';
    }
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST' ? 'live' : 'unavailable';
  }
}

/**
 * Claim the offer token: create it when nothing is offering the guide, keep
 * quiet while another window's live offer stands, take over a token that is no
 * longer live, and show the guide when the mechanism cannot be used at all.
 *
 * - `created` — this window's create won. It shows the guide.
 * - `live` — another window is (plausibly) showing the guide right now. The
 *   caller stays silent; this is the whole point of the token, no double panel
 *   for windows restored together.
 * - `unavailable` — the token could not be created or taken over (a read-only
 *   profile directory, `EACCES`/`EPERM`, a file where the directory should be,
 *   …). The caller shows the guide anyway: no usable token means "unknown",
 *   never "already shown".
 *
 * Taking over means removing a token that was re-checked as dead or expired at
 * that moment, then racing the create again. If another window wins that race,
 * this call answers `live`: exactly one window shows the guide. A window that
 * fails to *remove* the stale token does not open a second panel either — it
 * answers `live`, because a token it cannot remove may well be another
 * window's live one, and the direction this mechanism may never fail in is "two
 * panels for one profile".
 *
 * `pid` and `now` are injectable so the live/stale decisions can be tested
 * without waiting half an hour or spawning a second process.
 */
export async function createWelcomeMarker(
  context: vscode.ExtensionContext,
  options: { pid?: number; now?: number } = {},
): Promise<WelcomeMarkerOutcome> {
  const markerPath = welcomeMarkerFilePath(context);
  const now = options.now ?? Date.now();
  const pid = options.pid ?? process.pid;

  const first = await createExclusive(markerPath, now, pid);
  if (first !== 'live') {
    return first;
  }
  // The name is taken. That is only a reason to stay quiet while the token is
  // live; a dead owner or an expired token is exactly the no-instance case the
  // guide has always come back for.
  if (await isWelcomeMarkerLive(markerPath, now)) {
    return 'live';
  }
  try {
    await fs.promises.rm(markerPath, { force: true });
  } catch {
    return 'live';
  }
  // Re-create rather than report success: two windows can reach this point
  // together, and the second `wx` is what decides, so a stale token is never
  // removed without a create attempt standing behind it.
  return createExclusive(markerPath, now, pid);
}
