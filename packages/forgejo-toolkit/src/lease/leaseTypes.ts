/**
 * The lease's data shapes, shared by the IO layer (`leaseStore.ts`) and the
 * pure decision layer (`leaseDecision.ts`).
 *
 * They live in their own module so the decision layer can import *types only*
 * and stay free of runtime dependencies — no `fs`, no `vscode`, no clock.
 */

/**
 * The lease file's content (§3.2). JSON primitives only, matching the other
 * fixed-name files in globalStorage.
 *
 * There is no token and no credential here on purpose: `ownerNonce` is a local
 * random value, not a secret, and `instancesFingerprint` is a digest that
 * carries neither a username nor an address.
 */
export interface LeaseRecord {
  version: number;
  /**
   * Per-window random hex, generated once per extension host process. The pid
   * alone cannot identify a holder because pids are recycled — the same
   * reasoning as `mcp-workspace-<pid>-<nonce>.json` in mcpWorkspaceState.ts.
   */
  ownerNonce: string;
  /** Holder pid; for logs, manual triage and the crash pre-filter (§3.2, §3.5). */
  pid: number;
  /** Optional human-readable window label; VS Code has no stable window id. */
  windowId?: string;
  /** `Date.now()` when the holder claimed it. */
  claimedAt: number;
  /** `Date.now()` on every heartbeat. */
  heartbeatAt: number;
  /** Always `null` as shipped: a yield does not write a tombstone (see below). */
  releaseReason: string | null;
  appVersion: string;
  /** Fingerprint of the instance set; a change never triggers an election (§3.3). */
  instancesFingerprint: string;
}

/**
 * `releaseReason` is kept in the record shape but is never given a value: a
 * yielding window unlinks the lease instead of writing a tombstone (§7.1, the
 * stage-0 conclusion), so both write sites store `null` and the field is only
 * ever read back as `null`. The reason for a handover is recorded in the log
 * line and the diagnostics report, not on disk — a tombstone a reader could
 * mistake for a live lease was the reason the field stayed empty.
 */

/**
 * The three fields that identify one *specific* record on disk, for a release
 * that must not unlink a record some window has written since (§4.2.3).
 *
 * One field alone is never enough: a pid is recycled, an owner republishes
 * under the same `ownerNonce` on every heartbeat, and two windows can write in
 * the same millisecond. The three together are what "the record the decision
 * was about" means.
 */
export interface LeaseRecordIdentity {
  ownerNonce: string;
  pid: number;
  claimedAt: number;
}

/**
 * What a caller asserts about the record it wants released as stale (§2.3,
 * §4.2.3).
 *
 * The two fields travel together on purpose. The only caller that lowers the
 * age threshold below `LEASE_EXPIRY_MS` is the accelerated takeover (reason
 * `follower-takeover-accelerated`), and that is exactly the caller which may
 * unlink a record whose pid is still alive — so it must also name the record it
 * decided about. A lowered threshold can therefore never be aimed at "whatever
 * is older than 30 s": it applies to the decision's own record or to nothing.
 *
 * `LeaseStore.releaseStale` re-reads and re-checks both: the identity must
 * still match, and the *re-read* age must still exceed `thresholdMs`. A caller
 * that omits this argument keeps the ordinary `LEASE_EXPIRY_MS` release, which
 * is what every other path (and every other caller) does.
 */
export interface StaleReleaseExpectation {
  /** The record the decision saw. Any difference on the re-read answers `not-owner`. */
  expectedHolder: LeaseRecordIdentity;
  /** The age `now - heartbeatAt` the re-read record must still reach or exceed. */
  thresholdMs: number;
}

/** The result of reading the lease file (§4.2's follower state machine). */
export type LeaseRead =
  /** The file is not there: "no one holds it" (§4.2's first branch). */
  | { kind: 'missing' }
  /**
   * The file is there but is not JSON, or says something unusable → stale (§8).
   * `reason` only distinguishes "unreadable path" (`EACCES`, `EROFS`, …), which
   * the decision layer turns into the degraded branch, from a broken record.
   */
  | { kind: 'invalid'; reason: LeaseReadFailure }
  /** A well-formed record. Whether it is *stale* is the decision layer's call. */
  | { kind: 'ok'; record: LeaseRecord };

/** Why a lease file could not be used. */
export type LeaseReadFailure = 'unreadable' | 'malformed';

/** A window's request to take the lease over (§2.3, §12.10: `<lease>.claim.<pid>`). */
export interface ClaimRequest {
  version: number;
  /** Requester pid. */
  pid: number;
  /**
   * Whether the requester claims to be focused. A window writes `true` only
   * after the debounce H, and the owner only steps down for a focused
   * requester — never for "nobody is looking" (§2.3).
   */
  focused: boolean;
  /** Optional human-readable label, for the stage-2 diagnostics. */
  windowId?: string;
  /** `Date.now()` when the request was written. */
  at: number;
}

/** The result of reading one claim-request file. */
export type ClaimRequestRead = { kind: 'ok'; request: ClaimRequest } | { kind: 'invalid' };

/** A claim request as found on disk by the IO layer. */
export interface ClaimRequestObservation {
  request: ClaimRequest;
  /** The file's mtime; the tie-breaker when two requests share a timestamp. */
  mtimeMs: number;
  /**
   * The random token from the file name (`<lease>.claim.<pid>.<token>`) — the
   * file name's pid alone cannot tell two requests by a recycled pid apart.
   */
  token: string;
  /** The file's base name, for the diagnostics listing (§11.1 stage 2). */
  fileName: string;
}

/** Outcome of a claim attempt (§4.2's `claim()`). */
export type ClaimOutcome =
  /**
   * `wx` created the file **and** the record was published: this window is the
   * owner and every other window can read the `ownerNonce` that proves it.
   */
  | 'claimed'
  /**
   * `wx` created the file — the mutex is this window's, and no other window can
   * claim it — but writing the record failed, so a reader finds an empty (or
   * truncated) file instead of a record (§3.2, §4.2). The caller is still the
   * owner and must keep republishing; **the file existing is not the same as
   * the lease being published**, and the two states need different actions: a
   * published lease is refreshed, an unpublished one is repaired.
   */
  | 'claimed-unpublished'
  /** The file already exists: another window holds it (or just did) — stay follower. */
  | 'contended'
  /** The mechanism itself is unusable (`EACCES`, `EROFS`, `ENOSPC`, …) → §8. */
  | 'unavailable';

/** Outcome of one heartbeat refresh, or of republishing an unpublished record. */
export type HeartbeatOutcome =
  /** Fresh `heartbeatAt` written (or the record that never landed is now published). */
  | 'written'
  /** Someone else owns the lease now: the caller must degrade (§4.1.2). */
  | 'not-owner'
  /** The lease is gone from under us: treat as not owner. */
  | 'missing'
  /** Every attempt failed; the caller records a failure (§4.1, §8). */
  | 'failed'
  /** The mechanism is unusable → §8's degraded branch. */
  | 'unavailable';

/** Outcome of a voluntary yield / stale-lease release. */
export type ReleaseOutcome =
  /** The lease was ours (or verifiably stale) and is gone now. */
  | 'released'
  /** Either way, there is no lease at that path now; nothing to do. */
  | 'missing'
  /** The lease exists but is not ours (or not stale): left untouched, by design. */
  | 'not-owner'
  /** The unlink failed for a reason worth reporting. */
  | 'failed';

/**
 * The last handover this window took part in (§7.1's "who is polling, and when
 * did it last change hands", §11.1 stage 2's `handover` group).
 *
 * It is recorded on both sides of a handover — the window that took the lease
 * and the window that gave it up — because the interesting number differs: for
 * a takeover it is how long the trigger (a focus request, or an observed-gone
 * holder) took to become ownership, and for a yield it is how long the
 * requester's request sat before this window let go.
 *
 * **`reason` and `latencyMs` are both "as this window saw it", and both are
 * always accurate about what they claim.** The two sides of one handover can
 * legitimately record different reasons — the window that lost the lease sees
 * "another window took it", the window that took it sees why it decided to —
 * which is why the takeover reason is derived from the decision rather than
 * guessed from the file that happens to be left on disk.
 */
export interface LeaseHandoverRecord {
  direction: 'takeover' | 'step-down';
  /** The closed vocabulary §11.1 stage 2 names; `force` is §7.2's command. */
  reason: 'focus' | 'expiry' | 'close' | 'force';
  /** `Date.now()` when this window became / stopped being the owner. */
  at: number;
  /**
   * Measured from the trigger condition holding to the ownership change — see
   * the per-path definition in `leaseSupervisor.ts`.
   *
   * `null` when this window genuinely cannot see the trigger (§11.1 stage 2
   * follow-up): a handover observed only as "the lease file is gone" says
   * nothing about *when* the predecessor let go, and a window releasing a lease
   * it never held has nothing to measure from. A `0` in that position used to
   * be reported instead, which a reader cannot tell apart from "instantaneous"
   * — the worst possible answer for the crash path this field exists to
   * diagnose. When it is `null`, `latencyUnknown` says why.
   */
  latencyMs: number | null;
  /** Why `latencyMs` is `null`; `null` when there is a measurement. */
  latencyUnknown: 'predecessor-release-time-unobservable' | 'no-trigger-recorded' | null;
  /** The other window's pid, when it is knowable. */
  counterpartPid: number | null;
  /** Claim requests this window sent for this handover (the K counter, §2.3). */
  requestCount: number;
}
