import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decideLeaseAction } from '../lease/leaseDecision';
import {
  LEASE_EXPIRY_MS,
  LEASE_FILE_NAME,
  LEASE_HEARTBEAT_MS,
  LEASE_HEARTBEAT_WRITE_ATTEMPTS,
  LEASE_OWNER_STEP_DOWN_MS,
  LEASE_RECORD_VERSION,
  LEASE_STALE_PART_MAX_AGE_MS,
} from '../lease/leaseConstants';
import { LeaseStore, isPidAlive, isTransientWriteError, toFileSystem, validateLeaseRecord } from '../lease/leaseStore';
import { fsError, makeLease, makeStore, makeTempDir, removeTempDir } from './leaseTestHelpers';

/**
 * The IO layer (§10.1.2, §10.1.3, §10.1.5, §10.1.7). These tests use a real
 * filesystem in a real temp directory: `fs.open(path, 'wx')` being genuinely
 * atomic is the entire premise of the design (§4.3), so mocking it away would
 * test the mock.
 */

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('lease-store-test-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDir(dir);
});

const leasePath = (): string => path.join(dir, LEASE_FILE_NAME);

describe('claim', () => {
  it('creates the lease record and reports the claim', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a', windowId: 'window-a' });
    expect(await store.claim(1_000)).toBe('claimed');

    const observation = await store.read();
    expect(observation.read.kind).toBe('ok');
    if (observation.read.kind !== 'ok') {
      return;
    }
    const record = observation.read.record;
    expect(record.version).toBe(LEASE_RECORD_VERSION);
    expect(record.ownerNonce).toBe('nonce-a');
    expect(record.pid).toBe(process.pid);
    expect(record.claimedAt).toBe(1_000);
    expect(record.heartbeatAt).toBe(1_000);
    expect(record.windowId).toBe('window-a');
    expect(record.releaseReason).toBeNull();
    expect(record.instancesFingerprint).toBe('fp');
  });

  it('refuses to claim a lease held by a live pid, without touching the file', async () => {
    const holder = makeStore(dir, { ownerNonce: 'holder-nonce' });
    expect(await holder.claim(1_000)).toBe('claimed');

    const other = makeStore(dir, { ownerNonce: 'other-nonce', pid: process.pid });
    expect(await other.claim(2_000)).toBe('contended');
    // The stale-release path must not fire for a live holder either.
    expect(await other.releaseStale(2_000)).toBe('not-owner');

    const observation = await other.read();
    expect(observation.read.kind === 'ok' && observation.read.record.ownerNonce).toBe('holder-nonce');
  });

  it('leaves the lease alone when releaseStale runs against a live, fresh holder', async () => {
    const holder = makeStore(dir, { ownerNonce: 'holder-nonce' });
    await holder.claim(1_000);

    const other = makeStore(dir, { ownerNonce: 'other-nonce' });
    expect(await other.releaseStale(1_000)).toBe('not-owner');
    expect((await other.read()).read.kind).toBe('ok');
  });

  it('releases an expired lease and then claims it', async () => {
    const holder = makeStore(dir, { ownerNonce: 'holder-nonce' });
    await holder.claim(1_000);

    const other = makeStore(dir, { ownerNonce: 'other-nonce' });
    const now = 1_000 + LEASE_EXPIRY_MS;
    expect(await other.releaseStale(now)).toBe('released');
    expect(await other.claim(now)).toBe('claimed');
    const observation = await other.read();
    expect(observation.read.kind === 'ok' && observation.read.record.ownerNonce).toBe('other-nonce');
  });

  it('releases a lease whose holder pid is dead, without waiting for the expiry', async () => {
    // A crash leaves the file behind with a pid the OS reports as dead (§5).
    const deadPid = 0x7fff_fffe;
    expect(isPidAlive(deadPid)).toBe(false);
    await fs.promises.writeFile(leasePath(), JSON.stringify(makeLease({ ownerNonce: 'crashed', pid: deadPid })));

    const store = makeStore(dir, { ownerNonce: 'survivor' });
    const decision = decideLeaseAction({
      now: 1_000,
      own: { ownerNonce: 'survivor', pid: process.pid, focused: true },
      lease: {
        leasePathReadable: true,
        lease: (await store.read()).read,
        claimRequests: [],
      },
      holderPidAlive: false,
      ownerHealth: { consecutiveFailures: 0 },
      ownClaimRequest: { consecutiveUnansweredRequests: 0 },
    });
    expect(decision.action).toBe('claim');
    expect(await store.releaseStale(1_000)).toBe('released');
    expect(await store.claim(1_000)).toBe('claimed');
    const observation = await store.read();
    expect(observation.read.kind === 'ok' && observation.read.record.ownerNonce).toBe('survivor');
  });

  it('treats a malformed record as stale and replaces it', async () => {
    await fs.promises.writeFile(leasePath(), 'not json at all');
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    const observation = await store.read();
    expect(observation.read.kind === 'invalid' && observation.read.reason).toBe('malformed');
    expect(await store.releaseStale(1_000)).toBe('released');
    expect(await store.claim(1_000)).toBe('claimed');
    expect((await store.read()).read.kind).toBe('ok');
  });

  it('treats a record with an unusable field as stale', async () => {
    await fs.promises.writeFile(leasePath(), JSON.stringify({ version: 1, ownerNonce: 'x', pid: 'not-a-pid' }));
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    expect((await store.read()).read.kind).toBe('invalid');
  });

  it('reports an unusable directory instead of failing (the §8 degraded branch)', async () => {
    // Simulated rather than produced with a real permission bit: the failure
    // being classified is "the lease path cannot be read at all", and on
    // Windows the OS answers such a path with ENOENT as often as EACCES, so a
    // real directory would test the platform, not the classification.
    const store = new LeaseStore({
      directory: dir,
      ownerNonce: 'nonce-a',
      delay: async () => undefined,
      fs: { ...toFileSystem(), readFile: async () => Promise.reject(fsError('EACCES')) },
    });
    const observation = await store.read();
    expect(observation.read.kind === 'invalid' && observation.read.reason).toBe('unreadable');

    // The decision layer's consequence: full-speed polling, never silence.
    const decision = decideLeaseAction({
      now: 1_000,
      own: { ownerNonce: 'nonce-a', pid: process.pid, focused: true },
      lease: { leasePathReadable: observation.read.kind !== 'invalid', lease: observation.read, claimRequests: [] },
      holderPidAlive: undefined,
      ownerHealth: { consecutiveFailures: 0 },
      ownClaimRequest: { consecutiveUnansweredRequests: 0 },
    });
    expect(decision).toEqual({ action: 'degraded-to-full-speed', reason: 'lease-unavailable' });
  });

  it('reports an unusable path when the directory is a file', async () => {
    // A file where the parent directory would be: on Windows the read below it
    // answers ENOENT, on POSIX ENOTDIR. Either way the claim cannot work, and
    // the store must say so rather than claim a phantom lease.
    const blocked = path.join(dir, 'not-a-directory');
    await fs.promises.writeFile(blocked, '');
    const store = makeStore(path.join(blocked, 'child'));
    expect(await store.claim(1_000)).toBe('unavailable');
    expect((await store.read()).read.kind).not.toBe('ok');
    expect((await store.probeWritable(1_000)).writable).toBe(false);
  });

  it('reports EACCES from the exclusive create as unavailable, not as contention', async () => {
    vi.spyOn(fs.promises, 'open').mockImplementation((async () => {
      throw fsError('EACCES');
    }) as unknown as typeof fs.promises.open);
    const store = new LeaseStore({ directory: dir, ownerNonce: 'nonce-a', delay: async () => undefined });
    // A permission problem must not be mistaken for another window holding the
    // lease: `contended` would make this window a silent follower, which is the
    // direction §8 forbids.
    expect(await store.claim(1_000)).toBe('unavailable');
  });
});

describe('claim: the `.part` sibling (§4.2.5)', () => {
  it('does not let a stale `.part` block a claim', async () => {
    const partPath = path.join(dir, `${LEASE_FILE_NAME}.part`);
    await fs.promises.writeFile(partPath, '{"half":"a write that crashed"}');
    const old = new Date(Date.now() - LEASE_STALE_PART_MAX_AGE_MS - 60_000);
    await fs.promises.utimes(partPath, old, old);

    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    expect(await store.claim(Date.now())).toBe('claimed');
    expect((await store.read()).read.kind).toBe('ok');
    // The stale sibling was cleared, not left to shadow the new record.
    await expect(fs.promises.stat(partPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not delete a fresh `.part`, which may be another window mid-write', async () => {
    const partPath = path.join(dir, `${LEASE_FILE_NAME}.part`);
    await fs.promises.writeFile(partPath, 'other window in flight');
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    expect(await store.clearStalePart(Date.now())).toBe(false);
    await expect(fs.promises.stat(partPath)).resolves.toBeDefined();
  });
});

describe('two windows racing on one directory (§10.1.2, §10.1.3)', () => {
  it('lets exactly one win, and keeps the loser waiting', async () => {
    const storeA = makeStore(dir, { ownerNonce: 'nonce-a' });
    const storeB = makeStore(dir, { ownerNonce: 'nonce-b' });

    const [outcomeA, outcomeB] = await Promise.all([storeA.claim(1_000), storeB.claim(1_000)]);
    expect([outcomeA, outcomeB].filter((outcome) => outcome === 'claimed')).toHaveLength(1);
    expect([outcomeA, outcomeB].filter((outcome) => outcome === 'contended')).toHaveLength(1);

    const winnerIsA = outcomeA === 'claimed';
    const winner = winnerIsA ? storeA : storeB;
    const loser = winnerIsA ? storeB : storeA;

    const held = await storeA.read();
    expect(held.read.kind === 'ok' && held.read.record.ownerNonce).toBe(winner.nonce);

    // The loser does not steal it while the winner holds it — and, just as
    // importantly, does not delete it: `claim` never unlinks on EEXIST
    // (§4.2.3).
    expect(await loser.claim(1_001)).toBe('contended');
    expect(await loser.releaseStale(1_001)).toBe('not-owner');
    const stillHeld = await storeA.read();
    expect(stillHeld.read.kind === 'ok' && stillHeld.read.record.ownerNonce).toBe(winner.nonce);

    // …and does take it the moment the winner hands it back (a close, §5).
    expect(await winner.yieldOwn()).toBe('released');
    expect(await loser.claim(1_002)).toBe('claimed');
    const afterHandover = await loser.read();
    expect(afterHandover.read.kind === 'ok' && afterHandover.read.record.ownerNonce).toBe(loser.nonce);
  });

  it('repeats that race 50 times without a double winner', async () => {
    // A single pass proves little about an atomic primitive; the repetition is
    // what catches the occasional interleaving.
    for (let round = 0; round < 50; round += 1) {
      const roundDir = await makeTempDir('lease-race-');
      try {
        const stores = [
          makeStore(roundDir, { ownerNonce: `nonce-${round}-a` }),
          makeStore(roundDir, { ownerNonce: `nonce-${round}-b` }),
          makeStore(roundDir, { ownerNonce: `nonce-${round}-c` }),
        ];
        const outcomes = await Promise.all(stores.map((store) => store.claim(1_000)));
        expect(outcomes.filter((outcome) => outcome === 'claimed')).toHaveLength(1);
        // The winner's record is intact, so the losers read a live holder.
        const winner = stores[outcomes.indexOf('claimed')] as LeaseStore;
        const record = await winner.read();
        expect(record.read.kind === 'ok' && record.read.record.ownerNonce).toBe(winner.nonce);
      } finally {
        await removeTempDir(roundDir);
      }
    }
  });
});

describe('heartbeat', () => {
  it('refreshes heartbeatAt while the lease is ours, keeping claimedAt', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    expect(await store.heartbeat(2_000)).toBe('written');

    const observation = await store.read();
    expect(observation.read.kind).toBe('ok');
    if (observation.read.kind !== 'ok') {
      return;
    }
    expect(observation.read.record.heartbeatAt).toBe(2_000);
    expect(observation.read.record.claimedAt).toBe(1_000);
  });

  it("reports not-owner instead of refreshing somebody else's record (§4.1.2)", async () => {
    const holder = makeStore(dir, { ownerNonce: 'holder-nonce' });
    await holder.claim(1_000);

    const other = makeStore(dir, { ownerNonce: 'other-nonce' });
    expect(await other.heartbeat(2_000)).toBe('not-owner');
    const observation = await other.read();
    expect(observation.read.kind === 'ok' && observation.read.record.heartbeatAt).toBe(1_000);
  });

  it('reports a missing lease rather than recreating it', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    expect(await store.heartbeat(2_000)).toBe('missing');
    await expect(fs.promises.stat(leasePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries a Windows EPERM rename and counts the heartbeat as written (§4.1, §10.1.7)', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);

    const rename = vi.spyOn(fs.promises, 'rename');
    rename.mockRejectedValueOnce(fsError('EPERM'));
    rename.mockRejectedValueOnce(fsError('EPERM'));

    expect(await store.heartbeat(2_000)).toBe('written');
    // Two failures plus the success: three attempts, no step-down contemplated.
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('gives up with "failed" only after the full attempt budget', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);

    const rename = vi.spyOn(fs.promises, 'rename');
    rename.mockRejectedValue(fsError('EPERM'));

    expect(await store.heartbeat(2_000)).toBe('failed');
    expect(rename).toHaveBeenCalledTimes(LEASE_HEARTBEAT_WRITE_ATTEMPTS);
    // The old heartbeat is intact: the failure was reported, not half-applied.
    const observation = await store.read();
    expect(observation.read.kind === 'ok' && observation.read.record.heartbeatAt).toBe(1_000);
  });

  it('does not retry an error that means the mechanism is unusable', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);

    const rename = vi.spyOn(fs.promises, 'rename');
    rename.mockRejectedValue(fsError('EROFS'));

    expect(await store.heartbeat(2_000)).toBe('unavailable');
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('classifies the transient error codes it retries', () => {
    expect(isTransientWriteError(fsError('EPERM'))).toBe(true);
    expect(isTransientWriteError(fsError('EBUSY'))).toBe(true);
    expect(isTransientWriteError(fsError('EROFS'))).toBe(false);
    expect(isTransientWriteError(undefined)).toBe(false);
  });
});

describe('the step-down threshold is 2 x expiry, not one failure and not one expiry (§4.1)', () => {
  it('does not step down after a single failed heartbeat', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    const rename = vi.spyOn(fs.promises, 'rename');
    rename.mockRejectedValue(fsError('EPERM'));
    expect(await store.heartbeat(2_000)).toBe('failed');

    // The window keeps owning: the failure is recorded, not acted on.
    const decision = decideLeaseAction({
      now: 2_000,
      own: { ownerNonce: 'nonce-a', pid: process.pid, focused: true },
      lease: { leasePathReadable: true, lease: (await store.read()).read, claimRequests: [] },
      holderPidAlive: true,
      ownerHealth: { consecutiveFailures: 1, failureSince: 2_000 },
      ownClaimRequest: { consecutiveUnansweredRequests: 0 },
    });
    expect(decision.action).toBe('keep-and-heartbeat');
  });

  it('does not step down before 2 x expiry, and does at the threshold', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    const failureSince = 1_000;

    const before = decideLeaseAction({
      now: failureSince + LEASE_OWNER_STEP_DOWN_MS - 1,
      own: { ownerNonce: 'nonce-a', pid: process.pid, focused: true },
      lease: { leasePathReadable: true, lease: (await store.read()).read, claimRequests: [] },
      holderPidAlive: true,
      ownerHealth: { consecutiveFailures: 7, failureSince },
      ownClaimRequest: { consecutiveUnansweredRequests: 0 },
    });
    expect(before.action).toBe('keep-and-heartbeat');

    const atThreshold = decideLeaseAction({
      now: failureSince + LEASE_OWNER_STEP_DOWN_MS,
      own: { ownerNonce: 'nonce-a', pid: process.pid, focused: true },
      lease: { leasePathReadable: true, lease: (await store.read()).read, claimRequests: [] },
      holderPidAlive: true,
      ownerHealth: { consecutiveFailures: 8, failureSince },
      ownClaimRequest: { consecutiveUnansweredRequests: 0 },
    });
    expect(atThreshold).toEqual({ action: 'step-down', reason: 'owner-step-down-unwritable' });
  });

  it('keeps the owner polling for at least seven heartbeats of failures', () => {
    // 70 s at a 10 s heartbeat: the eighth heartbeat is the first one that can
    // step down (§4.1).
    expect(LEASE_OWNER_STEP_DOWN_MS / LEASE_HEARTBEAT_MS).toBe(7);
  });
});

describe('yield and cleanup', () => {
  it('refuses to unlink a lease that is no longer ours (§2.3 step 3, §10.1.8)', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    // A successor took over (a forced handover, or a clock jump).
    await fs.promises.writeFile(
      leasePath(),
      JSON.stringify(makeLease({ ownerNonce: 'successor-nonce', pid: process.pid })),
    );

    expect(await store.yieldOwn()).toBe('not-owner');
    const observation = await store.read();
    expect(observation.read.kind === 'ok' && observation.read.record.ownerNonce).toBe('successor-nonce');
  });

  it('unlinks its own lease on yield', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    expect(await store.yieldOwn()).toBe('released');
    await expect(fs.promises.stat(leasePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is safe to call when no lease exists', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    expect(await store.yieldOwn()).toBe('missing');
    expect(await store.cleanup()).toEqual({ lease: 'missing', claimRequest: 'missing' });
    expect(await store.releaseStale(1_000)).toBe('missing');
  });
});

describe('claim requests', () => {
  it("writes, reads back and clears this window's own request", async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a', windowId: 'window-a' });
    const request = await store.writeClaimRequest(5_000, { focused: true });
    expect(request.pid).toBe(process.pid);
    expect(request.focused).toBe(true);
    expect(request.at).toBe(5_000);

    const observations = await store.readClaimRequests();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.request.pid).toBe(process.pid);
    // The token lives in the file name, so the owner can tell two requests by
    // one recycled pid apart.
    expect(observations[0]?.fileName).toBe(`mcp-leader-lease.json.claim.${process.pid}.${store.lastClaimRequestToken}`);

    expect(await store.clearClaimRequest()).toBe('cleared');
    expect(await store.readClaimRequests()).toHaveLength(0);
  });

  it('refuses to delete a request file it cannot prove it wrote', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    // No token registered, and the content belongs to another pid.
    const foreignPath = store.claimRequestPath(4242);
    await fs.promises.writeFile(foreignPath, JSON.stringify({ version: 1, pid: 4242, focused: true, at: 1 }));

    const other = makeStore(dir, { ownerNonce: 'nonce-b' });
    expect(await other.clearClaimRequest()).toBe('missing');
    // The unparseable file at *our* path is left alone rather than deleted.
    const ownPath = store.claimRequestPath();
    await fs.promises.writeFile(ownPath, 'not json');
    expect(await store.clearClaimRequest()).toBe('not-owner');
    await expect(fs.promises.stat(ownPath)).resolves.toBeDefined();
  });

  it('ignores malformed request files when listing them', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await fs.promises.writeFile(store.claimRequestPath(999), 'not json');
    expect(await store.readClaimRequests()).toHaveLength(0);
  });

  it('never touches the lease file when only a request is written (§2.3 step 1)', async () => {
    const holder = makeStore(dir, { ownerNonce: 'holder-nonce' });
    await holder.claim(1_000);
    const before = await fs.promises.readFile(leasePath(), 'utf8');

    const requester = makeStore(dir, { ownerNonce: 'requester-nonce' });
    await requester.writeClaimRequest(2_000, { focused: true });

    expect(await fs.promises.readFile(leasePath(), 'utf8')).toBe(before);
    const observations = await holder.readClaimRequests();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.request.at).toBe(2_000);
    expect(observations[0]?.token.length).toBeGreaterThan(0);
  });

  it('cleans up its own request on deactivate', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    await store.writeClaimRequest(2_000, { focused: true });
    expect(await store.cleanup()).toEqual({ lease: 'released', claimRequest: 'cleared' });
    expect(await store.readClaimRequests()).toHaveLength(0);
    expect((await store.read()).read.kind).toBe('missing');
  });
});

describe('validation and probing', () => {
  it('accepts a complete record and rejects an incomplete one', () => {
    expect(validateLeaseRecord(makeLease())).toBeDefined();
    expect(validateLeaseRecord({ ...makeLease(), version: 2 })).toBeUndefined();
    expect(validateLeaseRecord({ ...makeLease(), heartbeatAt: 'soon' })).toBeUndefined();
    expect(validateLeaseRecord({ ...makeLease(), ownerNonce: '' })).toBeUndefined();
    expect(validateLeaseRecord(null)).toBeUndefined();
    expect(validateLeaseRecord([])).toBeUndefined();
  });

  it('probes writability without leaving a file behind', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    const probe = await store.probeWritable(1_000);
    expect(probe.writable).toBe(true);
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('reports its whole view for the later diagnostics stage (§11.1 stage 2)', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    await makeStore(dir, { ownerNonce: 'nonce-b' }).writeClaimRequest(1_500, { focused: true });

    const inspection = await store.inspect();
    expect(inspection.leasePath).toBe(leasePath());
    expect(inspection.exists).toBe(true);
    expect(inspection.ownerIsSelf).toBe(true);
    expect(inspection.holderAlive).toBe(true);
    expect(inspection.writable).toBe(true);
    expect(inspection.claimRequests).toHaveLength(1);
  });
});

describe('the pid-liveness rule matches the established one (§3.5)', () => {
  it('counts this process as alive and a very high pid as dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0x7fff_fffe)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it('counts EPERM as alive', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw fsError('EPERM');
    });
    try {
      expect(isPidAlive(4242)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it('counts ESRCH as dead', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw fsError('ESRCH');
    });
    try {
      expect(isPidAlive(4242)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });
});
