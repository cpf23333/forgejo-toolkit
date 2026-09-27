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
  /** "deactivate" / "takeover-requested" / "stepped-down"; null while held. */
  releaseReason: string | null;
  appVersion: string;
  /** Fingerprint of the instance set; a change never triggers an election (§3.3). */
  instancesFingerprint: string;
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
  /** `wx` created the file: this window is the owner. */
  | 'claimed'
  /** The file already exists: another window holds it (or just did) — stay follower. */
  | 'contended'
  /** The mechanism itself is unusable (`EACCES`, `EROFS`, `ENOSPC`, …) → §8. */
  | 'unavailable';

/** Outcome of one heartbeat refresh. */
export type HeartbeatOutcome =
  /** Fresh `heartbeatAt` written. */
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
