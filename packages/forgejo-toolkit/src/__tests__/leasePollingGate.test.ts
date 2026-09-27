import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import {
  LEASE_ACCELERATED_STALE_MS,
  LEASE_CLAIM_TICK_MS,
  LEASE_EXPIRY_MS,
  LEASE_FOCUS_DEBOUNCE_H_MS,
  LEASE_HANDOVER_HYSTERESIS_N_MS,
  LEASE_UNANSWERED_REQUEST_LIMIT_K,
} from '../lease/leaseConstants';
import { demotionReason, takeoverReason } from '../lease/leaseSupervisor';
import {
  leaseFileExists,
  makeLeaseHarness,
  removeLeaseHarness,
  toFileSystem,
  withFaults,
  writeForeignClaimRequest,
  writeForeignLease,
  type LeaseHarness,
} from './leaseSupervisorHarness';

/**
 * The polling gate (§8, §11.1 stage 2), from the supervisor's side.
 *
 * The poller's side — what it does with the answer — is
 * `leasePollingEnforcement.test.ts`. What is pinned here is the *rule*: the
 * setting being off, a degraded mechanism and every uncertainty leave the gate
 * open, and the one state that closes it is a confirmed healthy follower. The
 * takeover case is the one that has to publish a transition, because that is
 * what makes a window that becomes the owner poll immediately.
 */

const NOW = 1_000_000;

/** A pid the OS has already reaped, so the dead-holder path is deterministic. */
const DEAD_PID = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid as number;

let harnesses: LeaseHarness[] = [];

async function lease(options: Parameters<typeof makeLeaseHarness>[0] = {}): Promise<LeaseHarness> {
  const harness = await makeLeaseHarness({ clockStart: NOW, ...options });
  harnesses.push(harness);
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  harnesses = [];
});

afterEach(async () => {
  for (const harness of harnesses) {
    await removeLeaseHarness(harness).catch(() => undefined);
  }
  vi.useRealTimers();
});

describe('the setting owns the whole mechanism (§2 decision 6, §2.1)', () => {
  it('does not take part in the election at all when it is off, and still polls', async () => {
    const h = await lease({ leaseEnabled: false });
    await h.start();

    // No timer, no focus subscription beyond the settings watcher, no file:
    // a window with the setting off must not hold a lease against the windows
    // that kept it on.
    expect(vi.getTimerCount()).toBe(0);
    expect(h.focus.listenerCount()).toBe(0);
    expect(leaseFileExists(h)).toBe(false);
    expect(h.supervisor.mayPoll()).toBe(true);
    expect(h.infoLines()).toEqual([]);
  });

  it('starts the election live when the setting is turned on, with no reload', async () => {
    const h = await lease({ leaseEnabled: false });
    await h.start();
    expect(leaseFileExists(h)).toBe(false);

    h.settings.set(true);
    await h.supervisor.whenSettled();

    expect(leaseFileExists(h)).toBe(true);
    expect((await h.readRecord())?.ownerNonce).toBe(h.store.nonce);
    expect(h.supervisor.mayPoll()).toBe(true);
    expect(h.infoLines().join('\n')).toContain('reason=lease-mode');
  });

  it('gives the lease up live when the setting is turned off, and opens the gate', async () => {
    const h = await lease();
    await h.start();
    expect((await h.readRecord())?.ownerNonce).toBe(h.store.nonce);

    h.settings.set(false);
    await h.supervisor.whenSettled();

    // Released, stopped, and polling on its own — the §2.1 promise stated as
    // three assertions.
    expect(leaseFileExists(h)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.supervisor.mayPoll()).toBe(true);
    const stop = h.infoLines().find((line) => line.includes('action=stop')) ?? '';
    expect(stop).toContain('reason=setting-off');
    expect(stop).toContain('wasRole=leader');
    expect(stop).toContain('lease=released');
    expect(h.supervisor.lastHandover?.direction).toBe('step-down');
    expect(h.supervisor.lastHandover?.reason).toBe('close');
  });
});

describe('the recorded handover tells the truth on every path (§11.1 stage 2)', () => {
  it('maps the closed reason vocabulary from the decision, not from what is left on disk', () => {
    // The two sides of one handover ask different questions, so the two
    // mappings are separate — and both are total, so no future decision path
    // can inherit a label that describes a different event.
    expect(takeoverReason('follower-takeover-absent')).toBe('close');
    expect(takeoverReason('follower-takeover-expired')).toBe('expiry');
    expect(takeoverReason('follower-takeover-accelerated')).toBe('expiry');
    expect(takeoverReason('owner-keep-focused')).toBe('force');

    expect(demotionReason('owner-changed')).toBe('expiry');
    expect(demotionReason('lease-missing')).toBe('close');
  });

  it('never invents a latency for the K escalation, which the shipped timings cannot reach', async () => {
    // Finding, recorded here because it is a reportable product fact rather
    // than a test convenience: the accelerated takeover cannot fire at the
    // shipped constants. Its whole purpose is to act inside the staleness
    // window `[3 x heartbeat, expiry)` — 5 s wide — but the first claim request
    // a focused follower may send is H = 12.5 s after it becomes focused, and K
    // = 3 requests at a 2 s cadence need 6 s beyond that. The record therefore
    // expires first, which is what this test walks through: no request is ever
    // published, and the takeover is the plain expiry path.
    //
    // The two assertions are the numbers (a retune that makes the escalation
    // reachable has to come with a test that exercises it) and the behaviour
    // (whatever happens, no handover reports a fabricated `0`).
    const accelerationWindowMs = LEASE_EXPIRY_MS - LEASE_ACCELERATED_STALE_MS;
    const firstRequestDelayMs = LEASE_FOCUS_DEBOUNCE_H_MS;
    const timeToKRequestsMs = LEASE_UNANSWERED_REQUEST_LIMIT_K * LEASE_CLAIM_TICK_MS;
    expect(accelerationWindowMs).toBeLessThan(firstRequestDelayMs + timeToKRequestsMs);

    const h = await lease({ focused: true, clockStart: NOW });
    await writeForeignLease(h, { pid: process.pid, claimedAt: 0, heartbeatAt: h.clock.ms - 23_000 });
    await h.start();

    let ticks = 0;
    while (h.supervisor.role !== 'leader' && ticks < 12) {
      await h.tick(1);
      ticks += 1;
    }

    expect(h.supervisor.role).toBe('leader');
    const handover = h.supervisor.lastHandover;
    // The plain expiry path, taken because the record expired before the first
    // request could even be published. Its latency is a real duration measured
    // from an on-disk timestamp, never a `0` standing in for "unknown".
    expect(handover?.reason).toBe('expiry');
    expect(handover?.requestCount).toBe(0);
    expect(handover?.latencyUnknown).toBeNull();
    expect(handover?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records the crash path’s takeover with a measured latency, not a zero placeholder', async () => {
    // The case the acceptance run measured (kill → survivor owns the lease):
    // the holder is a dead pid and its record still has time left in the expiry
    // window. The survivor takes it on its next tick, and the reported latency
    // is the arithmetic that says so — "as soon as the window allowed" — which a
    // bare `0` could not be told apart from.
    const h = await lease();
    await writeForeignLease(h, { pid: DEAD_PID, heartbeatAt: h.clock.ms });
    await h.start();

    expect(h.supervisor.role).toBe('leader');
    const handover = h.supervisor.lastHandover;
    expect(handover?.direction).toBe('takeover');
    expect(handover?.reason).toBe('expiry');
    expect(handover?.counterpartPid).toBe(DEAD_PID);
    expect(handover?.latencyUnknown).toBeNull();
    // The record became expirable at heartbeatAt + LEASE_EXPIRY_MS, which is
    // still in the future here, so the takeover happened at the earliest moment
    // the window allowed: a measured 0.
    expect(handover?.latencyMs).toBe(0);
  });

  it('reports an unmeasurable latency as unknown, never as zero, when it only saw the file gone', async () => {
    const h = await lease();
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();

    await fs.promises.rm(h.leasePath, { force: true });
    await h.tick(1);

    expect(h.supervisor.lastHandover?.reason).toBe('close');
    expect(h.supervisor.lastHandover?.latencyMs).toBeNull();
    expect(h.supervisor.lastHandover?.latencyUnknown).toBe('predecessor-release-time-unobservable');
  });

  it('records the republish path’s step-down with the accurate reason and a real latency from the decision', async () => {
    // The one demote-shaped path that is reachable today: the owner's own
    // record write keeps failing past the grace window, so it gives the lease
    // up as a follower. It used to record a blanket `expiry` with a `0`
    // latency; the trigger is the decision (one grace window after the first
    // failed heartbeat) and the latency is the release that followed it.
    const h = await lease();
    await h.start();
    expect(h.supervisor.role).toBe('leader');

    // The record write fails from here on: `wx` still stands, but every
    // heartbeat write throws.
    vi.spyOn(h.store, 'heartbeat').mockResolvedValue('failed');
    let ticks = 0;
    while (h.supervisor.role === 'leader' && ticks < 80) {
      await h.tick(1);
      ticks += 1;
    }

    expect(h.supervisor.role).not.toBe('leader');
    expect(h.supervisor.lastHandover?.direction).toBe('step-down');
    expect(h.supervisor.lastHandover?.reason).toBe('expiry');
    expect(h.supervisor.lastHandover?.latencyUnknown).toBeNull();
    // The trigger is the decision itself (one grace window after the first
    // failed heartbeat) and the release completes in the same call, so the
    // measured latency is the write-and-unlink cost: 0 here, and now known to
    // be 0 rather than assumed.
    expect(h.supervisor.lastHandover?.latencyMs).toBe(0);
  });

  it('measures the owner-changed demotion at zero when it is seen and acted on in one look', async () => {
    // Another window's record appears under the path between two ticks, and the
    // very next look both sees it and demotes — so the honest latency is a
    // measured `0`, which `latencyUnknown: null` now distinguishes from the
    // "not measurable" that a bare `0` used to hide.
    const h = await lease();
    await h.start();
    expect(h.supervisor.role).toBe('leader');

    await writeForeignLease(h, { pid: process.pid, ownerNonce: 'somebody-else', heartbeatAt: h.clock.ms });
    await h.tick(1);

    expect(h.supervisor.role).toBe('follower');
    expect(h.supervisor.lastHandover?.direction).toBe('step-down');
    // Another window's record displaced this one: the lease expired from this
    // window's side, which is exactly why the takeover could happen.
    expect(h.supervisor.lastHandover?.reason).toBe('expiry');
    expect(h.supervisor.lastHandover?.latencyMs).toBe(0);
    expect(h.supervisor.lastHandover?.latencyUnknown).toBeNull();
  });

  it('records a focus handover with the requester’s request as the trigger', async () => {
    // An expired foreign lease, so this window really is the owner (and its
    // record carries a claim time a later request can legitimately displace).
    const h = await lease({ focused: false });
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms - LEASE_EXPIRY_MS - 5_000 });
    await h.start();
    expect(h.supervisor.role).toBe('leader');

    // Past the anti-ping-pong window N, so the request is one the owner must
    // honour rather than the churn the hysteresis exists to stop.
    await h.tick(Math.ceil(LEASE_HANDOVER_HYSTERESIS_N_MS / LEASE_CLAIM_TICK_MS) + 1);
    // A focused requester asks to take over; the request is newer than this
    // window's claim, so the owner yields on the next tick.
    await writeForeignClaimRequest(h, { focused: true }, { at: h.clock.ms + 1_000 });
    await h.tick(1);

    expect(h.supervisor.role).toBe('follower');
    expect(h.supervisor.lastHandover?.direction).toBe('step-down');
    expect(h.supervisor.lastHandover?.reason).toBe('focus');
    // The trigger is the requester's own request timestamp, one tick before the
    // yield landed: this window's reaction time, which is what §11.2 measures.
    expect(h.supervisor.lastHandover?.latencyMs).toBe(LEASE_CLAIM_TICK_MS - 1_000);
    expect(h.supervisor.lastHandover?.latencyUnknown).toBeNull();
  });
});

describe('only a confirmed, healthy follower closes the gate (§8)', () => {
  it('closes it for a live foreign lease and opens it again on takeover', async () => {
    const h = await lease();
    // A live owner whose pid is this process: no expiry, no dead-pid shortcut.
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();

    expect(h.supervisor.mayPoll()).toBe(false);
    expect(h.gateChanges).toEqual([false]);
    expect(h.supervisor.lastHandover).toBeNull();

    // The owner closes its window: the `deactivate()` path is "the file is
    // gone", and the next tick (here: the next clock step) takes it.
    await fs.promises.rm(h.leasePath, { force: true });
    await h.tick(1);

    expect(h.supervisor.role).toBe('leader');
    expect(h.supervisor.mayPoll()).toBe(true);
    // The transition is what the poller reacts to by polling immediately.
    expect(h.gateChanges).toEqual([false, true]);
    // And the handover the diagnostics report: a clean close. The counterpart
    // is unknowable here — the file the release removed was the only record of
    // who held it — and the payload reports that as null rather than guessing.
    // The latency is unknowable for the same reason, and says so instead of
    // claiming a `0`: this window never saw the predecessor let go, it only
    // found the file gone.
    expect(h.supervisor.lastHandover?.direction).toBe('takeover');
    expect(h.supervisor.lastHandover?.reason).toBe('close');
    expect(h.supervisor.lastHandover?.counterpartPid).toBeNull();
    expect(h.supervisor.lastHandover?.latencyMs).toBeNull();
    expect(h.supervisor.lastHandover?.latencyUnknown).toBe('predecessor-release-time-unobservable');
  });

  it('takes over an expired lease and reports how long the trigger took', async () => {
    const h = await lease();
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms - LEASE_EXPIRY_MS - 5_000 });
    await h.start();

    expect(h.supervisor.lastHandover?.direction).toBe('takeover');
    expect(h.supervisor.lastHandover?.reason).toBe('expiry');
    // The trigger is the moment the record became expirable, so the latency is
    // exactly the 5 s it was already past the expiry when this window started.
    expect(h.supervisor.lastHandover?.latencyMs).toBe(5_000);
    expect(h.supervisor.lastHandover?.latencyUnknown).toBeNull();
    expect(h.supervisor.mayPoll()).toBe(true);
  });

  it('opens the gate when the lease path becomes unreadable: uncertainty polls', async () => {
    const real = toFileSystem();
    let readable = true;
    const fsPath = withFaults({
      readFile: async (filePath) => {
        if (!readable) {
          throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' });
        }
        return real.readFile(filePath);
      },
    });
    const h = await lease({ fs: fsPath, focused: false });
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });

    // First a healthy follower: the gate closes.
    await h.start();
    expect(h.supervisor.mayPoll()).toBe(false);

    // Then the path stops being readable, which is the mechanism being
    // unusable (§8): the window must poll, and say so once.
    readable = false;
    await h.tick(1);

    expect(h.supervisor.mayPoll()).toBe(true);
    expect(h.gateChanges).toEqual([false, true]);
    expect(h.degradedNotices).toEqual(['read-unusable']);
    expect(h.supervisor.role).toBe('degraded');
  });

  it('opens the gate when a tick fails outright, because the state is unknown', async () => {
    const h = await lease();
    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();
    expect(h.supervisor.mayPoll()).toBe(false);

    // `LeaseStore.read` swallows fs errors, so an unreadable file cannot throw;
    // a *store* that throws is the case this covers (a bug, an unexpected
    // shape). The rail is the same either way: unknown state polls.
    vi.spyOn(h.store, 'readHolderAlive').mockRejectedValue(new Error('boom'));
    await h.tick(1);

    expect(h.supervisor.mayPoll()).toBe(true);
    expect(h.gateChanges).toEqual([false, true]);
    expect(h.debugLines().join('\n')).toContain('lease tick failed');
  });

  it('reports a degraded mechanism to the one-time notice exactly once', async () => {
    const h = await lease({
      fs: withFaults({
        readFile: async () => {
          throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' });
        },
      }),
    });
    await h.start();
    await h.tick(10);

    expect(h.degradedNotices).toEqual(['read-unusable']);
    expect(h.supervisor.degradationNoticeShown).toBe(true);
  });
});

describe('the gate subscription', () => {
  it('stops notifying a listener that has been disposed', async () => {
    const h = await lease();
    const seen: boolean[] = [];
    const subscription = h.supervisor.onDidChange((mayPoll) => seen.push(mayPoll));
    subscription.dispose();

    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();

    expect(h.supervisor.mayPoll()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('survives a listener that throws, and keeps polling', async () => {
    const h = await lease();
    h.supervisor.onDidChange(() => {
      throw new Error('consumer bug');
    });

    await writeForeignLease(h, { pid: process.pid, heartbeatAt: h.clock.ms });
    await h.start();

    expect(h.supervisor.mayPoll()).toBe(false);
    expect(h.debugLines().join('\n')).toContain('lease gate listener failed');
  });
});
