import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decideLeaseAction } from '../lease/leaseDecision';
import {
  LEASE_CLAIM_REQUEST_MAX_AGE_MS,
  LEASE_EXPIRY_MS,
  LEASE_FILE_NAME,
  LEASE_HEARTBEAT_MS,
  LEASE_HEARTBEAT_WRITE_ATTEMPTS,
  LEASE_OWNER_STEP_DOWN_MS,
  LEASE_RECORD_VERSION,
  LEASE_STALE_PART_MAX_AGE_MS,
} from '../lease/leaseConstants';
import {
  LeaseStore,
  instanceSetFingerprint,
  isPidAlive,
  isTransientWriteError,
  toFileSystem,
  validateLeaseRecord,
} from '../lease/leaseStore';
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
    expect(store.holdsUnpublishedRecord).toBe(false);

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
        ownRecordUnpublished: false,
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
      lease: {
        leasePathReadable: observation.read.kind !== 'invalid',
        lease: observation.read,
        claimRequests: [],
        ownRecordUnpublished: false,
      },
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

describe('claim: the file existing is not the same as the lease being published (§3.2, §4.2)', () => {
  /** A store whose record writes fail on demand, so the two states can be told apart. */
  function storeWithFailingRecordWrites(): { store: LeaseStore; heal: () => void } {
    const real = toFileSystem();
    let failing = true;
    const store = new LeaseStore({
      directory: dir,
      ownerNonce: 'nonce-a',
      delay: async () => undefined,
      fs: {
        ...real,
        rename: async (from, to) => {
          if (failing) {
            throw fsError('EPERM');
          }
          return real.rename(from, to);
        },
      },
    });
    return {
      store,
      heal: () => {
        failing = false;
      },
    };
  }

  it('reports claimed-unpublished when the record write fails, and keeps the mutex', async () => {
    const { store } = storeWithFailingRecordWrites();
    expect(await store.claim(1_000)).toBe('claimed-unpublished');
    expect(store.holdsUnpublishedRecord).toBe(true);

    // The file exists — the `wx` create is what excludes other windows — but no
    // reader can find a record in it.
    expect((await store.read()).read.kind).toBe('invalid');
    expect(await store.claim(1_000)).toBe('contended');

    const other = makeStore(dir, { ownerNonce: 'nonce-b' });
    expect(await other.claim(1_000)).toBe('contended');
    // A window that did not create it must not try to repair it either.
    expect(await other.heartbeat(1_000)).toBe('not-owner');
  });

  it('republishes its own unpublished record on the next heartbeat, keeping claimedAt', async () => {
    const { store, heal } = storeWithFailingRecordWrites();
    await store.claim(1_000);
    heal();

    expect(await store.heartbeat(2_000)).toBe('written');
    expect(store.holdsUnpublishedRecord).toBe(false);
    const observation = await store.read();
    expect(observation.read.kind).toBe('ok');
    if (observation.read.kind !== 'ok') {
      return;
    }
    // The repair publishes the original claim time, not the repair time.
    expect(observation.read.record.claimedAt).toBe(1_000);
    expect(observation.read.record.heartbeatAt).toBe(2_000);
    expect(observation.read.record.ownerNonce).toBe('nonce-a');
  });

  it('keeps reporting the failure while the record still cannot be published', async () => {
    const { store } = storeWithFailingRecordWrites();
    await store.claim(1_000);
    expect(await store.heartbeat(2_000)).toBe('failed');
    expect(store.holdsUnpublishedRecord).toBe(true);
    // Still ours to repair, and still unreadable for everyone else.
    expect(await store.heartbeat(3_000)).toBe('failed');
    expect((await store.read()).read.kind).toBe('invalid');
  });

  it('releases the empty shell it created, but never a malformed file it did not', async () => {
    const { store } = storeWithFailingRecordWrites();
    await store.claim(1_000);
    expect(await store.yieldOwn()).toBe('released');
    expect(store.holdsUnpublishedRecord).toBe(false);
    expect((await store.read()).read.kind).toBe('missing');

    // A malformed file this window never created is not ours to delete (§2.3).
    await fs.promises.writeFile(leasePath(), 'not json at all');
    const stranger = makeStore(dir, { ownerNonce: 'nonce-c' });
    expect(await stranger.yieldOwn()).toBe('not-owner');
    expect((await stranger.read()).read.kind).toBe('invalid');
  });

  it('reports a contended claim, not a held one, when the file disappears under the record write', async () => {
    // The `wx` create succeeded, then someone released the file while the record
    // was being written: there is nothing left to hold, and calling it ours
    // would let two windows believe they own the same path.
    const real = toFileSystem();
    const store = new LeaseStore({
      directory: dir,
      ownerNonce: 'nonce-a',
      delay: async () => undefined,
      fs: {
        ...real,
        rename: async (from, to) => {
          await fs.promises.rm(to, { force: true });
          throw fsError('EPERM');
        },
      },
    });
    expect(await store.claim(1_000)).toBe('contended');
    expect(store.holdsUnpublishedRecord).toBe(false);
    expect(await store.yieldOwn()).toBe('missing');
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
      lease: {
        leasePathReadable: true,
        lease: (await store.read()).read,
        claimRequests: [],
        ownRecordUnpublished: false,
      },
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
      lease: {
        leasePathReadable: true,
        lease: (await store.read()).read,
        claimRequests: [],
        ownRecordUnpublished: false,
      },
      holderPidAlive: true,
      ownerHealth: { consecutiveFailures: 7, failureSince },
      ownClaimRequest: { consecutiveUnansweredRequests: 0 },
    });
    expect(before.action).toBe('keep-and-heartbeat');

    const atThreshold = decideLeaseAction({
      now: failureSince + LEASE_OWNER_STEP_DOWN_MS,
      own: { ownerNonce: 'nonce-a', pid: process.pid, focused: true },
      lease: {
        leasePathReadable: true,
        lease: (await store.read()).read,
        claimRequests: [],
        ownRecordUnpublished: false,
      },
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
    const published = await store.writeClaimRequest(5_000, { focused: true });
    // Nothing to retire on the first publish: the requester had no request yet.
    expect(published.retiredPrevious).toBe('missing');
    expect(published.request.pid).toBe(process.pid);
    expect(published.request.focused).toBe(true);
    expect(published.request.at).toBe(5_000);

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

  it('replaces its own request in place, so a refused window keeps one file (§3.2, §12.10)', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    const first = await store.writeClaimRequest(1_000, { focused: true });
    expect(first.retiredPrevious).toBe('missing'); // nothing to retire yet
    const firstToken = store.lastClaimRequestToken;
    expect(firstToken).toBeDefined();
    // Another window's request, and a legacy token-less one, must survive.
    await fs.promises.writeFile(
      store.claimRequestPath(4242),
      JSON.stringify({ version: 1, pid: 4242, focused: true, at: 1_000 }),
    );

    const second = await store.writeClaimRequest(2_000, { focused: true });

    expect(second.retiredPrevious).toBe('cleared');
    const names = (await fs.promises.readdir(dir)).sort();
    expect(names).toHaveLength(2);
    expect(names.filter((name) => name.startsWith(`${LEASE_FILE_NAME}.claim.${process.pid}.`))).toHaveLength(1);
    expect(names).toContain(`${LEASE_FILE_NAME}.claim.4242`);
    await expect(fs.promises.stat(store.claimRequestPath(process.pid, firstToken))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('leaves a request file it cannot prove it wrote, and publishes anyway', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    // An unparseable file at the token-less name: ownership cannot be proven.
    await fs.promises.writeFile(store.claimRequestPath(), 'not json');

    const published = await store.writeClaimRequest(1_000, { focused: true });

    expect(published.retiredPrevious).toBe('not-owner');
    // Both files are there: the stranger's is left alone, ours is published.
    expect(await fs.promises.readdir(dir)).toHaveLength(2);
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

describe('pruning a dead requester’s leftovers (§2.3, §12.10)', () => {
  /** A request file whose pid is verifiably dead, as a crash would leave it. */
  const DEAD_PID = 0x7fff_fffe;

  async function writeRequest(store: LeaseStore, pid: number, at: number, token: string): Promise<string> {
    const name = `${LEASE_FILE_NAME}.claim.${pid}.${token}`;
    await fs.promises.writeFile(path.join(dir, name), JSON.stringify({ version: 1, pid, focused: true, at }));
    return name;
  }

  it('removes an old, dead requester and keeps fresh or live ones', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    const oldDead = await writeRequest(store, DEAD_PID, 1_000 - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1, 'aaaa');
    const freshDead = await writeRequest(store, DEAD_PID, 1_000, 'bbbb');
    const oldLive = await writeRequest(store, process.pid, 1_000 - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1, 'cccc');

    const observed = await store.readClaimRequests();
    const removed = await store.pruneStaleClaimRequests(1_000, observed);

    expect(removed).toEqual([oldDead]);
    // The age filter alone is not enough (a live window may be republishing),
    // and a fresh file is never removed whatever its pid.
    await expect(fs.promises.stat(path.join(dir, oldLive))).resolves.toBeDefined();
    await expect(fs.promises.stat(path.join(dir, freshDead))).resolves.toBeDefined();
    await expect(fs.promises.stat(path.join(dir, oldDead))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never removes the pending request it is acting on', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    // Old and dead, but still the one this tick is deciding about.
    const pending = await writeRequest(store, DEAD_PID, 1_000 - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1, 'dddd');
    const observed = await store.readClaimRequests();

    expect(await store.pruneStaleClaimRequests(1_000, observed, pending)).toEqual([]);
    await expect(fs.promises.stat(path.join(dir, pending))).resolves.toBeDefined();
  });

  it('does not touch the lease file, and reports nothing when there is nothing to prune', async () => {
    const store = makeStore(dir, { ownerNonce: 'nonce-a' });
    await store.claim(1_000);
    expect(await store.pruneStaleClaimRequests(1_000, await store.readClaimRequests())).toEqual([]);
    expect((await store.read()).read.kind).toBe('ok');

    // A malformed request never reaches the pruner (the reader drops it), so a
    // crashed window's unparseable leftover stays rather than being deleted blind.
    await fs.promises.writeFile(path.join(dir, `${LEASE_FILE_NAME}.claim.${DEAD_PID}.eeee`), 'not json');
    expect(await store.readClaimRequests()).toEqual([]);
    expect(await store.pruneStaleClaimRequests(1_000, await store.readClaimRequests())).toEqual([]);
    await expect(fs.promises.stat(path.join(dir, `${LEASE_FILE_NAME}.claim.${DEAD_PID}.eeee`))).resolves.toBeDefined();
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

  it('digests the instance set without carrying anything but the ids (§3.2, §3.3)', () => {
    // The same set in any order is the same fingerprint: reordering instances is
    // not a change in what this window polls.
    expect(instanceSetFingerprint(['b', 'a'])).toBe(instanceSetFingerprint(['a', 'b']));
    expect(instanceSetFingerprint(['a'])).not.toBe(instanceSetFingerprint(['a', 'b']));
    expect(instanceSetFingerprint([])).toMatch(/^[0-9a-f]{16}$/);
    expect(instanceSetFingerprint(['host-login'])).toMatch(/^[0-9a-f]{16}$/);
    // A duplicate is a set member twice, so it must digest differently from one
    // occurrence — the value describes the configured list, not a de-duplicated
    // wish.
    expect(instanceSetFingerprint(['a', 'a'])).not.toBe(instanceSetFingerprint(['a']));
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
