import { describe, expect, it } from 'vitest';
import {
  claimRequestBackoffMs,
  decideLeaseAction,
  isClaimRequestPending,
  isLeaseStale,
  selectCurrentClaimRequest,
  type ClaimRequestObservation,
  type LeaseClaimPlan,
  type LeaseDecision,
  type LeaseDecisionInput,
  type LeaseSnapshot,
} from '../lease/leaseDecision';
import {
  LEASE_ACCELERATED_STALE_MS,
  LEASE_CLAIM_REQUEST_MAX_AGE_MS,
  LEASE_EXPIRY_MS,
  LEASE_HANDOVER_HYSTERESIS_N_MS,
  LEASE_HEARTBEAT_MS,
  LEASE_OWNER_STEP_DOWN_MS,
  LEASE_UNANSWERED_REQUEST_LIMIT_K,
} from '../lease/leaseConstants';
import type { LeaseRecord } from '../lease/leaseTypes';
import { makeClaimRequestObservation, makeInput, makeLease, makeWindow } from './leaseTestHelpers';

/**
 * The pure decision layer (§10.1.1, §10.1.8). Every test passes an explicit
 * `now` and its own state; no clock, no fs and no `vscode` is involved, which
 * is exactly the property that lets these cases be exhaustive.
 */

const NOW = 100_000;

describe('decideLeaseAction: the follower branches', () => {
  it('claims when the lease file does not exist', () => {
    const decision = decideLeaseAction(makeInput({ now: NOW }));
    expect(decision).toEqual({
      action: 'claim',
      reason: 'follower-takeover-absent',
      plan: { mustReleaseStale: false },
    });
  });

  it('treats an unparseable record as stale and releases it before claiming', () => {
    const decision = decideLeaseAction(makeInput({ now: NOW, lease: snapshotOf({ kind: 'invalid' }) }));
    expect(decision).toEqual({
      action: 'claim',
      reason: 'follower-takeover-expired',
      plan: { mustReleaseStale: true },
    });
  });

  it('takes over a lease whose heartbeat is older than the expiry', () => {
    const record = makeLease({ ownerNonce: 'other', heartbeatAt: NOW - LEASE_EXPIRY_MS - 1 });
    const decision = decideLeaseAction(makeInput({ now: NOW, holderPidAlive: true, lease: snapshotOf(record) }));
    expect(decision).toEqual({
      action: 'claim',
      reason: 'follower-takeover-expired',
      plan: { mustReleaseStale: true },
    });
  });

  it('takes over a lease whose holder pid is dead even when the heartbeat is fresh', () => {
    const record = makeLease({ ownerNonce: 'other', heartbeatAt: NOW });
    const decision = decideLeaseAction(makeInput({ now: NOW, holderPidAlive: false, lease: snapshotOf(record) }));
    expect(decision).toEqual({
      action: 'claim',
      reason: 'follower-takeover-expired',
      plan: { mustReleaseStale: true },
    });
  });

  it('stays a follower while a live holder heartbeats', () => {
    const record = makeLease({ ownerNonce: 'other', heartbeatAt: NOW - 1_000 });
    const decision = decideLeaseAction(makeInput({ now: NOW, holderPidAlive: true, lease: snapshotOf(record) }));
    expect(decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
  });

  it('does not take over on an instance-fingerprint difference alone (§3.3)', () => {
    // The fingerprint is not an input to the decision at all; this test pins
    // that down by changing it on an otherwise untouched record and still
    // expecting the follower branch.
    const record = makeLease({ ownerNonce: 'other', heartbeatAt: NOW - 1_000, instancesFingerprint: 'something-else' });
    const decision = decideLeaseAction(makeInput({ now: NOW, holderPidAlive: true, lease: snapshotOf(record) }));
    expect(decision.action).toBe('inactive');
  });

  it('keeps following after a clock rollback, because a younger heartbeat is the conservative reading', () => {
    // heartbeatAt in the future makes the age negative; treating that as stale
    // would be the unsafe direction (§6).
    const record = makeLease({ ownerNonce: 'other', heartbeatAt: NOW + 60_000 });
    const decision = decideLeaseAction(makeInput({ now: NOW, holderPidAlive: true, lease: snapshotOf(record) }));
    expect(decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
  });

  it('takes over after a clock jump forward, which is the safe direction (§6)', () => {
    const record = makeLease({ ownerNonce: 'other', heartbeatAt: NOW - 60 * 60 * 1000 });
    const decision = decideLeaseAction(makeInput({ now: NOW, holderPidAlive: true, lease: snapshotOf(record) }));
    expect(decision.action).toBe('claim');
  });
});

describe('decideLeaseAction: the accelerated takeover (K)', () => {
  /** A foreign, live owner whose record is at least `ageMs` old and past N. */
  function staleForeignOwner(ageMs: number): LeaseRecord {
    return makeLease({
      ownerNonce: 'other',
      claimedAt: NOW - LEASE_HANDOVER_HYSTERESIS_N_MS - 1_000,
      heartbeatAt: NOW - ageMs,
    });
  }

  /** The plan of a decision the test knows is a claim; throws if it is not. */
  function claimPlanOf(decision: LeaseDecision): LeaseClaimPlan {
    if (decision.action !== 'claim') {
      throw new Error(`expected a claim decision, got ${decision.action}`);
    }
    return decision.plan;
  }

  /** The accelerated decision for a record that is `ageMs` old, K requests in. */
  function acceleratedDecision(ageMs: number): LeaseDecision {
    return decideLeaseAction(
      makeInput({
        now: NOW,
        own: makeWindow({ focused: true }),
        holderPidAlive: true,
        lease: snapshotOf(staleForeignOwner(ageMs)),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
      }),
    );
  }

  it('escalates after K unanswered requests against a record older than 3 × heartbeat', () => {
    const record = staleForeignOwner(LEASE_ACCELERATED_STALE_MS + 1);
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        own: makeWindow({ focused: true }),
        holderPidAlive: true,
        lease: snapshotOf(record),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
      }),
    );
    expect(decision).toEqual({
      action: 'claim',
      reason: 'follower-takeover-accelerated',
      plan: {
        mustReleaseStale: true,
        // The release is ordered at the *accelerated* threshold, so it cannot
        // undo the decision it came from (§4.2.3), and it names the record it
        // decided about so a newer holder can never be unlinked by it.
        staleRelease: {
          expectedHolder: {
            ownerNonce: 'other',
            pid: process.pid,
            claimedAt: NOW - LEASE_HANDOVER_HYSTERESIS_N_MS - 1_000,
          },
          thresholdMs: LEASE_ACCELERATED_STALE_MS,
        },
      },
    });
  });

  it('orders the accelerated release threshold off the accelerated reason alone (safety constraint 1)', () => {
    // Every other claim path must keep `LEASE_EXPIRY_MS`: only
    // `follower-takeover-accelerated` may lower the threshold the release
    // re-checks, and it must hand over the identity of the record it decided
    // about in the same breath.
    const expired = claimPlanOf(
      decideLeaseAction(
        makeInput({ now: NOW, holderPidAlive: true, lease: snapshotOf(staleForeignOwner(LEASE_EXPIRY_MS + 1)) }),
      ),
    );
    expect(expired.staleRelease).toBeUndefined();

    const absent = claimPlanOf(decideLeaseAction(makeInput({ now: NOW })));
    expect(absent.staleRelease).toBeUndefined();

    const invalid = claimPlanOf(decideLeaseAction(makeInput({ now: NOW, lease: snapshotOf({ kind: 'invalid' }) })));
    expect(invalid.staleRelease).toBeUndefined();

    const accelerated = claimPlanOf(acceleratedDecision(LEASE_ACCELERATED_STALE_MS + 1));
    expect(accelerated.staleRelease?.thresholdMs).toBe(LEASE_ACCELERATED_STALE_MS);

    // The plan is built from the record the decision read, never from a
    // constant: a second decision about a different holder carries that holder.
    const otherHolder = makeLease({
      ownerNonce: 'third-window',
      pid: 987_654,
      claimedAt: NOW - LEASE_HANDOVER_HYSTERESIS_N_MS - 2_000,
      heartbeatAt: NOW - LEASE_ACCELERATED_STALE_MS - 1,
    });
    const second = claimPlanOf(
      decideLeaseAction(
        makeInput({
          now: NOW,
          own: makeWindow({ focused: true }),
          holderPidAlive: true,
          lease: snapshotOf(otherHolder),
          ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
        }),
      ),
    );
    expect(second.staleRelease?.expectedHolder).toEqual({
      ownerNonce: 'third-window',
      pid: 987_654,
      claimedAt: NOW - LEASE_HANDOVER_HYSTERESIS_N_MS - 2_000,
    });
  });

  it('does not accelerate against a healthy owner whose record is younger than one heartbeat period', () => {
    // The 2026-09-27 dual-window soak's regression, in one assertion: with the
    // old 5 s threshold this fired, evicting a leader whose record was 6 s old —
    // a perfectly healthy owner between two 10 s heartbeats.
    const record = staleForeignOwner(6_000);
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        own: makeWindow({ focused: true }),
        holderPidAlive: true,
        lease: snapshotOf(record),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
      }),
    );
    expect(decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
  });

  it('does not accelerate one heartbeat short of three', () => {
    // 2 × heartbeat: still inside the range a live (but slower) owner can
    // produce, so it is not evidence yet.
    const record = staleForeignOwner(2 * LEASE_HEARTBEAT_MS);
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        own: makeWindow({ focused: true }),
        holderPidAlive: true,
        lease: snapshotOf(record),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
      }),
    );
    expect(decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
  });

  it('does not accelerate an owner that is still inside the anti-ping-pong window N', () => {
    // K outranks the wait for the expiry; it never outranks N. A window that
    // just took the lease keeps it for N even with K requests and an old record.
    const justTookIt = makeLease({
      ownerNonce: 'other',
      claimedAt: NOW - 1_300, // 1.3 s into its tenure, as in the soak
      heartbeatAt: NOW - LEASE_ACCELERATED_STALE_MS - 1,
    });
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        own: makeWindow({ focused: true }),
        holderPidAlive: true,
        lease: snapshotOf(justTookIt),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
      }),
    );
    expect(decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
  });

  it('does escalate once N has passed, all else equal', () => {
    const record = staleForeignOwner(LEASE_ACCELERATED_STALE_MS + 1);
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        own: makeWindow({ focused: true }),
        holderPidAlive: true,
        lease: snapshotOf(record),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
      }),
    );
    expect(decision.action).toBe('claim');
  });

  it('does not escalate one request short of K', () => {
    const record = staleForeignOwner(LEASE_ACCELERATED_STALE_MS + 1);
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        holderPidAlive: true,
        lease: snapshotOf(record),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K - 1 },
      }),
    );
    expect(decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
  });

  it('does not escalate while the heartbeat is fresher than the staleness threshold', () => {
    const record = staleForeignOwner(1_000);
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        holderPidAlive: true,
        lease: snapshotOf(record),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
      }),
    );
    expect(decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
  });

  it('does not escalate from an unfocused window', () => {
    const record = staleForeignOwner(LEASE_ACCELERATED_STALE_MS + 1);
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        own: makeWindow({ focused: false }),
        holderPidAlive: true,
        lease: snapshotOf(record),
        ownClaimRequest: { consecutiveUnansweredRequests: LEASE_UNANSWERED_REQUEST_LIMIT_K },
      }),
    );
    expect(decision).toEqual({ action: 'inactive', reason: 'follower-follow' });
  });
});

describe('decideLeaseAction: the owner branches', () => {
  it('renews while it is the owner and nothing asks for the lease', () => {
    expect(decideLeaseAction(ownerInput())).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-renew' });
  });

  it('becomes a follower again when the record no longer carries our token', () => {
    // §4.1.2: a record whose ownerNonce is not ours means somebody took over
    // (a forced handover, a clock jump, a stale process). This window must stop
    // considering itself the owner rather than keep polling alongside it.
    const decision = decideLeaseAction(ownerInput({ lease: snapshotOf(makeLease({ ownerNonce: 'somebody-else' })) }));
    expect(decision).toEqual({
      action: 'claim',
      reason: 'follower-takeover-expired',
      plan: { mustReleaseStale: true },
    });
  });

  it('steps down once heartbeat-write failures span 2 x expiry (§4.1, §12.9)', () => {
    const decision = decideLeaseAction(
      ownerInput({ ownerHealth: { consecutiveFailures: 8, failureSince: NOW - LEASE_OWNER_STEP_DOWN_MS } }),
    );
    expect(decision).toEqual({ action: 'step-down', reason: 'owner-step-down-unwritable' });
  });

  it('keeps owning and polling before that threshold, with the failures recorded', () => {
    const decision = decideLeaseAction(
      ownerInput({ ownerHealth: { consecutiveFailures: 6, failureSince: NOW - LEASE_OWNER_STEP_DOWN_MS + 1 } }),
    );
    expect(decision.action).toBe('keep-and-heartbeat');
  });

  it('steps down when its own record has gone older than the step-down threshold', () => {
    const decision = decideLeaseAction(
      ownerInput({
        lease: snapshotOf(makeLease({ ownerNonce: 'self-nonce', heartbeatAt: NOW - LEASE_OWNER_STEP_DOWN_MS })),
      }),
    );
    expect(decision).toEqual({ action: 'step-down', reason: 'owner-heartbeat-stale' });
  });

  it('names the write failure, not the aged record, while a failure streak is active (§4.1)', () => {
    // Both thresholds are crossed at the same time in the real world: the first
    // attempt that fails is one heartbeat after the last write that succeeded,
    // so the record is older than 2 x expiry exactly when the streak is. The
    // cause is what an operator needs, so the streak wins and the generic stale
    // reason is not reported.
    const record = makeLease({ ownerNonce: 'self-nonce', heartbeatAt: NOW - LEASE_OWNER_STEP_DOWN_MS - 30_000 });
    const decision = decideLeaseAction(
      ownerInput({
        lease: snapshotOf(record),
        ownerHealth: { consecutiveFailures: 3, failureSince: NOW - LEASE_OWNER_STEP_DOWN_MS },
      }),
    );
    expect(decision).toEqual({ action: 'step-down', reason: 'owner-step-down-unwritable' });
  });

  it('keeps owning while an active streak has not reached 2 x expiry, even with an anciently old record', () => {
    // The threshold is the streak's, not the record's, once something is failing
    // on the write path: stepping down before 2 x expiry would create a window
    // with nobody polling for a fault that may already be over.
    const record = makeLease({ ownerNonce: 'self-nonce', heartbeatAt: NOW - 10 * LEASE_OWNER_STEP_DOWN_MS });
    const decision = decideLeaseAction(
      ownerInput({
        lease: snapshotOf(record),
        ownerHealth: { consecutiveFailures: 6, failureSince: NOW - LEASE_OWNER_STEP_DOWN_MS + 1 },
      }),
    );
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-renew' });
  });

  it('stays the owner of an unpublished record and renews it instead of taking it over (§3.2, §4.2)', () => {
    // The `wx` create is this window's mutex, but the record never landed, so no
    // reader can see the nonce: the follower branch here would release and
    // re-create the file every tick.
    const decision = decideLeaseAction(makeInput({ now: NOW, lease: snapshotOf({ kind: 'invalid' }, [], true, true) }));
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-renew-unpublished' });
  });

  it('steps down with the write-failure reason when an unpublished record stays unpublished', () => {
    const before = decideLeaseAction(
      makeInput({
        now: NOW,
        lease: snapshotOf({ kind: 'invalid' }, [], true, true),
        ownerHealth: { consecutiveFailures: 7, failureSince: NOW - LEASE_OWNER_STEP_DOWN_MS + 1 },
      }),
    );
    expect(before.action).toBe('keep-and-heartbeat');

    const atThreshold = decideLeaseAction(
      makeInput({
        now: NOW,
        lease: snapshotOf({ kind: 'invalid' }, [], true, true),
        ownerHealth: { consecutiveFailures: 8, failureSince: NOW - LEASE_OWNER_STEP_DOWN_MS },
      }),
    );
    expect(atThreshold).toEqual({ action: 'step-down', reason: 'owner-step-down-unwritable' });
  });

  it('still degrades rather than claiming an unpublished record on an unreadable path', () => {
    // An unusable mechanism short-circuits everything, including this branch: §8
    // degradation is not about who holds what.
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        lease: {
          leasePathReadable: false,
          lease: { kind: 'invalid', reason: 'unreadable' },
          claimRequests: [],
          ownRecordUnpublished: true,
        },
      }),
    );
    expect(decision).toEqual({ action: 'degraded-to-full-speed', reason: 'lease-unavailable' });
  });

  it('keeps owning while a request is not newer than the lease itself', () => {
    // Every window on one machine reads one clock (§6), so the rule "only a
    // request newer than the lease displaces it" is enforced at the utility
    // level: a request past the request tick is filtered out before the owner
    // branch ever sees it, and the owner simply renews.
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 600_000, heartbeatAt: NOW });
    const stale = makeClaimRequestObservation({ at: NOW - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1 });
    expect(isClaimRequestPending(stale, NOW, 111)).toBe(false);
    expect(selectCurrentClaimRequest([stale], NOW, 111)).toBeUndefined();
    const decision = decideLeaseAction(ownerInput({ lease: snapshotOf(record, [stale]) }));
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-renew' });
  });

  it('never lets an older request displace a lease that is younger than one tick', () => {
    // The hysteresis window N and the request tick happen to be the same order
    // of magnitude, so a request older than a *young* lease is kept out by the
    // hysteresis rule; `owner-keep-requested-stale` remains as the explicit
    // guard behind it for a caller that supplies requests directly.
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW + 30_000, heartbeatAt: NOW });
    const decision = decideLeaseAction(
      ownerInput({ lease: snapshotOf(record, [makeClaimRequestObservation({ at: NOW - 1_000 })]) }),
    );
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-keep-hysteresis' });
  });

  it('refuses to yield to a request from a window that is not focused', () => {
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW });
    const request = makeClaimRequestObservation({ at: NOW - 1_000, focused: false });
    const decision = decideLeaseAction(ownerInput({ lease: snapshotOf(record, [request]) }));
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-keep-requested-unfocused' });
  });

  it('keeps the lease while this window itself is focused, even for a newer focused request (§2.3)', () => {
    // The exact regression of the 2026-09-27 soak: both windows reported
    // `focused`, so yielding handed the lease over only for the window it came
    // from to ask for it back — a handover every N + a tick. Handing over while
    // this window is the one being looked at buys nothing.
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW });
    const request = makeClaimRequestObservation({ at: NOW - 1_000, focused: true });
    const decision = decideLeaseAction(ownerInput({ lease: snapshotOf(record, [request]) }));
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-keep-focused' });
  });

  it('yields to a newer focused request once this window itself is not focused (§2.3)', () => {
    // The intended handover: the user has moved to the other window, so the
    // seat — and with it the toast — follows the eyes.
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW });
    const request = makeClaimRequestObservation({ at: NOW - 1_000, focused: true, pid: 4242 });
    const decision = decideLeaseAction(
      ownerInput({ own: makeWindow({ focused: false }), lease: snapshotOf(record, [request]) }),
    );
    expect(decision).toEqual({
      action: 'yield',
      reason: 'owner-yield-focus-request',
      yieldTo: request.request,
    });
  });

  it('keeps the lease when it is unfocused and nobody asks for it: "nobody is looking" is not a reason to stop', () => {
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW });
    const decision = decideLeaseAction(ownerInput({ own: makeWindow({ focused: false }), lease: snapshotOf(record) }));
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-renew' });
  });

  it('keeps the lease when it is unfocused and only an unfocused window asks', () => {
    // Both windows in the background: leadership does not move to a window the
    // user is not using, and it must never become "nobody polls" (§2.3).
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW });
    const request = makeClaimRequestObservation({ at: NOW - 1_000, focused: false });
    const decision = decideLeaseAction(
      ownerInput({ own: makeWindow({ focused: false }), lease: snapshotOf(record, [request]) }),
    );
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-keep-requested-unfocused' });
  });

  it('does not yield within the anti-ping-pong window N of taking the lease (§2.3)', () => {
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW, heartbeatAt: NOW });
    const request = makeClaimRequestObservation({ at: NOW, focused: true });
    const decision = decideLeaseAction(ownerInput({ lease: snapshotOf(record, [request]) }));
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-keep-hysteresis' });
  });

  it('lets N outrank the focus rule: an unfocused owner inside N still keeps the lease', () => {
    // The soak's shape: the new owner is inside N while the window it took the
    // lease from asks again. N is checked first, so the answer is "keep".
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 1_000, heartbeatAt: NOW });
    const request = makeClaimRequestObservation({ at: NOW - 500, focused: true });
    const decision = decideLeaseAction(
      ownerInput({ own: makeWindow({ focused: false }), lease: snapshotOf(record, [request]) }),
    );
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-keep-hysteresis' });
  });

  it('does yield once N has elapsed and this window is not focused', () => {
    const record = makeLease({
      ownerNonce: 'self-nonce',
      claimedAt: NOW - LEASE_HANDOVER_HYSTERESIS_N_MS,
      heartbeatAt: NOW,
    });
    const request = makeClaimRequestObservation({ at: NOW - 1_000, focused: true });
    const decision = decideLeaseAction(
      ownerInput({ own: makeWindow({ focused: false }), lease: snapshotOf(record, [request]) }),
    );
    expect(decision.action).toBe('yield');
  });

  it('ignores a request older than the request tick', () => {
    const record = makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW });
    const request = makeClaimRequestObservation({ at: NOW - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1, focused: true });
    const decision = decideLeaseAction(ownerInput({ lease: snapshotOf(record, [request]) }));
    expect(decision).toEqual({ action: 'keep-and-heartbeat', reason: 'owner-renew' });
  });
});

describe('decideLeaseAction: degradation', () => {
  it('degrades to full-speed polling when the lease path itself is unreadable', () => {
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        lease: {
          leasePathReadable: false,
          lease: { kind: 'invalid', reason: 'unreadable' },
          claimRequests: [],
          ownRecordUnpublished: false,
        },
      }),
    );
    expect(decision).toEqual({ action: 'degraded-to-full-speed', reason: 'lease-unavailable' });
  });

  it('treats an unreadable lease path as degradation even when the probe flag was not set', () => {
    // The read result is authoritative; the flag is only a second opinion.
    const decision = decideLeaseAction(makeInput({ now: NOW, lease: snapshotOf({ kind: 'invalid' }, [], true) }));
    expect(decision.action).toBe('claim');

    const unreadable = decideLeaseAction(
      makeInput({
        now: NOW,
        lease: {
          leasePathReadable: true,
          lease: { kind: 'invalid', reason: 'unreadable' },
          claimRequests: [],
          ownRecordUnpublished: false,
        },
      }),
    );
    expect(unreadable).toEqual({ action: 'degraded-to-full-speed', reason: 'lease-unavailable' });
  });

  it('degrades even while holding a fresh record, because "unreadable" must never mean "keep owning"', () => {
    const decision = decideLeaseAction(
      makeInput({
        now: NOW,
        lease: {
          leasePathReadable: false,
          lease: { kind: 'ok', record: makeLease({ ownerNonce: 'self-nonce', heartbeatAt: NOW }) },
          claimRequests: [],
          ownRecordUnpublished: false,
        },
      }),
    );
    expect(decision.action).toBe('degraded-to-full-speed');
  });
});

describe('the decision is total', () => {
  it('returns a decision with a reason for every combination of inputs', () => {
    const decisions: LeaseDecision[] = [];
    const records = [
      makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW }),
      makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW - LEASE_EXPIRY_MS }),
      makeLease({ ownerNonce: 'other', heartbeatAt: NOW }),
      makeLease({ ownerNonce: 'other', heartbeatAt: NOW - LEASE_EXPIRY_MS - 1 }),
    ];
    for (const record of records) {
      for (const readable of [true, false]) {
        for (const focused of [true, false]) {
          for (const alive of [true, false, undefined]) {
            for (const failures of [0, 8]) {
              for (const unanswered of [0, 3]) {
                decisions.push(
                  decideLeaseAction(
                    makeInput({
                      now: NOW,
                      own: makeWindow({ focused }),
                      lease: {
                        leasePathReadable: readable,
                        lease: { kind: 'ok', record },
                        claimRequests: [],
                        ownRecordUnpublished: false,
                      },
                      holderPidAlive: alive,
                      ownerHealth: {
                        consecutiveFailures: failures,
                        failureSince: failures > 0 ? NOW - 200_000 : undefined,
                      },
                      ownClaimRequest: { consecutiveUnansweredRequests: unanswered },
                    }),
                  ),
                );
              }
            }
          }
        }
      }
    }
    for (const kind of ['missing', 'invalid'] as const) {
      decisions.push(decideLeaseAction(makeInput({ now: NOW, lease: snapshotOf({ kind }) })));
    }
    expect(decisions).toHaveLength(4 * 2 * 2 * 3 * 2 * 2 + 2);
    for (const decision of decisions) {
      expect(typeof decision.reason).toBe('string');
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(['inactive', 'claim', 'keep-and-heartbeat', 'yield', 'step-down', 'degraded-to-full-speed']).toContain(
        decision.action,
      );
    }
  });
});

describe('claim-request selection', () => {
  it('ignores a request from this window itself', () => {
    const observations = [makeClaimRequestObservation({ pid: 111 })];
    expect(selectCurrentClaimRequest(observations, NOW, 111)).toBeUndefined();
  });

  it('ignores a request older than the request tick', () => {
    const observations = [makeClaimRequestObservation({ at: NOW - LEASE_CLAIM_REQUEST_MAX_AGE_MS - 1 })];
    expect(selectCurrentClaimRequest(observations, NOW, 111)).toBeUndefined();
  });

  it('prefers a focused requester over a newer unfocused one', () => {
    const unfocused = makeClaimRequestObservation({ pid: 1, focused: false, at: NOW - 100 });
    const focused = makeClaimRequestObservation({ pid: 2, focused: true, at: NOW - 1_000 });
    expect(selectCurrentClaimRequest([unfocused, focused], NOW, 111)?.request.pid).toBe(2);
  });

  it('breaks ties inside a group by the newest request', () => {
    const older = makeClaimRequestObservation({ pid: 1, at: NOW - 2_000 });
    const newer = makeClaimRequestObservation({ pid: 2, at: NOW - 1_000 });
    expect(selectCurrentClaimRequest([older, newer], NOW, 111)?.request.pid).toBe(2);
  });

  it('breaks a same-millisecond tie by the file mtime, in either input order', () => {
    const first = makeClaimRequestObservation({ pid: 1, at: NOW - 1_000 }, { mtimeMs: NOW - 1_000 });
    const second = makeClaimRequestObservation({ pid: 2, at: NOW - 1_000 }, { mtimeMs: NOW - 500 });
    expect(selectCurrentClaimRequest([second, first], NOW, 111)?.request.pid).toBe(2);
    expect(selectCurrentClaimRequest([first, second], NOW, 111)?.request.pid).toBe(2);
  });

  it('classifies staleness by age and by a dead holder', () => {
    const record = makeLease({ heartbeatAt: NOW });
    expect(isLeaseStale(record, NOW, true)).toBe(false);
    expect(isLeaseStale(record, NOW, false)).toBe(true);
    expect(isLeaseStale(record, NOW + LEASE_EXPIRY_MS, true)).toBe(true);
    expect(isLeaseStale(record, NOW + LEASE_EXPIRY_MS - 1, true)).toBe(false);
  });

  it('treats a request stamped in the future as pending rather than letting it hold the owner forever', () => {
    // A stepped clock must not make the owner blind to a real request; the
    // worst case of honouring it is one handover to a focused window.
    expect(isClaimRequestPending(makeClaimRequestObservation({ at: NOW + 5_000 }), NOW, 111)).toBe(true);
    expect(isClaimRequestPending(makeClaimRequestObservation({ at: NOW }), NOW, 111)).toBe(true);
  });

  it('backs claim requests off exponentially, capped', () => {
    expect(claimRequestBackoffMs(0, 2_000, 30_000)).toBe(2_000);
    expect(claimRequestBackoffMs(1, 2_000, 30_000)).toBe(4_000);
    expect(claimRequestBackoffMs(2, 2_000, 30_000)).toBe(8_000);
    expect(claimRequestBackoffMs(99, 2_000, 30_000)).toBe(30_000);
  });
});

describe('the recorded starting values are internally consistent (§12 last entry)', () => {
  it('keeps the expiry at three to four heartbeats', () => {
    // The document's own words: "3 heartbeats" (35 s at a 10 s heartbeat).
    expect(LEASE_EXPIRY_MS).toBeGreaterThanOrEqual(3 * LEASE_HEARTBEAT_MS);
    expect(LEASE_EXPIRY_MS).toBeLessThan(4 * LEASE_HEARTBEAT_MS);
  });

  it('keeps the step-down threshold at 2 x expiry', () => {
    expect(LEASE_OWNER_STEP_DOWN_MS).toBe(2 * LEASE_EXPIRY_MS);
  });

  it('keeps the accelerated staleness threshold at three heartbeats, below the expiry', () => {
    // The threshold is only evidence if it is above one heartbeat period (a
    // healthy record is legitimately that old), and it is only useful if it is
    // below the expiry (otherwise the accelerated branch is dead code and the
    // expiry takeover always wins). Both properties are asserted here so a
    // retune of the heartbeat cannot silently break either — §4.1 and §11.2.
    // It is also the threshold the accelerated *release* re-checks (§4.2.3,
    // `LeaseClaimPlan.staleRelease`), which is what makes a live-but-silent
    // holder displaceable at 30 s rather than only at 35 s.
    expect(LEASE_ACCELERATED_STALE_MS).toBe(30_000);
    expect(LEASE_ACCELERATED_STALE_MS).toBe(3 * LEASE_HEARTBEAT_MS);
    expect(LEASE_ACCELERATED_STALE_MS).toBeGreaterThan(LEASE_HEARTBEAT_MS);
    expect(LEASE_ACCELERATED_STALE_MS).toBeLessThan(LEASE_EXPIRY_MS);
  });
});

function snapshotOf(
  record: ReturnType<typeof makeLease> | { kind: 'missing' } | { kind: 'invalid' },
  claimRequests: ClaimRequestObservation[] = [],
  leasePathReadable = true,
  ownRecordUnpublished = false,
): LeaseSnapshot {
  return {
    leasePathReadable,
    lease: 'kind' in record ? { kind: record.kind, reason: 'malformed' } : { kind: 'ok', record },
    claimRequests,
    ownRecordUnpublished,
  };
}

/** An input where this window holds a fresh, own lease. */
function ownerInput(overrides: Partial<LeaseDecisionInput> = {}): LeaseDecisionInput {
  return makeInput({
    now: NOW,
    own: makeWindow(),
    holderPidAlive: true,
    lease: snapshotOf(makeLease({ ownerNonce: 'self-nonce', claimedAt: NOW - 60_000, heartbeatAt: NOW })),
    ...overrides,
  });
}
