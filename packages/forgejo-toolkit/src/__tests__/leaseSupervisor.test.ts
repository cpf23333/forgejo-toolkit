import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LEASE_ACCELERATED_STALE_MS,
  LEASE_CLAIM_REQUEST_MAX_AGE_MS,
  LEASE_CLAIM_TICK_MS,
  LEASE_EXPIRY_MS,
  LEASE_FILE_NAME,
  LEASE_FOCUS_DEBOUNCE_H_MS,
  LEASE_HANDOVER_HYSTERESIS_N_MS,
  LEASE_HEARTBEAT_MS,
  LEASE_OWNER_STEP_DOWN_MS,
  LEASE_UNANSWERED_REQUEST_LIMIT_K,
} from '../lease/leaseConstants';
import { formatLeaseShadowLine, LeaseShadowSupervisor } from '../lease/leaseSupervisor';
import { claimRequestBackoffMs } from '../lease/leaseDecision';
import { instanceSetFingerprint } from '../lease/leaseStore';
import {
  claimRequestFiles,
  leaseFileExists,
  linesWithAction,
  makeShadow,
  makeShadowLogger,
  removeShadow,
  toFileSystem,
  withFaults,
  writeForeignClaimRequest,
  writeForeignLease,
  type MakeShadowOptions,
  type ShadowHarness,
} from './leaseShadowHarness';

/**
 * Stage 1's supervisor, tested without a real window (§10.1.8): the decision
 * input is assembled from real state, the tick and the heartbeat are separate
 * layers, the focus event and the mandatory tick fallback both work, dispose
 * leaves nothing behind, and — the shadow invariant — no decision can suppress
 * anything.
 *
 * Only `setInterval`/`clearInterval` are faked: the tick's reads and writes are
 * real file I/O, and `whenSettled()` is the tick's own completion signal, so no
 * test sleeps.
 */

const NOW = 1_000_000;

let harnesses: ShadowHarness[] = [];

async function shadow(options: MakeShadowOptions = {}): Promise<ShadowHarness> {
  const harness = await makeShadow({ clockStart: NOW, ...options });
  harnesses.push(harness);
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  harnesses = [];
});

afterEach(async () => {
  for (const harness of harnesses) {
    await removeShadow(harness).catch(() => undefined);
  }
  vi.useRealTimers();
});

describe('the decision input is assembled from real state', () => {
  it('claims a free lease for real and becomes the leader', async () => {
    const h = await shadow();
    await h.start();

    const record = await h.readRecord();
    expect(record?.ownerNonce).toBe(h.store.nonce);
    expect(record?.pid).toBe(h.store.processId);
    expect(h.supervisor.role).toBe('leader');
    const claimed = h.infoLines().find((line) => line.includes('outcome=claimed')) ?? '';
    expect(claimed).toContain('reason=follower-takeover-absent');
    expect(claimed).toContain('nonce=a1b2c3d4');
    // The decision line and the outcome line are separate on purpose: the
    // decision is what the pure layer said, the outcome is what the filesystem
    // answered.
    expect(linesWithAction(h.infoLines(), 'claim')[0]).toContain('reason=follower-takeover-absent');
  });

  it('stamps the running extension version into the record, through a store it built itself', async () => {
    // No injected store here on purpose: this is the path `extension.ts` takes —
    // the version the activation site passes has to reach the record that a
    // diagnostics dump reads (§3.2).
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lease-shadow-version-'));
    const logger = makeShadowLogger();
    const supervisor = new LeaseShadowSupervisor({
      directory: dir,
      logger,
      appVersion: '9.9.9',
      now: () => NOW,
      host: { isFocused: () => false, onDidChangeFocus: () => ({ dispose: () => undefined }) },
    });
    try {
      supervisor.start();
      await supervisor.whenSettled();
      const raw = await fs.promises.readFile(path.join(dir, LEASE_FILE_NAME), 'utf8');
      expect((JSON.parse(raw) as { appVersion: string }).appVersion).toBe('9.9.9');
    } finally {
      await supervisor.dispose();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('stamps a fingerprint of the configured instance set and refreshes it on the next heartbeat', async () => {
    let ids: string[] = ['instance-b', 'instance-a'];
    const h = await shadow({ instanceIds: () => ids });
    await h.start();

    const claimed = await h.readRecord();
    // The digest is over the config's own instance ids, sorted, so an order
    // change is not a change (§3.3).
    expect(claimed?.instancesFingerprint).toBe(instanceSetFingerprint(['instance-a', 'instance-b']));
    expect(claimed?.instancesFingerprint).toMatch(/^[0-9a-f]{16}$/);

    ids = ['instance-a'];
    await h.tick(5); // the next heartbeat writes the record again
    expect((await h.readRecord())?.instancesFingerprint).toBe(instanceSetFingerprint(['instance-a']));
  });

  it('takes over a lease whose holder pid is dead, though its heartbeat is fresh', async () => {
    // The pure layer's dead-pid rule (§3.5) is only reachable if the holder
    // liveness probe really reaches the decision input.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(dead.pid).toBeGreaterThan(0);
    const h = await shadow();
    await writeForeignLease(h, { pid: dead.pid as number, heartbeatAt: h.clock.ms });

    await h.start();

    expect((await h.readRecord())?.ownerNonce).toBe(h.store.nonce);
    expect(h.infoLines().join('\n')).toContain('reason=follower-takeover-expired');
    expect(h.infoLines().join('\n')).toContain('holderAlive=0');
  });

  it('takes over a lease whose heartbeat is older than the expiry', async () => {
    const h = await shadow();
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms - LEASE_EXPIRY_MS - 1 });

    await h.start();

    const line = linesWithAction(h.infoLines(), 'claim')[0] ?? '';
    expect(line).toContain('reason=follower-takeover-expired');
    expect(line).toContain('mustReleaseStale=1');
    expect((await h.readRecord())?.ownerNonce).toBe(h.store.nonce);
  });

  it('leaves a live foreign lease alone and follows it', async () => {
    const h = await shadow();
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    const before = await fs.promises.readFile(h.leasePath, 'utf8');

    await h.start();
    await h.tick(3);

    expect(await fs.promises.readFile(h.leasePath, 'utf8')).toBe(before);
    expect(h.supervisor.role).toBe('follower');
    expect(h.supervisor.decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
    expect(h.debugLines().join('\n')).toContain('lease=held');
    expect(h.debugLines().join('\n')).toContain('holderPid=' + process.pid);
  });
});

describe('the focus debounce H (§2.3)', () => {
  it('does not request the lease before H of continuous focus, and does after', async () => {
    const h = await shadow({ focused: true });
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();

    // Six ticks = 12 s < H (12.5 s): a focused window has not "been working
    // here" long enough to ask yet.
    await h.tick(6);
    expect(await claimRequestFiles(h)).toEqual([]);

    await h.tick(1); // +2 s = 14 s focused
    expect(await claimRequestFiles(h)).toHaveLength(1);
    const line = linesWithAction(h.infoLines(), 'request')[0] ?? '';
    expect(line).toContain('reason=focus-debounce-elapsed');
    expect(line).toContain(`hMs=${LEASE_FOCUS_DEBOUNCE_H_MS}`);
    expect(line).toContain('focusedForMs=14000');
    expect(line).toContain('requestNumber=1');
    // Before K, the next request is one tick away: that is what makes the K
    // escalation take "K ticks ≈ 6 s" (§2.3).
    expect(line).toContain(`nextRequestAfterMs=${LEASE_CLAIM_TICK_MS}`);
    expect(line).toContain('wouldAction=claim');
  });

  it('counts its own unanswered requests and escalates at K once the owner is genuinely stale', async () => {
    // A live owner that never answers: the §2.3 K escalation. The first K
    // requests go out one per tick, but K does not act on a healthy record —
    // only on one that has missed about three heartbeats (§4.1), and only once
    // the owner is past N. N is what keeps a just-claimed lease in place.
    const h = await shadow({ focused: true });
    await writeForeignLease(h, {
      pid: process.pid,
      claimedAt: h.clock.ms - LEASE_HANDOVER_HYSTERESIS_N_MS - 1_000,
      heartbeatAt: h.clock.ms,
    });
    await h.start();

    await h.tick(6); // 12 s: no request yet
    await h.tick(1); // 14 s: request 1
    expect(linesWithAction(h.infoLines(), 'request')).toHaveLength(1);
    await h.tick(2); // 18 s: requests 2 and 3, one per tick
    expect(linesWithAction(h.infoLines(), 'request')).toHaveLength(3);
    // …replaced in place each time: one file, not one per attempt (§12.10).
    expect(await claimRequestFiles(h)).toHaveLength(1);

    const third = linesWithAction(h.infoLines(), 'request')[2] ?? '';
    expect(third).toContain('requestNumber=3');
    // After K unanswered requests the cadence backs off, so an owner that is
    // ignoring them cannot be turned into a request storm.
    expect(third).toContain(`nextRequestAfterMs=${claimRequestBackoffMs(LEASE_UNANSWERED_REQUEST_LIMIT_K)}`);

    // K requests in, but the record is only 20 s old — under three heartbeat
    // periods — so this window keeps following the live owner.
    await h.tick(1); // 20 s
    expect(h.allLines().join('\n')).not.toContain('follower-takeover-accelerated');

    // The owner stops heartbeating while keeping its pid (a hung window): now
    // the record is real evidence, and the escalation fires.
    await writeForeignLease(h, {
      pid: process.pid,
      claimedAt: h.clock.ms - LEASE_HANDOVER_HYSTERESIS_N_MS - 1_000,
      heartbeatAt: h.clock.ms - LEASE_ACCELERATED_STALE_MS - 1_000,
    });
    await h.tick(1); // 22 s
    const escalated = h.infoLines().find((line) => line.includes('reason=follower-takeover-accelerated')) ?? '';
    expect(escalated).toContain('reason=follower-takeover-accelerated');
    expect(escalated).toContain('mustReleaseStale=1');
    // The owner never yielded, so the `wx` attempt is contended and this
    // window stays a follower — the log says both.
    expect(h.debugLines().join('\n')).toContain('outcome=contended');
    expect((await h.readRecord())?.ownerNonce).toBe('foreign-nonce');
  });

  it('starts the H clock at the event, not at the next tick', async () => {
    const h = await shadow({ focused: false });
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();

    // Focus arrives 1.4 s after the last tick. The next tick would have started
    // the clock at +2 s; the event's own timestamp is what H is measured from.
    h.clock.ms += 1_400;
    h.focus.fire(true);
    await h.tick(6); // 13.4 s after the event's clock start
    expect(await claimRequestFiles(h)).toEqual([]);

    await h.tick(1); // 15.4 s
    const line = linesWithAction(h.infoLines(), 'request')[0] ?? '';
    expect(line).toContain('focusedForMs=14000');
    expect(h.infoLines().join('\n')).toContain('reason=window-state');
  });

  it('catches a focus change the event never delivered, on the tick', async () => {
    const h = await shadow({ focused: false });
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();

    // §2.3 prerequisite 1: the state changes but no `onDidChangeWindowState`
    // arrives (a platform that drops or delays it). One tick must notice.
    h.focus.setSilently(true);
    await h.tick(1);

    const line = h.infoLines().find((message) => message.includes('action=focus-gained')) ?? '';
    expect(line).toContain('reason=tick-fallback');
    expect(line).toContain('missedEvent=1');
    expect(line).toContain('focusedForMs=0');
  });

  it('logs a focus loss with how long the window had been focused', async () => {
    const h = await shadow({ focused: true });
    await h.start();
    h.clock.ms += 3_000;
    h.focus.fire(false);

    const line = h.infoLines().find((message) => message.includes('action=focus-lost')) ?? '';
    expect(line).toContain('reason=window-state');
    expect(line).toContain('focusedForMs=3000');
  });
});

describe('request-file housekeeping: one file per requester (§3.2, §12.10)', () => {
  /** A pid the OS reports as dead, as a crashed requester leaves behind. */
  const DEAD_PID = 0x7fff_fffe;

  /** A live owner that keeps heartbeating, so the follower keeps being refused. */
  async function keepForeignOwnerFresh(h: ShadowHarness): Promise<void> {
    await writeForeignLease(h, {
      pid: process.pid,
      claimedAt: h.clock.ms - LEASE_HANDOVER_HYSTERESIS_N_MS - 1_000,
      heartbeatAt: h.clock.ms,
    });
  }

  it('keeps exactly one request file while a refused window keeps asking', async () => {
    // The sticky state the focus fix creates: a focused window that is refused
    // over and over. Each publish carries a fresh token, so without retiring the
    // previous file this would be one file per attempt.
    const h = await shadow({ focused: true });
    await h.start();

    for (let round = 0; round < 20; round += 1) {
      await keepForeignOwnerFresh(h);
      await h.tick(1);
      // At most one: none before H elapses, then exactly the current request.
      expect((await claimRequestFiles(h)).length).toBeLessThanOrEqual(1);
    }

    const requests = linesWithAction(h.infoLines(), 'request');
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.at(-1)).toContain('requestNumber=4');
    expect(await claimRequestFiles(h)).toHaveLength(1);
    expect(h.infoLines().join('\n')).not.toContain('reason=retire-failed');
  });

  it('clears an old request a dead window left behind, on the owner path', async () => {
    const h = await shadow();
    await h.start(); // this window owns the lease
    await writeForeignClaimRequest(
      h,
      { pid: DEAD_PID, at: h.clock.ms - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1_000 },
      { token: 'deadbeef' },
    );
    expect(await claimRequestFiles(h)).toHaveLength(1);

    await h.tick(1);

    expect(await claimRequestFiles(h)).toEqual([]);
    const pruned = h.debugLines().find((line) => line.includes('action=prune-requests')) ?? '';
    expect(pruned).toContain('reason=stale-dead-requester');
    expect(pruned).toContain('pruned=1');
  });

  it('leaves another window’s files alone while it is only a follower', async () => {
    const h = await shadow({ focused: false });
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms }); // a live owner
    await h.start();
    await writeForeignClaimRequest(
      h,
      { pid: DEAD_PID, at: h.clock.ms - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1_000 },
      { token: 'deadbeef' },
    );

    await h.tick(3);
    expect(await claimRequestFiles(h)).toHaveLength(1);
    expect(h.debugLines().join('\n')).not.toContain('action=prune-requests');

    // The owner disappears (a crash: its record ages out), this window takes
    // over, and only then does the leftover become its business.
    await h.tick(15); // past the expiry
    expect((await h.readRecord())?.ownerNonce).toBe(h.store.nonce);
    await h.tick(1); // the first owner tick
    expect(await claimRequestFiles(h)).toEqual([]);
  });

  it('does not remove a fresh or a live requester’s file, even when the owner is pruning', async () => {
    const h = await shadow();
    await h.start();
    const freshDead = await writeForeignClaimRequestHelper(h, DEAD_PID, h.clock.ms, 'ffff');
    const oldLive = await writeForeignClaimRequestHelper(
      h,
      process.pid,
      h.clock.ms - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1_000,
      'aaaa',
    );

    await h.tick(2);

    // One fresh (regardless of pid) and one live window's: both survive, so the
    // owner still has two files it must keep reading.
    expect(await claimRequestFiles(h)).toEqual([freshDead, oldLive].sort());
  });

  it('reports a failed retirement once per streak and keeps publishing', async () => {
    const real = toFileSystem();
    const fs = withFaults({
      unlink: async (filePath) => {
        if (filePath.includes('.claim.')) {
          throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
        }
        return real.unlink(filePath);
      },
    });
    const h = await shadow({ focused: true, fs });
    await h.start();

    for (let round = 0; round < 20; round += 1) {
      await keepForeignOwnerFresh(h);
      await h.tick(1);
    }

    // The publish is never blocked by the failed cleanup, but the leak is worth
    // exactly one line per streak rather than one per tick.
    const failures = h.infoLines().filter((line) => line.includes('reason=retire-failed'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('retrying=next-publish');
    expect(linesWithAction(h.infoLines(), 'request').length).toBeGreaterThanOrEqual(3);
  });
});

/** Write a request file and return its base name, for the prune assertions. */
async function writeForeignClaimRequestHelper(
  h: ShadowHarness,
  pid: number,
  at: number,
  token: string,
): Promise<string> {
  const name = `${LEASE_FILE_NAME}.claim.${pid}.${token}`;
  await fs.promises.writeFile(path.join(h.dir, name), JSON.stringify({ version: 1, pid, focused: true, at }));
  return name;
}

describe('focus-following decisions, logged as what they would do (§7.1, §11.1 stage 1)', () => {
  it('logs the yield N suppressed, then performs the yield once N has passed', async () => {
    // This window is not focused (the user moved away) and a focused window is
    // asking: the intended handover, held back by N and then performed.
    const h = await shadow({ focused: false });
    await h.start();
    // A focused requester whose request is newer than our claim.
    await writeForeignClaimRequest(h, { pid: 4242, focused: true, at: h.clock.ms + 10_000 });

    await h.tick(1); // 2 s after the claim: inside N
    const suppressed = h.infoLines().find((line) => line.includes('reason=owner-keep-hysteresis')) ?? '';
    expect(suppressed).toContain('wouldAction=yield');
    expect(suppressed).toContain(`nMs=${LEASE_HANDOVER_HYSTERESIS_N_MS}`);
    expect(suppressed).toContain('pendingRequestPid=4242');
    expect(suppressed).toContain('sinceClaimMs=2000');
    expect(leaseFileExists(h)).toBe(true);

    await h.tick(7); // 16 s: past N, so the yield really happens
    const yielded = h.infoLines().find((line) => line.includes('outcome=released')) ?? '';
    expect(yielded).toContain('action=yield');
    expect(yielded).toContain('reason=owner-yield-focus-request');
    expect(yielded).toContain('yieldToPid=4242');
    expect(yielded).toContain('wasRole=leader');
    expect(leaseFileExists(h)).toBe(false);
  });

  it('never yields to a requester that is not focused', async () => {
    const h = await shadow({ focused: true });
    await h.start();
    await writeForeignClaimRequest(h, { pid: 4242, focused: false, at: h.clock.ms + 10_000 });

    await h.tick(9);

    expect(leaseFileExists(h)).toBe(true);
    expect((await h.readRecord())?.ownerNonce).toBe(h.store.nonce);
    expect(h.infoLines().join('\n')).toContain('reason=owner-keep-requested-unfocused');
    expect(h.infoLines().join('\n')).toContain('wouldAction=keep');
  });

  it('keeps the lease while this window itself is focused: no handover between two focused windows', async () => {
    // The 2026-09-27 soak shape: both windows report focused, each asks the
    // other, and every N + a tick the lease moves. The owner must decline.
    const h = await shadow({ focused: true });
    await h.start();
    await writeForeignClaimRequest(h, { pid: 4242, focused: true, at: h.clock.ms + 10_000 });

    await h.tick(9);

    expect(h.supervisor.role).toBe('leader');
    expect(leaseFileExists(h)).toBe(true);
    expect((await h.readRecord())?.ownerNonce).toBe(h.store.nonce);
    const refusal = h.infoLines().find((line) => line.includes('reason=owner-keep-focused')) ?? '';
    expect(refusal).toContain('wouldAction=keep');
    expect(refusal).toContain('pendingRequestPid=4242');
    expect(h.infoLines().join('\n')).not.toContain('action=yield');
  });

  it('keeps the lease when nobody is looking (§2.3: absence is not a reason to stop)', async () => {
    // Unfocused owner, and the only request on disk is from an unfocused window:
    // there is nobody to hand the job to, so polling continues.
    const h = await shadow({ focused: false });
    await h.start();
    await writeForeignClaimRequest(h, { pid: 4242, focused: false, at: h.clock.ms + 10_000 });

    await h.tick(9);

    expect(leaseFileExists(h)).toBe(true);
    expect(h.infoLines().join('\n')).toContain('reason=owner-keep-requested-unfocused');
  });

  it('keeps the lease when it is unfocused and no request asks for it', async () => {
    const h = await shadow({ focused: false });
    await h.start();

    await h.tick(5);

    expect(leaseFileExists(h)).toBe(true);
    expect(h.supervisor.decision?.reason).toBe('owner-renew');
  });

  it('returns to the follower role when the record stops being ours', async () => {
    const h = await shadow();
    await h.start();
    expect(h.supervisor.role).toBe('leader');

    // Another window replaced the record between two ticks.
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.tick(1);

    expect(h.supervisor.role).toBe('follower');
    const line = h.infoLines().find((message) => message.includes('action=demote')) ?? '';
    expect(line).toContain('reason=owner-changed');
    expect(line).toContain('wasRole=leader');
  });
});

describe('the tick and the heartbeat are different layers (§2.3)', () => {
  it('ticks every 2 s but writes a heartbeat only every 10 s', async () => {
    const h = await shadow();
    await h.start();
    const claimedAt = (await h.readRecord())?.heartbeatAt;
    expect(claimedAt).toBe(NOW);

    await h.tick(4); // +8 s: not due
    expect((await h.readRecord())?.heartbeatAt).toBe(NOW);

    await h.tick(1); // +10 s: due
    expect((await h.readRecord())?.heartbeatAt).toBe(NOW + LEASE_HEARTBEAT_MS);

    await h.tick(4); // +18 s: not due again
    expect((await h.readRecord())?.heartbeatAt).toBe(NOW + LEASE_HEARTBEAT_MS);

    await h.tick(1); // +20 s
    expect((await h.readRecord())?.heartbeatAt).toBe(NOW + 2 * LEASE_HEARTBEAT_MS);
  });

  it('re-issues another claim request on the 2 s tick, never on the 10 s heartbeat', async () => {
    // The requester's tick is what bounds a handover at K ticks: merging the
    // two constants would silently stretch that bound from ~6 s to ~30 s.
    expect(LEASE_CLAIM_TICK_MS).toBe(2_000);
    expect(LEASE_HEARTBEAT_MS).toBe(10_000);
  });
});

describe('heartbeat write failures (§4.1, §8)', () => {
  it('reports the write failure as the reason it steps down, at 2 × expiry', async () => {
    const real = toFileSystem();
    let renames = 0;
    const fs = withFaults({
      rename: async (from, to) => {
        renames += 1;
        if (renames === 1) {
          return real.rename(from, to); // the claim's record write
        }
        throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
      },
    });
    const h = await shadow({ fs });
    await h.start();
    expect((await h.readRecord())?.ownerNonce).toBe(h.store.nonce);

    await h.tick(5); // 10 s: the first heartbeat write fails
    const firstFailure = h.infoLines().find((line) => line.includes('reason=write-failed')) ?? '';
    expect(firstFailure).toContain('failures=1');
    expect(firstFailure).toContain(`stepDownMs=${LEASE_OWNER_STEP_DOWN_MS}`);

    // The retry window is quiet: one info line for the streak, debug after, and
    // — the point of §4.1's numbers — the window keeps its lease.
    await h.tick(29); // 68 s
    expect(linesWithAction(h.infoLines(), 'heartbeat')).toHaveLength(1);
    expect(leaseFileExists(h)).toBe(true);

    // 78 s: still failing, still owning. The threshold is the *streak's* 2 ×
    // expiry, not the record's age, so the write failure cannot step it down
    // before the documented eighth heartbeat.
    await h.tick(5);
    expect(leaseFileExists(h)).toBe(true);
    expect(h.infoLines().filter((line) => line.includes('action=step-down'))).toEqual([]);

    // 80 s of continuous failure is the step-down, and the *reason* is the write
    // failure, not "the record went old": the record is old only because the
    // writes fail, and an operator needs the cause.
    await h.tick(1); // 80 s
    const steppedDown =
      h.infoLines().find((line) => line.includes('action=step-down') && line.includes('outcome=')) ?? '';
    expect(steppedDown).toContain('reason=owner-step-down-unwritable');
    expect(steppedDown).toContain('failures=7');
    expect(steppedDown).toContain('failedForMs=70000');
    // Stepping down gives the lease up (the unlink itself still works)…
    expect(leaseFileExists(h)).toBe(false);
    // …and a full step-down window of failed writes is the mechanism being
    // unusable, so it is reported once and given up for the session (§8). The
    // degradation line lands on the next tick, which is when the latch is read.
    expect(h.supervisor.role).toBe('degraded');
    await h.tick(1);
    const degraded = h.infoLines().filter((line) => line.includes('action=degraded-to-full-speed'));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain('cause=record-write-failed');
  });

  it('still reports the stale record when nothing is failing on the write path', async () => {
    // The generic reason is for a record that aged out with no write failure in
    // progress: a throttled timer, a laptop that slept, a clock jump. Here the
    // process starts owning an ancient record and never attempts a write.
    const h = await shadow();
    await writeForeignLease(h, {
      ownerNonce: h.store.nonce,
      pid: process.pid,
      heartbeatAt: h.clock.ms - LEASE_OWNER_STEP_DOWN_MS,
    });
    await h.start();

    const steppedDown =
      h.infoLines().find((line) => line.includes('action=step-down') && line.includes('outcome=')) ?? '';
    expect(steppedDown).toContain('reason=owner-heartbeat-stale');
    expect(steppedDown).toContain('outcome=released');
    expect(h.infoLines().filter((line) => line.includes('action=degraded-to-full-speed'))).toEqual([]);
    expect(h.store.holdsUnpublishedRecord).toBe(false);
  });

  it('gives the mechanism up when the claim itself is unusable', async () => {
    let exclusiveAttempts = 0;
    const fs = withFaults({
      openExclusive: async () => {
        exclusiveAttempts += 1;
        throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' });
      },
    });
    const h = await shadow({ fs });
    await h.start();

    expect(exclusiveAttempts).toBe(1);
    await h.tick(5);

    // One attempt, one degradation, no repeat and no file.
    expect(exclusiveAttempts).toBe(1);
    const degraded = h.infoLines().filter((line) => line.includes('action=degraded-to-full-speed'));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain('cause=claim-unavailable');
    expect(degraded[0]).toContain('role=degraded');
    expect(h.supervisor.role).toBe('degraded');
    expect(leaseFileExists(h)).toBe(false);
  });
});

describe('a claim whose record never landed (§3.2, §4.2, §8)', () => {
  /**
   * The `wx` create succeeds but the record write fails, so the lease file is an
   * empty shell: `claimed-unpublished` says exactly that. The window stays the
   * owner, republishes on the heartbeat cadence, and never releases and
   * re-creates the file every tick (which is what "treat the empty file as
   * stale" would do).
   */
  function faultingRecordWrites(): { fs: ReturnType<typeof toFileSystem>; fail: () => void; heal: () => void } {
    const real = toFileSystem();
    let failing = true;
    return {
      fs: withFaults({
        rename: async (from, to) => {
          if (failing) {
            throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
          }
          return real.rename(from, to);
        },
      }),
      fail: () => {
        failing = true;
      },
      heal: () => {
        failing = false;
      },
    };
  }

  it('reports the honest outcome, keeps the mutex, and never re-claims the file', async () => {
    let exclusiveAttempts = 0;
    const real = toFileSystem();
    const writes = faultingRecordWrites();
    const fs = withFaults({
      ...writes.fs,
      openExclusive: async (filePath, mode) => {
        exclusiveAttempts += 1;
        return real.openExclusive(filePath, mode);
      },
    });
    const h = await shadow({ fs });
    await h.start();

    // The file exists, but no reader can see a record in it.
    expect(leaseFileExists(h)).toBe(true);
    expect(await h.readRecord()).toBeUndefined();
    expect(h.supervisor.role).toBe('leader');
    const claimed = h.infoLines().find((line) => line.includes('outcome=claimed-unpublished')) ?? '';
    expect(claimed).toContain('reason=follower-takeover-absent');
    expect(h.store.holdsUnpublishedRecord).toBe(true);

    // The next ticks republish at the heartbeat cadence, on the same file.
    await h.tick(4); // 8 s: not due yet
    const republishTick = h.debugLines().join('\n');
    expect(republishTick).toContain('reason=owner-renew-unpublished');
    expect(republishTick).toContain('ownRecordUnpublished=1');
    expect(republishTick).toContain('lease=invalid-malformed');
    await h.tick(1); // 10 s: the first republish attempt
    expect(exclusiveAttempts).toBe(1);
    expect(linesWithAction(h.debugLines(), 'heartbeat').join('\n')).toContain('reason=write-failed');

    // 70 s of a record that still is not publishable: step down, release the
    // shell (only its creator may), and give the mechanism up once.
    await h.tick(34); // 78 s
    const steppedDown =
      h.infoLines().find((line) => line.includes('action=step-down') && line.includes('outcome=')) ?? '';
    expect(steppedDown).toContain('reason=owner-step-down-unwritable');
    expect(steppedDown).toContain('recordPublished=0');
    expect(leaseFileExists(h)).toBe(false);
    await h.tick(1); // the degradation line lands on the tick after the latch
    const degraded = h.infoLines().filter((line) => line.includes('action=degraded-to-full-speed'));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain('cause=record-write-failed');

    // And nothing tries again: the mechanism is given up, not retried forever.
    expect(exclusiveAttempts).toBe(1);
    await h.tick(20);
    expect(exclusiveAttempts).toBe(1);
  });

  it('republishes the record and returns to the normal owner cadence when the write path recovers', async () => {
    const writes = faultingRecordWrites();
    const h = await shadow({ fs: writes.fs });
    await h.start();
    expect(await h.readRecord()).toBeUndefined();

    writes.heal();
    await h.tick(5); // 10 s: the republish lands

    const record = await h.readRecord();
    expect(record?.ownerNonce).toBe(h.store.nonce);
    expect(record?.claimedAt).toBe(NOW); // the claim time, not the repair time
    expect(record?.heartbeatAt).toBe(NOW + LEASE_HEARTBEAT_MS);
    expect(linesWithAction(h.infoLines(), 'heartbeat').join('\n')).toContain('reason=recovered');

    // Back to the ordinary owner path: renew, and refresh on the 10 s cadence.
    await h.tick(1);
    expect(h.debugLines().join('\n')).toContain('reason=owner-renew');
    await h.tick(4); // 20 s
    expect((await h.readRecord())?.heartbeatAt).toBe(NOW + 2 * LEASE_HEARTBEAT_MS);
    expect(linesWithAction(h.allLines(), 'step-down')).toEqual([]);
  });
});

describe('an unusable lease path degrades to full-speed polling (§8)', () => {
  it('reports it once, stops writing, and keeps ticking quietly', async () => {
    const fs = withFaults({
      readFile: async () => {
        throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' });
      },
    });
    const h = await shadow({ fs });
    await h.start();

    const degraded = h.infoLines().filter((line) => line.includes('action=degraded-to-full-speed'));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain('reason=lease-unavailable');
    expect(degraded[0]).toContain('cause=read-unusable');
    expect(h.supervisor.role).toBe('degraded');
    expect(leaseFileExists(h)).toBe(false);

    await h.tick(20);
    expect(h.infoLines().filter((line) => line.includes('action=degraded-to-full-speed'))).toHaveLength(1);
    expect(leaseFileExists(h)).toBe(false);
  });
});

describe('dispose (§5, §11.1 stage 1)', () => {
  it('clears the timer and the focus subscription', async () => {
    const h = await shadow();
    await h.start();
    expect(vi.getTimerCount()).toBe(1);
    expect(h.focus.listenerCount()).toBe(1);

    await h.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(h.focus.listenerCount()).toBe(0);
  });

  it('releases its own lease, logs it, and never touches it again', async () => {
    const h = await shadow();
    await h.start();
    await h.dispose();

    expect(leaseFileExists(h)).toBe(false);
    const release = h.infoLines().find((line) => line.includes('action=release')) ?? '';
    expect(release).toContain('reason=dispose');
    expect(release).toContain('lease=released');

    const linesAfterDispose = h.allLines().length;
    await vi.advanceTimersByTimeAsync(LEASE_CLAIM_TICK_MS * 40);
    await h.supervisor.whenSettled();
    expect(leaseFileExists(h)).toBe(false);
    expect(h.allLines()).toHaveLength(linesAfterDispose);
  });

  it('leaves a lease another window took over completely alone', async () => {
    const h = await shadow();
    await h.start(); // this window is the leader
    const successor = await writeForeignLease(h, { ownerNonce: 'successor', pid: process.pid });

    await h.dispose();

    expect(await h.readRecord()).toEqual(successor);
    expect(leaseFileExists(h)).toBe(true);
    expect(h.infoLines().join('\n')).toContain('lease=not-owner');
  });

  it('stopping as a follower leaves the owner file byte-identical', async () => {
    const h = await shadow();
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();
    const before = await fs.promises.readFile(h.leasePath, 'utf8');

    await h.dispose();

    expect(await fs.promises.readFile(h.leasePath, 'utf8')).toBe(before);
  });

  it('a tick already in flight cannot claim after dispose', async () => {
    const real = toFileSystem();
    let gateReads = 0;
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const fs = withFaults({
      readFile: async (filePath) => {
        gateReads += 1;
        if (gateReads === 1) {
          // The first tick (start's) blocks here: past no checkpoint yet.
          await gate;
        }
        return real.readFile(filePath);
      },
    });
    const h = await shadow({ fs });
    h.supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the read reach the gate

    const disposing = h.supervisor.dispose();
    openGate?.();
    await disposing;

    expect(gateReads).toBeGreaterThan(0);
    expect(leaseFileExists(h)).toBe(false);
    expect(h.allLines().filter((line) => line.includes('outcome=claimed'))).toEqual([]);
  });
});

describe('the shadow invariant: no decision in stage 1 can change polling', () => {
  /**
   * One run per decision outcome the supervisor can reach. Every line every run
   * produces must carry `polling=unchanged`: whatever the election decided, this
   * window polls, because nothing here is wired to the poller. The structural
   * half of the same invariant (no import in either direction) is pinned in
   * `leaseShadowGuards.test.ts`.
   */
  const scenarios: { name: string; run: () => Promise<ShadowHarness>; action: string }[] = [
    {
      name: 'claim (free lease)',
      action: 'claim',
      run: async () => {
        const h = await shadow();
        await h.start();
        return h;
      },
    },
    {
      name: 'inactive (live foreign owner)',
      action: 'inactive',
      run: async () => {
        const h = await shadow();
        await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
        await h.start();
        return h;
      },
    },
    {
      name: 'keep-and-heartbeat (this window owns it)',
      action: 'keep-and-heartbeat',
      run: async () => {
        const h = await shadow();
        await h.start();
        await h.tick(5);
        return h;
      },
    },
    {
      name: 'step-down (our own record went stale)',
      action: 'step-down',
      run: async () => {
        const h = await shadow();
        await writeForeignLease(h, {
          ownerNonce: h.store.nonce,
          pid: process.pid,
          heartbeatAt: h.clock.ms - LEASE_OWNER_STEP_DOWN_MS,
        });
        await h.start();
        return h;
      },
    },
    {
      name: 'yield (a focused requester outside N)',
      action: 'yield',
      run: async () => {
        // Unfocused owner, focused requester past N: the intended handover.
        const h = await shadow({ focused: false });
        await h.start();
        await writeForeignClaimRequest(h, { pid: 4242, focused: true, at: h.clock.ms + 10_000 });
        await h.tick(8);
        return h;
      },
    },
    {
      name: 'degraded-to-full-speed (unusable path)',
      action: 'degraded-to-full-speed',
      run: async () => {
        const h = await shadow({
          fs: withFaults({
            readFile: async () => {
              throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' });
            },
          }),
        });
        await h.start();
        return h;
      },
    },
  ];

  it.each(scenarios)('$name still polls in this window', async (scenario) => {
    const h = await scenario.run();
    const lines = h.allLines();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `${scenario.name}: ${line}`).toContain('polling=unchanged');
    }
    // The scenario really reached the decision it claims to cover.
    expect(lines.some((line) => line.includes(`action=${scenario.action} `))).toBe(true);
  });
});

describe('the log lines (§7.1)', () => {
  it('renders fixed-key lines with the §7.1 fields and polling last', () => {
    expect(
      formatLeaseShadowLine({
        role: 'follower',
        action: 'request',
        reason: 'focus-debounce-elapsed',
        pid: 111,
        noncePrefix: 'a1b2c3d4',
        focused: true,
        focusedForMs: 12_600.4,
        at: NOW,
        extra: { hMs: 12_500, wouldAction: 'claim' },
      }),
    ).toBe(
      `lease-shadow role=follower action=request reason=focus-debounce-elapsed pid=111 nonce=a1b2c3d4 ` +
        `focused=1 focusedForMs=12600 at=${NOW} hMs=12500 wouldAction=claim polling=unchanged`,
    );
  });

  it('carries role, reason, pid and the nonce prefix on every start-up line', async () => {
    const h = await shadow();
    await h.start();

    const start = h.infoLines().find((line) => line.includes('action=start')) ?? '';
    expect(start).toContain('role=follower');
    expect(start).toContain('reason=shadow-mode');
    expect(start).toContain('pid=111');
    expect(start).toContain('nonce=a1b2c3d4');
    // The parameter set in force, so a soak can state what it measured.
    expect(start).toContain(`tickMs=${LEASE_CLAIM_TICK_MS}`);
    expect(start).toContain(`heartbeatMs=${LEASE_HEARTBEAT_MS}`);
    expect(start).toContain(`hMs=${LEASE_FOCUS_DEBOUNCE_H_MS}`);
    expect(start).toContain(`nMs=${LEASE_HANDOVER_HYSTERESIS_N_MS}`);
    expect(start).toContain(`k=${LEASE_UNANSWERED_REQUEST_LIMIT_K}`);
    expect(start).toContain('leasePath=');
  });

  it('gives every line the same §7.1 field set', async () => {
    const h = await shadow({ focused: true });
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();
    await h.tick(9);
    h.focus.fire(false);
    await h.tick(2);

    for (const line of h.allLines()) {
      expect(line).toMatch(
        /^lease-shadow role=(leader|follower|degraded) action=\S+ reason=\S+ pid=\d+ nonce=\S{8} focused=[01] focusedForMs=\d+ at=\d+ /,
      );
    }
  });

  it('keeps the steady state quiet: one transition line, then nothing until it changes', async () => {
    const h = await shadow();
    await h.start();
    await h.tick(1); // the tick that moves the decision from `claim` to `keep-and-heartbeat`
    expect(h.debugLines().join('\n')).toContain('action=keep-and-heartbeat');

    const settled = h.allLines().length;
    await h.tick(3); // same role, same decision, same focus: nothing to say

    expect(h.allLines()).toHaveLength(settled);
  });

  it('keeps N inside the maximum age of a request, or a yield could never follow the hysteresis', () => {
    // The suppression line (owner-keep-hysteresis) only turns into a real yield
    // if the request is still pending once N has passed.
    expect(LEASE_HANDOVER_HYSTERESIS_N_MS).toBeLessThanOrEqual(LEASE_CLAIM_REQUEST_MAX_AGE_MS);
  });
});
