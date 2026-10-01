import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { maybeShowWelcomeOnboarding, markWelcomeOnboardingShown } from '../welcome';
import {
  createWelcomeMarker,
  isWelcomeMarkerLive,
  welcomeMarkerFilePath,
  WELCOME_MARKER_FILE_NAME,
  WELCOME_MARKER_MAX_AGE_MS,
} from '../welcomeMarker';
import { fsError } from './leaseTestHelpers';
import { tempDirRemovalOptions } from './tempDir';

const WELCOME_SHOWN_KEY = 'forgejoToolkit.hasShownWelcome';

/**
 * The first-run guide's cross-window offer token (multi-window lease design §9).
 *
 * One temp directory stands for one profile's globalStorage, so the tests can
 * put two "windows" (two contexts with separate in-memory state stores) behind
 * one real filesystem — the only way to exercise the arbitration, because
 * `fs.open(path, 'wx')` being genuinely atomic is the premise.
 *
 * The two halves of the contract are pinned separately and must not be confused:
 * the token deduplicates *concurrent* offers, while the legacy flag is what
 * makes the guide permanent once the user is past the first-run step. A token is
 * never allowed to turn the guide into a once-forever panel (the regression the
 * "keep offering" behaviour exists to prevent).
 */

let storageDir: string;

beforeEach(async () => {
  storageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'welcome-marker-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A case that pins the wall clock must not leak it into the rest of the file.
  vi.useRealTimers();
  // Best-effort keeps its meaning ("a leftover directory must not fail the
  // suite"), and the retries wait out a handle the case left closing.
  await fs.promises.rm(storageDir, tempDirRemovalOptions).catch(() => undefined);
});

function createContext(directory: string = storageDir) {
  const store = new Map<string, unknown>();
  const context = {
    globalState: {
      get: vi.fn((key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue)),
      update: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    },
    globalStorageUri: { fsPath: directory },
  } as unknown as vscode.ExtensionContext;
  return { context, store };
}

const markerPath = (): string => path.join(storageDir, WELCOME_MARKER_FILE_NAME);

async function storageEntries(): Promise<string[]> {
  return (await fs.promises.readdir(storageDir)).sort();
}

/** A pid that cannot be alive: above every platform's maximum. */
const DEAD_PID = 2_147_483_647;

/** Writes a token as a window would have left it. */
async function writeMarker(payload: Record<string, unknown>, dir: string = storageDir): Promise<void> {
  await fs.promises.writeFile(path.join(dir, WELCOME_MARKER_FILE_NAME), `${JSON.stringify(payload)}\n`, 'utf8');
}

describe('maybeShowWelcomeOnboarding', () => {
  it('shows onboarding on an activation without instances and keeps offering it', async () => {
    const { context, store } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    expect(shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    // Showing is not completing: the permanent flag must stay unset, because a
    // user who skipped the guide with nothing configured has no other way back
    // to it (the behaviour the guide has always had).
    expect(store.get(WELCOME_SHOWN_KEY)).toBeUndefined();
  });

  it('offers the guide again on the next activation once the offering window is gone', async () => {
    const { context } = createContext();
    const firstShow = vi.fn();
    // The window that showed the guide is gone by the next activation, which is
    // what a reloaded window or a closed one looks like from the filesystem.
    await writeMarker({ version: 1, pid: DEAD_PID, at: Date.now() });

    const shown = await maybeShowWelcomeOnboarding(context, false, firstShow);

    expect(shown).toBe(true);
    expect(firstShow).toHaveBeenCalledTimes(1);
    // The dead token is replaced by this window's own offer.
    const token = JSON.parse(await fs.promises.readFile(markerPath(), 'utf8')) as { pid: number };
    expect(token.pid).toBe(process.pid);
  });

  it('offers the guide again when the offer token has expired, even with a live owner', async () => {
    const { context } = createContext();
    await writeMarker({ version: 1, pid: process.pid, at: Date.now() - WELCOME_MARKER_MAX_AGE_MS - 1 });
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    // The pid rule only covers windows restored together; the age bound is the
    // second way out, so a token whose owner never closes its window cannot
    // suppress the guide indefinitely.
    expect(shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('does not show onboarding when instances already exist, and records the flag', async () => {
    const { context, store } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, true, show);

    expect(shown).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(store.get(WELCOME_SHOWN_KEY)).toBe(true);
    // An activation that is past the first-run step offers nothing, so it
    // publishes no token either.
    expect(await storageEntries()).toEqual([]);
  });

  it('never shows again once the guide was completed', async () => {
    const { context } = createContext();
    await markWelcomeOnboardingShown(context);
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    expect(shown).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it('does not show later when the first activation already had instances', async () => {
    const { context } = createContext();
    const laterShow = vi.fn();

    await maybeShowWelcomeOnboarding(context, true, vi.fn());
    // The user removes every instance afterwards: still no auto-open, because
    // the user did configure an instance at least once.
    const shown = await maybeShowWelcomeOnboarding(context, false, laterShow);

    expect(shown).toBe(false);
    expect(laterShow).not.toHaveBeenCalled();
  });

  it('still shows onboarding when recording the flag fails', async () => {
    const { context } = createContext();
    vi.mocked(context.globalState.update).mockRejectedValue(new Error('storage gone'));
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, true, show);

    // A failing recording write must not reject the activation promise (nor
    // suppress a later offer): `hasInstances` is the point where the flag is
    // written, and the write failure is logged only.
    expect(shown).toBe(false);
    expect(show).not.toHaveBeenCalled();

    const earlier = createContext();
    vi.mocked(earlier.context.globalState.update).mockRejectedValue(new Error('storage gone'));
    const laterShow = vi.fn();
    expect(await maybeShowWelcomeOnboarding(earlier.context, false, laterShow)).toBe(true);
    expect(laterShow).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a failing flag write when the guide is completed', async () => {
    const { context } = createContext();
    vi.mocked(context.globalState.update).mockRejectedValue(new Error('storage gone'));

    await expect(markWelcomeOnboardingShown(context)).resolves.toBeUndefined();
  });
});

describe('the guide is offered once among windows activating together (§9)', () => {
  it('lets the window that creates the token open the guide and write nothing else', async () => {
    const { context } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    expect(shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    // The whole profile directory after a fresh first run: the token and nothing
    // else. In particular no `.part` temporary, no lease file, no state file and
    // no per-window file — the offer is one `wx`-created file.
    expect(await storageEntries()).toEqual([WELCOME_MARKER_FILE_NAME]);
    // The creation mode, where the platform reports POSIX bits at all (on
    // Windows they are mostly a no-op; the ACL of the profile directory is the
    // real boundary, §3.1).
    const stats = await fs.promises.stat(markerPath());
    if (process.platform !== 'win32') {
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it('stays silent in a window that finds a live offer token', async () => {
    const first = createContext();
    const firstShow = vi.fn();
    await maybeShowWelcomeOnboarding(first.context, false, firstShow);

    // A second window of the same profile, activating while the first window is
    // still showing the guide: its own (empty) state store, the same
    // globalStorage directory. This is the double-panel case that is fixed.
    const second = createContext();
    const secondShow = vi.fn();
    const shown = await maybeShowWelcomeOnboarding(second.context, false, secondShow);

    expect(firstShow).toHaveBeenCalledTimes(1);
    expect(shown).toBe(false);
    expect(secondShow).not.toHaveBeenCalled();
    expect(await storageEntries()).toEqual([WELCOME_MARKER_FILE_NAME]);
    // Silent means silent: this window is not the one offering the guide, so it
    // writes no record of its own either.
    expect(second.store.get(WELCOME_SHOWN_KEY)).toBeUndefined();
  });

  it('opens the guide in exactly one of two windows racing for the token', async () => {
    // The two activations are driven against the same directory; whichever
    // creates the token shows the guide, and the other must not.
    const a = createContext();
    const b = createContext();
    const showA = vi.fn();
    const showB = vi.fn();

    const results = await Promise.all([
      maybeShowWelcomeOnboarding(a.context, false, showA),
      maybeShowWelcomeOnboarding(b.context, false, showB),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(showA.mock.calls.length + showB.mock.calls.length).toBe(1);
  });
});

describe('the offer token itself', () => {
  it('records the offering window pid and time, and reads back as live', async () => {
    const { context } = createContext();
    const now = 1_767_225_600_000;

    expect(await createWelcomeMarker(context, { now })).toBe('created');

    const token = JSON.parse(await fs.promises.readFile(markerPath(), 'utf8')) as {
      version: number;
      pid: number;
      at: number;
    };
    expect(token).toEqual({ version: 1, pid: process.pid, at: now });
    expect(await isWelcomeMarkerLive(markerPath(), now + WELCOME_MARKER_MAX_AGE_MS - 1)).toBe(true);
    expect(await isWelcomeMarkerLive(markerPath(), now + WELCOME_MARKER_MAX_AGE_MS)).toBe(false);
  });

  it('reports a live offer for a fresh token of a live pid and takes over everything else', async () => {
    const { context } = createContext();
    const now = Date.now();

    // Fresh + live owner (a second window of the running editor).
    await writeMarker({ version: 1, pid: process.pid, at: now });
    expect(await createWelcomeMarker(context, { now })).toBe('live');

    // Dead owner: no window can be showing anything, so the offer is taken over.
    await writeMarker({ version: 1, pid: DEAD_PID, at: now });
    expect(await isWelcomeMarkerLive(markerPath(), now)).toBe(false);
    expect(await createWelcomeMarker(context, { now })).toBe('created');

    // Expired token with a live owner: the age bound takes over.
    await writeMarker({ version: 1, pid: process.pid, at: now - WELCOME_MARKER_MAX_AGE_MS });
    expect(await createWelcomeMarker(context, { now })).toBe('created');
  });

  it('treats an unreadable or foreign token as no offer at all', async () => {
    const { context } = createContext();
    const now = Date.now();
    // Aged on disk, so the judgement does not wait out the write grace: a
    // leftover that is not being written right now is stale by definition.
    const stale = new Date(now - 10_000);
    const writeStaleToken = async (content: string): Promise<void> => {
      await fs.promises.writeFile(markerPath(), content, 'utf8');
      await fs.promises.utimes(markerPath(), stale, stale);
    };

    // The permanent marker of the earlier design of this feature (existence
    // only, no payload) is not evidence of an in-flight offer.
    await writeStaleToken('');
    expect(await isWelcomeMarkerLive(markerPath(), now, { readAttempts: 1 })).toBe(false);
    expect(await createWelcomeMarker(context, { now })).toBe('created');

    await writeStaleToken('not json');
    expect(await isWelcomeMarkerLive(markerPath(), now, { readAttempts: 1 })).toBe(false);
    expect(await createWelcomeMarker(context, { now })).toBe('created');

    // A token-shaped file with no usable owner is stale too.
    await writeStaleToken('{"version":1,"pid":0,"at":1}');
    expect(await isWelcomeMarkerLive(markerPath(), now, { readAttempts: 1 })).toBe(false);
    expect(await createWelcomeMarker(context, { now })).toBe('created');
  });

  it('treats a token that is still being written as an offer in flight', async () => {
    const { context } = createContext();
    // The mtime fallback compares the file's modification time against the wall
    // clock *the judgement itself reads*, so pinning the modification times is
    // only enough if the clock they are compared with is pinned as well: how
    // long the write below and the re-reads inside `isWelcomeMarkerLive` take
    // under a starved threadpool is exactly what used to decide this case (the
    // failing round took the single-read branch, with no re-read delay at all,
    // over the bound). Only `Date` is faked — the re-read delay stays a real
    // 20 ms wait — and this is the test's clock, not the production one.
    const now = Date.now();
    vi.useFakeTimers({ now, toFake: ['Date'] });

    // The winner's `wx` create just happened and its payload has not landed yet.
    // The re-reads are what cover that gap, so a second window must answer "live"
    // here rather than starting a takeover race — with a single read the same
    // file is judged by its mtime instead, which is what a *corrupt* leftover
    // looks like once the file is old.
    await fs.promises.writeFile(markerPath(), '', 'utf8');
    // Touched 100 ms before the judgement: inside the 150 ms write grace by
    // construction, whatever the write cost.
    const inFlight = new Date(now - 100);
    fs.utimesSync(markerPath(), inFlight, inFlight);
    expect(await isWelcomeMarkerLive(markerPath(), now)).toBe(true);
    expect(await isWelcomeMarkerLive(markerPath(), now, { readAttempts: 1 })).toBe(true);

    // The same empty file left untouched for ten seconds is a corrupt leftover
    // instead: the fallback may not keep a no-instance profile quiet for the
    // full maximum age.
    const stale = new Date(now - 10_000);
    fs.utimesSync(markerPath(), stale, stale);
    expect(await isWelcomeMarkerLive(markerPath(), now, { readAttempts: 1 })).toBe(false);
    expect(await createWelcomeMarker(context, { now })).toBe('created');
  });

  it('has no token at all on a fresh profile, and creates the directory it needs', async () => {
    const { context } = createContext(path.join(storageDir, 'nested', 'globalStorage'));
    const nested = path.join(storageDir, 'nested', 'globalStorage', WELCOME_MARKER_FILE_NAME);

    expect(await isWelcomeMarkerLive(nested, Date.now())).toBe(false);
    expect(await createWelcomeMarker(context)).toBe('created');
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('fails open when the token cannot be created (EACCES)', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags: string, mode?: number) => {
      if (file === markerPath()) {
        throw fsError('EACCES');
      }
      return realOpen(file, flags, mode);
    }) as unknown as typeof fs.promises.open);
    const { context, store } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    // Fail open: an unwritable token must never suppress the first-run guide.
    expect(shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(store.get(WELCOME_SHOWN_KEY)).toBeUndefined();
    expect(await storageEntries()).toEqual([]);
  });

  it('fails open when the storage directory cannot be created (EPERM)', async () => {
    // A file where the globalStorage directory should be: `mkdir` fails, and
    // with it the create. No mocking, so this is the real error path.
    const blocked = path.join(storageDir, 'blocked');
    await fs.promises.writeFile(blocked, '');
    const { context } = createContext(path.join(blocked, 'globalStorage'));
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    expect(shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('removes its own empty token when the payload write fails, so the next window still gets the guide', async () => {
    vi.spyOn(fs.promises, 'open').mockImplementation((async () => {
      // A handle that exists but cannot publish: the create won (that is what
      // excludes the other windows), the payload did not.
      return {
        writeFile: async () => {
          throw fsError('ENOSPC');
        },
        close: async () => undefined,
      };
    }) as unknown as typeof fs.promises.open);
    const { context } = createContext();

    const outcome = await createWelcomeMarker(context);

    expect(outcome).toBe('unavailable');
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  it('does not open a second panel when the stale token cannot be removed', async () => {
    // A stale token plus a failing removal: the token may be another window's
    // live one, and two panels for one profile is the direction this mechanism
    // must never fail in — so the caller is told "live" rather than "go ahead".
    await writeMarker({ version: 1, pid: DEAD_PID, at: Date.now() });
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(fsError('EPERM'));
    const { context } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    expect(shown).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it('places the token beside the per-window state files in globalStorage', () => {
    const { context } = createContext();
    expect(welcomeMarkerFilePath(context)).toBe(markerPath());
    // Not pid/nonce-keyed, unlike `mcp-workspace-<pid>-<nonce>.json`: the whole
    // point is that every window of the profile looks at the same name.
    expect(path.dirname(welcomeMarkerFilePath(context))).toBe(storageDir);
  });
});
