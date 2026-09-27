/**
 * The lease's decision layer: a small, total, clock-free function of its
 * inputs.
 *
 * Everything here is pure on purpose (§10.1.1, §10.3). The caller passes `now`,
 * its own focus state, the parsed lease (or its absence), the pending claim
 * requests and its own failure counters; this module never reads a clock, a
 * file or `vscode`, so every branch can be exercised exhaustively with a table
 * of inputs. The IO lives in `leaseStore.ts`; the wiring (timers, `fs.watch`,
 * the focus event) belongs to a later stage and is deliberately absent.
 *
 * Two invariants the shape of this function encodes:
 *
 * - **No single-window branch** (§2 decision 4, §12.4). Nothing here counts
 *   windows, and nothing infers "I am alone": a window's behaviour depends only
 *   on the lease file and its own state, so a second window appearing mid-tick
 *   cannot change a decision that was already correct.
 * - **Failure degrades toward more polling, never toward silence** (§8). Every
 *   unknown — unavailable mechanism, unreadable record, unknown lease state —
 *   resolves to the *follower* branch, which is the branch that keeps polling.
 */

import {
  LEASE_CLAIM_REQUEST_MAX_AGE_MS,
  LEASE_EXPIRY_MS,
  LEASE_HANDOVER_HYSTERESIS_N_MS,
  LEASE_HEARTBEAT_STALE_MS,
  LEASE_OWNER_STEP_DOWN_MS,
  LEASE_REQUEST_RETRY_BASE_MS,
  LEASE_REQUEST_RETRY_MAX_MS,
  LEASE_UNANSWERED_REQUEST_LIMIT_K,
} from './leaseConstants';
import type { ClaimRequest, ClaimRequestObservation, LeaseRead, LeaseRecord } from './leaseTypes';

/**
 * Every reason the decision layer can name. A closed union so the stage-2
 * logging and the "copy polling diagnostics" JSON (§7.1, §11.1 stage 2) can
 * switch on it exhaustively instead of matching log strings.
 */
export type LeaseDecisionReason =
  // Owner-side.
  | 'owner-renew'
  | 'owner-heartbeat-stale'
  | 'owner-step-down-unwritable'
  | 'owner-yield-focus-request'
  | 'owner-keep-unfocused'
  | 'owner-keep-requested-unfocused'
  | 'owner-keep-requested-stale'
  | 'owner-keep-hysteresis'
  // Follower-side.
  | 'follower-takeover-absent'
  | 'follower-takeover-expired'
  | 'follower-takeover-accelerated'
  | 'follower-follow';
// Degraded (the mechanism itself is unavailable).
export type LeaseDegradedReason = 'lease-unavailable';

/** The value of a "claim" decision: how the caller should proceed. */
export interface LeaseClaimPlan {
  /**
   * True when the caller must release whatever is in the way (a stale or
   * unreadable record) before `wx`-creating the lease. Releasing re-reads and
   * re-checks staleness first (§4.2.3) — never an unconditional unlink.
   */
  mustReleaseStale: boolean;
  /** The claim request that justified an accelerated takeover, if any (§2.3). */
  requestedBy?: ClaimRequest;
}

/** The decision the caller acts on. */
export type LeaseDecision =
  /** Stand down: stop polling, delete nothing, re-evaluate next tick. */
  | { action: 'inactive'; reason: LeaseDecisionReason }
  /** Become the owner: [`claim()`] then poll. */
  | { action: 'claim'; reason: LeaseDecisionReason; plan: LeaseClaimPlan }
  /** Still the owner: refresh the heartbeat and keep polling (§4.1). */
  | { action: 'keep-and-heartbeat'; reason: LeaseDecisionReason }
  /** Voluntarily give the lease up: re-read, compare the token, then unlink. */
  | { action: 'yield'; reason: LeaseDecisionReason; yieldTo?: ClaimRequest }
  /** Give the lease up *and* stop trusting our own record (§4.1). */
  | { action: 'step-down'; reason: LeaseDecisionReason }
  /** The mechanism is unusable: poll at full speed, exactly like today (§8). */
  | { action: 'degraded-to-full-speed'; reason: LeaseDegradedReason };

/**
 * What this window knows about itself. `focused` is a parameter, not a
 * `vscode` read: the wiring stage must be able to pass the same value the
 * fallback read of `vscode.window.state.focused` returns (§2.3 prerequisite 1)
 * without this module depending on the editor.
 */
export interface OwnWindowState {
  /** This window's module-scope owner nonce. */
  ownerNonce: string;
  /** This window's extension host pid. */
  pid: number;
  /** The current focus state, read by the caller. */
  focused: boolean;
}

/** The owner's local heartbeat-write failure counters (§4.1, §12.9). */
export interface OwnerHeartbeatHealth {
  /** Consecutive failed heartbeat writes. Reset by every success. */
  consecutiveFailures: number;
  /**
   * `now` when the current failure streak started, or `undefined` when the
   * last heartbeat write succeeded. `now - failureSince` is the only input to
   * the 70 s step-down threshold — a heartbeat counter alone cannot express it,
   * because a throttled timer may skip heartbeats entirely (§6).
   */
  failureSince?: number;
}

/** The follower's claim-request bookkeeping (§2.3, §12.10). */
export interface OwnClaimRequestState {
  /** Consecutive requests this window sent that the owner did not answer. */
  consecutiveUnansweredRequests: number;
  /**
   * `now` of the last request written; the caller uses it for the anti-storm
   * backoff. Not read by the decision function.
   */
  lastRequestAt?: number;
}

/** What the `LeaseStore` found on disk; already parsed, still unvalidated. */
export interface LeaseSnapshot {
  /**
   * `false` when an *additional* probe said the lease path itself cannot be
   * read (`EACCES`, `EROFS`, …). The authoritative signal for that is
   * `lease.kind === 'invalid'` with `reason: 'unreadable'`, which the store
   * always sets; this flag exists so a caller that probed separately can say so
   * without fabricating a read result. An unreadable path is **not** the same
   * as a missing file: it means the mechanism is unusable (§8).
   */
  leasePathReadable: boolean;
  /** The parsed lease, or `missing` / `invalid`. */
  lease: LeaseRead;
  /**
   * Claim-request files found next to the lease. An unreadable request file is
   * simply absent from the list: a broken request must never be able to hold
   * the current owner in place (§8).
   */
  claimRequests: ClaimRequestObservation[];
}

/** A claim request as observed on disk; defined with the other shared shapes. */
export type { ClaimRequestObservation } from './leaseTypes';

/**
 * Everything the decision needs. One object rather than a long positional
 * argument list, so a future stage can add a field without every call site
 * having to be re-read.
 */
export interface LeaseDecisionInput {
  /** `Date.now()` — passed in, never read here (§6: epoch ms only). */
  now: number;
  /** This window. */
  own: OwnWindowState;
  /** What is on disk right now. */
  lease: LeaseSnapshot;
  /**
   * `process.kill(pid, 0)` for the lease holder — `EPERM` counts as alive
   * (§3.5). `undefined` when no holder pid was readable. This layer does not
   * probe: the probe is IO and belongs to the store.
   */
  holderPidAlive: boolean | undefined;
  /** This window's consecutive heartbeat-write failures, if it believes it is the owner. */
  ownerHealth: OwnerHeartbeatHealth;
  /** This window's claim-request counters. */
  ownClaimRequest: OwnClaimRequestState;
}

/** True when a lease record is stale by age or by a dead holder pid. */
export function isLeaseStale(
  record: LeaseRecord,
  now: number,
  holderPidAlive: boolean | undefined,
  expiryMs: number = LEASE_EXPIRY_MS,
): boolean {
  if (holderPidAlive === false) {
    // "File present but pid dead" must be takeoverable (§3.5, §5). Waiting out
    // the expiry here would only widen the window with nobody polling.
    return true;
  }
  return now - record.heartbeatAt >= expiryMs;
}

/**
 * True when a claim request is worth acting on: recent enough to be a live
 * window's wish, and not ours. A request older than the request tick is
 * ignored, so a crashed requester cannot keep an owner stepping down forever.
 *
 * A timestamp *later* than `now` (a stepped clock, or a request file written by
 * a window ahead of us) is treated as pending rather than rejected: it is
 * exactly as fresh as it claims to be, and the worst case is one handover to a
 * window that really is focused. Rejecting it would be the unsafe direction —
 * the owner would keep a lease nobody asked it to keep.
 */
export function isClaimRequestPending(
  observation: ClaimRequestObservation,
  now: number,
  ownPid: number,
  maxAgeMs: number = LEASE_CLAIM_REQUEST_MAX_AGE_MS,
): boolean {
  if (observation.request.pid === ownPid) {
    return false;
  }
  return now - observation.request.at <= maxAgeMs;
}

/** The newest pending focused request, or the newest pending one as a fallback. */
export function selectCurrentClaimRequest(
  observations: readonly ClaimRequestObservation[],
  now: number,
  ownPid: number,
): ClaimRequestObservation | undefined {
  const pending = observations.filter((observation) => isClaimRequestPending(observation, now, ownPid));
  if (pending.length === 0) {
    return undefined;
  }
  // The newest request wins; the file mtime breaks equal timestamps, because
  // two windows writing in the same millisecond is exactly the case a
  // deterministic order matters for.
  const newest = (candidates: readonly ClaimRequestObservation[]): ClaimRequestObservation | undefined =>
    candidates.length === 0
      ? undefined
      : candidates.reduce((best, candidate) =>
          candidate.request.at > best.request.at ||
          (candidate.request.at === best.request.at && candidate.mtimeMs > best.mtimeMs)
            ? candidate
            : best,
        );
  // A focused requester wins over a newer unfocused one, and a pending
  // unfocused one still wins over nothing at all.
  return newest(pending.filter((observation) => observation.request.focused)) ?? newest(pending) ?? undefined;
}

/**
 * The delay before this window sends another claim request (§2.3: "a rejected
 * or failed request retries with backoff; it must not become a request
 * storm"). Exponential from the claim tick, capped, and jittered by the caller
 * if it wants to — the value itself stays deterministic so it can be asserted.
 */
export function claimRequestBackoffMs(
  consecutiveUnansweredRequests: number,
  baseMs: number = LEASE_REQUEST_RETRY_BASE_MS,
  maxMs: number = LEASE_REQUEST_RETRY_MAX_MS,
): number {
  const exponent = Math.max(0, Math.min(16, Math.floor(consecutiveUnansweredRequests)));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

/**
 * The decision itself.
 *
 * The branch order is the design, not an accident:
 *
 * 1. An unusable mechanism short-circuits everything: poll at full speed (§8).
 * 2. Ownership is decided by the `ownerNonce`, never by pid or timestamps, so a
 *    recycled pid or a clock glitch cannot make two windows believe they own it
 *    (§4.1.2). A record that is not ours — including `invalid` — leaves this
 *    window a follower.
 * 3. As the owner, holding on is the default. Yielding needs a *focused*
 *    requester whose request is newer than our claim and outside the N window;
 *    "nobody is focused" never means giving up polling (§2.3).
 * 4. As a follower, only the owner's apparent absence justifies a claim: an
 *    expired or dead-pid lease, or K unanswered requests against a stale
 *    heartbeat.
 */
export function decideLeaseAction(input: LeaseDecisionInput): LeaseDecision {
  const { own, lease } = input;

  if (!lease.leasePathReadable || (lease.lease.kind === 'invalid' && lease.lease.reason === 'unreadable')) {
    // §8: the directory/lease is not usable at all — behave exactly like the
    // setting being off, and let the wiring show its one-off notice (§7.1).
    return { action: 'degraded-to-full-speed', reason: 'lease-unavailable' };
  }

  const record = lease.lease.kind === 'ok' ? lease.lease.record : undefined;
  const holderIsSelf = record !== undefined && record.ownerNonce === own.ownerNonce;

  if (record !== undefined && holderIsSelf) {
    return decideAsOwner(input, record);
  }
  return decideAsFollower(input, record);
}

function decideAsOwner(input: LeaseDecisionInput, record: LeaseRecord): LeaseDecision {
  const { now, own, lease, ownerHealth } = input;

  if (ownerHealth.failureSince !== undefined && now - ownerHealth.failureSince >= LEASE_OWNER_STEP_DOWN_MS) {
    // §4.1: continuous heartbeat-write failure past 2 × expiry. Degrade and
    // re-claim rather than keep a title we can no longer refresh.
    return { action: 'step-down', reason: 'owner-step-down-unwritable' };
  }

  if (now - record.heartbeatAt >= LEASE_OWNER_STEP_DOWN_MS) {
    // Our own record went old — the heartbeat timer was throttled past the
    // step-down point (§6), or the write path has been silently broken. Either
    // way we can no longer prove liveness to anyone.
    return { action: 'step-down', reason: 'owner-heartbeat-stale' };
  }

  const claim = selectCurrentClaimRequest(lease.claimRequests, now, own.pid);
  if (claim === undefined) {
    return { action: 'keep-and-heartbeat', reason: 'owner-renew' };
  }

  const nothingToYieldTo = (reason: LeaseDecisionReason): LeaseDecision => ({ action: 'keep-and-heartbeat', reason });

  if (now - record.claimedAt < LEASE_HANDOVER_HYSTERESIS_N_MS) {
    // §2.3 hysteresis: a window that just took the lease is not displaced
    // within N, so two focused windows cannot trade it back and forth.
    return nothingToYieldTo('owner-keep-hysteresis');
  }
  if (!own.focused) {
    // §2.3: leadership does not follow "nobody is looking". We stay the owner
    // and keep polling — the requester will win on its next tick, or the K
    // escalation will take it, but we do not hand the job to nobody.
    return nothingToYieldTo('owner-keep-unfocused');
  }
  if (!claim.request.focused) {
    // A request from a window that is not focused is ignored outright, even
    // when this window happens to be focused.
    return nothingToYieldTo('owner-keep-requested-unfocused');
  }
  if (claim.request.at <= record.claimedAt) {
    // §2.3: only a request newer than the lease displaces it. Two clocks on one
    // machine are the same clock (§6), so this comparison is meaningful. It is
    // kept as an explicit guard even though the hysteresis window N and the
    // request-tick filter already make it hard to reach: it is the rule, and a
    // caller that supplies observations directly must hit it.
    return nothingToYieldTo('owner-keep-requested-stale');
  }

  // §2.3 step 3: yield with *only* a re-read plus holder-token comparison
  // before the unlink — no second confirmation (decision of 2026-09-27).
  return { action: 'yield', reason: 'owner-yield-focus-request', yieldTo: claim.request };
}

function decideAsFollower(input: LeaseDecisionInput, record: LeaseRecord | undefined): LeaseDecision {
  const { now, own, lease, holderPidAlive } = input;

  if (record === undefined) {
    // No lease, or an unusable one. Both are "take it" (§4.2, §8); an invalid
    // record has to be released first, and the release re-checks staleness.
    const absent = lease.lease.kind === 'missing';
    return {
      action: 'claim',
      reason: absent ? 'follower-takeover-absent' : 'follower-takeover-expired',
      plan: { mustReleaseStale: !absent },
    };
  }

  if (isLeaseStale(record, now, holderPidAlive)) {
    return {
      action: 'claim',
      reason: 'follower-takeover-expired',
      plan: { mustReleaseStale: true },
    };
  }

  const claim = selectCurrentClaimRequest(lease.claimRequests, now, own.pid);
  if (
    own.focused &&
    input.ownClaimRequest.consecutiveUnansweredRequests >= LEASE_UNANSWERED_REQUEST_LIMIT_K &&
    now - record.heartbeatAt > LEASE_HEARTBEAT_STALE_MS
  ) {
    // §2.3, K = 3: the owner is alive by pid but its heartbeat is older than
    // the staleness threshold and it has ignored K requests, so stop waiting
    // for the expiry. The cost is a possible short double poll — the safe
    // direction (§8).
    return {
      action: 'claim',
      reason: 'follower-takeover-accelerated',
      plan: { mustReleaseStale: true, requestedBy: claim?.request },
    };
  }

  // A live owner with a fresh heartbeat: this window stays a follower. It does
  // not poll, and only the caller's fallback timer keeps its options open.
  return { action: 'inactive', reason: 'follower-follow' };
}

/** True when the decision tells the caller to poll this window's own instance set. */
export function decisionPollsLocally(decision: LeaseDecision): boolean {
  return decision.action !== 'inactive';
}
