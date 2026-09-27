import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decideLeaseAction } from '../lease/leaseDecision';
import { LEASE_FILE_NAME, LEASE_RECORD_VERSION } from '../lease/leaseConstants';
import { makeClaimRequestObservation, makeLease, makeStore, makeTempDir, removeTempDir } from './leaseTestHelpers';

/**
 * Reverse guards for the decisions that are decisions, not preferences.
 *
 * §10.1.12 asks for these to be pinned by tests rather than left to reviewer
 * attention: (a) the lease manager must not read the editor's state store, and
 * (b) there is no "I am the only window, so I can skip the protocol" branch.
 *
 * The source assertion is a substring check over the lease module's own files,
 * which is deliberately blunt: it fails on a *mention*, and that is the point —
 * the code path must not exist, so the only way to make this test pass is to
 * not write one.
 */

const LEASE_SOURCE_DIR = path.join(__dirname, '..', 'lease');
const LEASE_SOURCES = ['leaseConstants.ts', 'leaseDecision.ts', 'leaseStore.ts', 'leaseTypes.ts'];

async function readLeaseSources(): Promise<{ file: string; text: string }[]> {
  return Promise.all(
    LEASE_SOURCES.map(async (file) => ({
      file,
      text: await fs.promises.readFile(path.join(LEASE_SOURCE_DIR, file), 'utf8'),
    })),
  );
}

describe('the lease module never reaches for globalState (§2 decision 1, §12.2, §10.3)', () => {
  it('does not mention globalState or an extension context at all', async () => {
    const sources = await readLeaseSources();
    for (const { file, text } of sources) {
      // The blank line the mentions live in the *design document*, not here:
      // the module may not name the rejected mechanism even in a comment, so
      // that no reader — or later edit — can mistake it for a supported path.
      expect(text, `${file} must not mention globalState`).not.toMatch(/globalState/i);
      expect(text, `${file} must not mention Memento`).not.toMatch(/Memento/);
      expect(text, `${file} must not mention workspaceState`).not.toMatch(/workspaceState/);
      expect(text, `${file} must not take a vscode.ExtensionContext`).not.toMatch(/ExtensionContext/);
      expect(text, `${file} must not import vscode`).not.toMatch(/from 'vscode'/);
    }
  });

  it('imports nothing at all outside its own directory and node builtins', async () => {
    const sources = await readLeaseSources();
    const allowed = new Set(['crypto', 'fs', 'path']);
    for (const { file, text } of sources) {
      const specifiers = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        if (specifier.startsWith('./')) {
          continue;
        }
        expect(allowed.has(specifier), `${file} imports an unexpected module: ${specifier}`).toBe(true);
      }
    }
  });

  it('does not import the mcp modules whose pid rule it duplicates', async () => {
    // §3.5: the rules are borrowed, the lifecycle is not. Importing mcpBroker
    // would drag the broker's timer and listen path into this module graph.
    const sources = await readLeaseSources();
    for (const { file, text } of sources) {
      expect(text, `${file} must not import from mcp/**`).not.toMatch(/from '\.\.\/mcp/);
      expect(text, `${file} must not import from src/mcp*`).not.toMatch(/from '\.\.\/mcp[A-Za-z]*'/);
    }
  });

  it('keeps the decision layer free of runtime dependencies', async () => {
    // The pure layer must not grow an fs import, a clock read or a timer: it is
    // the thing that makes the branch table testable without a filesystem.
    const text = await fs.promises.readFile(path.join(LEASE_SOURCE_DIR, 'leaseDecision.ts'), 'utf8');
    const code = text.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/from 'fs'/);
    expect(code).not.toMatch(/from 'crypto'/);
    expect(code).not.toMatch(/Date\.now\(\)|new Date\(/);
    expect(code).not.toMatch(/setTimeout|setInterval/);
  });
});

describe('there is no single-window shortcut and no "am I alone" inference (§2 decision 4, §12.4)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('lease-guard-');
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('does not mention a window count, a solo mode or a "first window wins" branch', async () => {
    const sources = await readLeaseSources();
    for (const { file, text } of sources) {
      expect(text, `${file} must not count windows`).not.toMatch(/windowCount|window_count|countWindows|otherWindows/i);
      expect(text, `${file} must not have a single-window mode`).not.toMatch(
        /singleWindow|soloMode|onlyWindow|isAlone/i,
      );
      // §12.4 also removed "claim immediately when more than one window is
      // plausible"; `firstWindow`/`skipLease` would be that branch returning.
      expect(text, `${file} must not have a skip-the-protocol branch`).not.toMatch(/skipLease|firstWindowWins/i);
    }
  });

  it('behaves identically whether or not other windows have left traces in the directory', async () => {
    // The decision input has no window count at all; this test states the
    // consequence: traces of other windows change nothing.
    const record = makeLease({ ownerNonce: 'other', heartbeatAt: 5_000 });
    const traces = [
      makeClaimRequestObservation({ pid: 1 }),
      makeClaimRequestObservation({ pid: 2 }),
      makeClaimRequestObservation({ pid: 3 }),
    ];
    const withoutTraces = decideLeaseAction({
      now: 5_000,
      own: { ownerNonce: 'self', pid: 111, focused: true },
      lease: { leasePathReadable: true, lease: { kind: 'ok', record }, claimRequests: [] },
      holderPidAlive: true,
      ownerHealth: { consecutiveFailures: 0 },
      ownClaimRequest: { consecutiveUnansweredRequests: 0 },
    });
    const withTraces = decideLeaseAction({
      now: 5_000,
      own: { ownerNonce: 'self', pid: 111, focused: true },
      lease: { leasePathReadable: true, lease: { kind: 'ok', record }, claimRequests: traces },
      holderPidAlive: true,
      ownerHealth: { consecutiveFailures: 0 },
      ownClaimRequest: { consecutiveUnansweredRequests: 0 },
    });
    expect(withTraces).toEqual(withoutTraces);
  });

  it("takes the same claim path on an empty directory as it does next to another window's request", async () => {
    // A window alone on the machine works exactly like the first of several:
    // the `wx` attempt is the protocol, and there is no faster path for "I
    // think I am alone".
    const lonely = makeStore(dir, { ownerNonce: 'lonely' });
    expect(await lonely.claim(1_000)).toBe('claimed');

    const busyDir = await makeTempDir('lease-guard-busy-');
    try {
      const requester = makeStore(busyDir, { ownerNonce: 'requester' });
      await requester.writeClaimRequest(1_000, { focused: true });
      const contested = makeStore(busyDir, { ownerNonce: 'contested' });
      expect(await contested.claim(1_000)).toBe('claimed');
    } finally {
      await removeTempDir(busyDir);
    }
  });
});

describe('the lease record stays free of credentials (§3.2, §11.1 stage 2)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('lease-guard-record-');
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('writes exactly the documented field set and nothing credential-shaped', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    const raw = await fs.promises.readFile(path.join(dir, LEASE_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'appVersion',
        'claimedAt',
        'heartbeatAt',
        'instancesFingerprint',
        'ownerNonce',
        'pid',
        'releaseReason',
        'version',
      ].sort(),
    );
    expect(parsed.version).toBe(LEASE_RECORD_VERSION);
    expect(raw).not.toMatch(/token|authorization|secret|password/i);
  });
});
