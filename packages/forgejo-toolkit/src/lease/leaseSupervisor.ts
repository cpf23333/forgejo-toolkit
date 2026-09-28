/**
 * The multi-window polling lease's supervisor: stage 2, the release that turns
 * the election into behaviour (§11.1 stage 2).
 *
 * It owns every timer, every `vscode` touch and every write, so the decision
 * layer stays the clock-free, editor-free function `leaseDecision.ts` is. Each
 * tick it assembles a `LeaseDecisionInput` from real state — its own nonce, pid
 * and focus, the lease it just read, the holder's pid liveness, its own
 * heartbeat-write failure counters and its own unanswered claim requests —
 * calls `decideLeaseAction`, and then acts.
 *
 * **What stage 2 adds is one output and nothing else**: `mayPoll()`, the
 * `LeasePollingGate` the notification poller consults before every round
 * (`leasePollingGate.ts`). The rule it implements is §8's safety rail, stated
 * once:
 *
 * - the setting off, the mechanism degraded, the election not running, no
 *   decision yet, a decision whose action polls locally, or a tick that threw
 *   ⇒ **poll**;
 * - only a decision of `inactive` — a valid, live, non-stale lease held by
 *   another window, which the pure layer reaches for nothing else — closes the
 *   gate.
 *
 * In other words the gate is `decisionPollsLocally` plus every uncertainty, and
 * "only the owner polls" can only ever be entered from a *confirmed* follower.
 * A transition `false → true` notifies gate listeners, which is what makes a
 * window that has just became the owner poll immediately instead of waiting out
 * the interval.
 *
 * The setting itself (`forgejoToolkit.multiWindowLease`, default on) is read on
 * every start and on every change to it: with it off the election is not merely
 * ignored, it is **stopped** — the timer and the focus subscription go away and
 * this window releases any lease it held — because a window that keeps
 * heartbeating while the user asked for "every window polls for itself" would
 * hold the lease against the windows that did not opt out.
 *
 * Two cadences, deliberately kept apart (§2.3, and the module comment in
 * `leaseConstants.ts`):
 *
 * - the **tick** is `LEASE_CLAIM_TICK_MS` (2 s): read the lease, re-read the
 *   focus state, decide, maybe publish a claim request. This is the cadence
 *   that bounds a handover at K ticks;
 * - the **heartbeat** is `LEASE_HEARTBEAT_MS` (10 s) *since the last successful
 *   write*, checked from inside the tick. One timer, two layers — never one
 *   constant: the heartbeat's 10 s would silently stretch the worst-case
 *   handover from ~6 s to ~30 s (§2.3).
 *
 * Focus is read twice on purpose (§2.3 prerequisite 1, mandatory): the
 * `onDidChangeWindowState` event starts the H clock precisely and reports the
 * transition, and **every tick also reads `vscode.window.state.focused`
 * directly** — a platform that drops or delays the event then costs at most one
 * tick, never the handover. A focus change the event did not report is logged
 * with `source=tick-fallback missedEvent=1`, which is the measurement that says
 * whether that prerequisite was needed.
 *
 * Log lines follow §7.1: every one carries the role the diagnostics schema
 * names (`leader` / `follower` / `degraded`), the action, `pid`, the nonce's
 * first 8 characters, the focus state, the focused-for duration, the tick's
 * epoch time and — new in stage 2 — `polling=unchanged|suppressed`, which is
 * the gate as it stood for that line. Ownership events and focus-driven
 * decisions are `info`; everything else is `debug`, and a decision that repeats
 * is silent until it changes (or for one `debug` trace line a minute), because
 * "healthy is quiet" is what makes a soak readable (§3.5).
 */

import * as vscode from 'vscode';
import {
  LEASE_CLAIM_TICK_MS,
  LEASE_EXPIRY_MS,
  LEASE_FOCUS_DEBOUNCE_H_MS,
  LEASE_HANDOVER_HYSTERESIS_N_MS,
  LEASE_HEARTBEAT_MS,
  LEASE_OWNER_STEP_DOWN_MS,
  LEASE_UNANSWERED_REQUEST_LIMIT_K,
} from './leaseConstants';
import {
  claimRequestBackoffMs,
  decideLeaseAction,
  decisionPollsLocally,
  selectCurrentClaimRequest,
  type LeaseDecision,
  type LeaseDecisionInput,
  type LeaseDecisionReason,
} from './leaseDecision';
import type { LeasePollingGate } from './leasePollingGate';
import { LeaseStore, instanceSetFingerprint, noncePrefix, type LeaseInspection } from './leaseStore';
import type { ClaimRequestObservation, LeaseHandoverRecord, LeaseRead, LeaseRecord } from './leaseTypes';

/**
 * The one role vocabulary: the diagnostics schema of §11.1 stage 2 and every
 * log line use these three names, so a user pasting a log and a user pasting
 * the diagnostics JSON are describing the same thing.
 */
export type LeaseRole = 'leader' | 'follower' | 'degraded';

/** The setting that owns the whole mechanism (§2 decision 6: default on). */
export const LEASE_ENABLED_SETTING = 'forgejoToolkit.multiWindowLease';

/**
 * Whether the lease may run in this window, read live rather than cached.
 *
 * Like `mcpServerProvider.isMcpServerEnabled`, the raw value is read as
 * `unknown` and anything but an explicit `false` keeps the default (on): a
 * hand-edited `settings.json` must not be able to throw inside activation.
 */
export function isMultiWindowLeaseEnabled(): boolean {
  const raw: unknown = vscode.workspace.getConfiguration('forgejoToolkit').get('multiWindowLease');
  return raw !== false;
}

/**
 * Everything the supervisor needs from the editor, as a narrow port. The
 * production implementation is `vscodeWindowLeaseHost()`; tests supply a fake,
 * which is why no test has to stand up a real window.
 */
export interface LeaseHost {
  /** `vscode.window.state.focused`, read synchronously on every tick (§2.3). */
  isFocused(): boolean;
  /** `vscode.window.onDidChangeWindowState`, reduced to its `focused` flag. */
  onDidChangeFocus(listener: (focused: boolean) => void): { dispose(): void };
}

/** The slice of `Logger` this module uses. */
export interface LeaseLogger {
  info(message: string): void;
  debug(message: string): void;
}

/** Everything the supervisor needs to exist. */
export interface LeaseSupervisorOptions {
  /** `<globalStorageUri.fsPath>`: where the lease lives (§3.1). */
  directory: string;
  logger: LeaseLogger;
  /** Defaults to the real `vscode.window` read (§2.3). */
  host?: LeaseHost;
  /** Injectable for tests; defaults to a `LeaseStore` for `directory`. */
  store?: LeaseStore;
  /** Injectable epoch-ms clock; defaults to `Date.now` (§6: epoch ms only). */
  now?: () => number;
  /** Optional label for the record's `windowId` (§3.2). */
  windowId?: string;
  /** The running extension's version, stamped into the record (§3.2). */
  appVersion?: string;
  /**
   * The identifiers of the configured instances, as the config exposes them
   * (§3.2, §3.3). Read only when a record is about to be written, and hashed
   * with `instanceSetFingerprint`; it never reaches the decision layer.
   */
  instanceIds?: () => readonly string[];
  /** `forgejoToolkit.multiWindowLease`, read live; defaults to the real setting. */
  isLeaseEnabled?: () => boolean;
  /** Subscribes to changes of that setting; defaults to the real event. */
  onDidChangeSettings?: (listener: () => void) => { dispose(): void };
  /**
   * Called **once per session** when this window gives the mechanism up and
   * falls back to full-speed polling (§7.1's one-time notice). The supervisor
   * does not show anything itself: the notice is UI, and its wording lives with
   * the other localized host messages.
   */
  onDegraded?: (cause: string) => void;
}

/** The fields of one log line, in the order they are rendered. */
export interface LeaseLogFields {
  role: LeaseRole;
  action: string;
  reason: string;
  pid: number;
  /** `noncePrefix(ownerNonce)`: the first 8 characters, as §7.1 requires. */
  noncePrefix: string;
  focused: boolean;
  focusedForMs: number;
  /** `Date.now()`-style epoch ms of the tick that decided this (§6). */
  at: number;
  /** The gate as it stands for this line: `unchanged` polls, `suppressed` does not. */
  polling: 'unchanged' | 'suppressed';
  extra?: Record<string, string | number | boolean>;
}

/**
 * The tag every line starts with, so a soak can grep one prefix. (Stage 1
 * called it `lease-shadow`; stage 2 is the behaviour release, so the lines a
 * user pastes from `showLog` say what the mechanism is.)
 */
const LEASE_LOG_PREFIX = 'lease';

/**
 * How often an *unchanged* decision is repeated at `debug` level. The soak
 * evidence is the transitions; this is only a liveness trace, and one line a
 * minute keeps it out of the way of the events that matter.
 */
const TRACE_INTERVAL_MS = 60_000;

/**
 * The decision reasons a focus change could have caused (§2.3). These are
 * reported at `info` even when nothing changed, because they are what H and N
 * are calibrated from: how often a focused window asked, and how often an owner
 * refused. Every other reason is `debug` unless it changes ownership.
 */
const FOCUS_DRIVEN_REASONS: ReadonlySet<string> = new Set([
  'owner-yield-focus-request',
  'owner-keep-focused',
  'owner-keep-requested-unfocused',
  'owner-keep-requested-stale',
  'owner-keep-hysteresis',
]);

/** The actions that change (or give up) ownership: always `info` (§7.1). */
const OWNERSHIP_ACTIONS: ReadonlySet<string> = new Set(['claim', 'yield', 'step-down', 'degraded-to-full-speed']);

/**
 * Render one line: `lease key=value …`, fixed key order, extras in the order
 * the caller listed them, and the gate last.
 *
 * `polling=` is the stage-2 contract made visible: `unchanged` means this
 * window polls and alerts exactly as it does with the setting off, and
 * `suppressed` means it does not, because a healthy follower decision closed
 * the gate. It is the field a soak greps to see the mechanism work, and the
 * field a bug report shows.
 */
export function formatLeaseLogLine(fields: LeaseLogFields): string {
  const parts = [
    `role=${fields.role}`,
    `action=${fields.action}`,
    `reason=${fields.reason}`,
    `pid=${fields.pid}`,
    `nonce=${fields.noncePrefix}`,
    `focused=${fields.focused ? 1 : 0}`,
    `focusedForMs=${Math.round(fields.focusedForMs)}`,
    `at=${fields.at}`,
  ];
  for (const [key, value] of Object.entries(fields.extra ?? {})) {
    parts.push(`${key}=${value}`);
  }
  parts.push(`polling=${fields.polling}`);
  return `${LEASE_LOG_PREFIX} ${parts.join(' ')}`;
}

/** The `vscode.window`-backed host: the only place this module reads the editor. */
export function vscodeWindowLeaseHost(): LeaseHost {
  return {
    isFocused: () => vscode.window.state.focused,
    // `WindowState.focused` is the whole of the event this stage needs; the
    // subscription is disposed with the supervisor (§2.3).
    onDidChangeFocus: (listener) => vscode.window.onDidChangeWindowState((state) => listener(state.focused)),
  };
}

/** VS Code has no stable window id, so the record carries a readable label (§3.2). */
function defaultWindowLabel(): string | undefined {
  return vscode.workspace.name;
}

/**
 * The diagnostic reason for a takeover's decision (§11.1 stage 2's closed
 * `focus | expiry | close | force` vocabulary). A missing file means the holder
 * let go (`close`); an aged-out or dead-holder record and the K escalation mean
 * the holder stopped proving it was alive (`expiry`). Pure and exported so the
 * mapping can be asserted directly instead of inferred from a log line.
 */
export function takeoverReason(reason: LeaseDecisionReason): LeaseHandoverRecord['reason'] {
  if (reason === 'follower-takeover-absent') {
    return 'close';
  }
  if (reason === 'follower-takeover-expired' || reason === 'follower-takeover-accelerated') {
    return 'expiry';
  }
  // Nothing else reaches a claim today; naming it `force` keeps the union total
  // rather than silently mislabelling a future claim path as a clean close.
  return 'force';
}

/**
 * The reason for a *demotion* — this window was the owner and is not any more
 * (§4.1.2). Not the takeover's vocabulary: the holder that lost the lease sees
 * a different question than the one that took it.
 *
 * - `owner-changed`: the record stopped being ours, i.e. another window
 *   displaced us. The lease really did expire from this window's side (that is
 *   what let the other window take it), so `expiry` is the accurate label.
 * - `lease-missing`: the file is gone. Either the holder released it — us,
 *   which `demote` can only see as "it is not there any more" — or something
 *   outside this extension removed it. `close` is the vocabulary's word for
 *   "the previous holder let go", and it is the one the takeover side uses for
 *   the same observation, so both windows of that handover agree.
 */
export function demotionReason(reason: 'owner-changed' | 'lease-missing'): LeaseHandoverRecord['reason'] {
  return reason === 'owner-changed' ? 'expiry' : 'close';
}

/** One tick's state, as the logging needs it. */
interface TickContext {
  now: number;
  focused: boolean;
  /** Always 0 while unfocused; otherwise the tick's focus duration. */
  focusedForMs: number;
  read?: LeaseRead;
  holderPidAlive?: boolean | undefined;
  /** The newest pending request, for the would-be-handover fields. */
  pending?: ClaimRequestObservation | undefined;
  claimRequestCount: number;
  /** Every request file this tick read, for the owner's housekeeping. */
  observations: readonly ClaimRequestObservation[];
  /**
   * When this window first observed the lease's holder gone (§11.1 stage 2's
   * handover latency). Set on the tick that first saw a dead-holder or
   * aged-out record and carried across ticks until a claim succeeds, so the
   * reported figure is measured from the observation — never from the decision
   * that happened to exploit it, which would hide exactly the delay (the K
   * escalation's two ticks, the expiry wait) a soak is trying to measure.
   */
  holderGoneAt?: number | undefined;
}

/** The sync half of what the diagnostics command reports (§11.1 stage 2). */
export interface LeaseSupervisorSnapshot {
  role: LeaseRole;
  focused: boolean;
  pid: number;
  ownerNonce: string;
  extensionHostStartedAt: number;
  lastHeartbeatWrittenAt?: number;
  consecutiveHeartbeatFailures: number;
  degraded: boolean;
  degradedCause?: string;
  degradedSince?: number;
  /** Whether the one-time §7.1 notice has been shown in this session. */
  noticeShown: boolean;
  handover: LeaseHandoverRecord | null;
  leaseEnabled: boolean;
  mayPoll: boolean;
}

/** Applies a claim, heartbeat, yield or step-down and its bookkeeping. */
export class LeaseSupervisor implements LeasePollingGate {
  private readonly logger: LeaseLogger;
  private readonly host: LeaseHost;
  private readonly store: LeaseStore;
  private readonly clock: () => number;
  /** The configured instance identifiers, read when a record is written (§3.3). */
  private readonly instanceIds: () => readonly string[];
  private readonly isEnabled: () => boolean;
  private readonly onDidChangeSettings: (listener: () => void) => { dispose(): void };
  private readonly onDegraded: ((cause: string) => void) | undefined;
  private readonly extensionHostStartedAt: number;

  private timer?: NodeJS.Timeout;
  private focusSubscription?: { dispose(): void };
  private settingsSubscription?: { dispose(): void };
  /** Bumped by `dispose()`/`stopElection()`; an older tick must not write. */
  private generation = 0;
  private started = false;
  private disposed = false;
  private tickInFlight?: Promise<void>;
  /** The in-flight setting-off teardown, so a start can wait it out (§2.1). */
  private stopping?: Promise<void>;
  /** True while the election is running, i.e. while the setting is on. */
  private electionRunning = false;

  private currentRole: LeaseRole = 'follower';
  private focusObserved = false;
  private focused = false;
  private focusedSince?: number;

  /** `consecutiveFailures` / `failureSince` of §4.1, fed to the pure layer. */
  private heartbeatFailures = 0;
  private heartbeatFailureSince?: number;
  /** When the last heartbeat write was *attempted*; the 10 s gate (§4.1). */
  private heartbeatAttemptedAt?: number;
  /** When a record write last landed, for the diagnostics (§11.1 stage 2). */
  private heartbeatWrittenAt?: number;

  /** The follower's K counter and anti-storm anchor (§2.3, §12.10). */
  private unansweredRequests = 0;
  private lastRequestAt?: number;
  /** `now` of the first request of the current unanswered streak (the K trigger). */
  private requestStreakStartedAt?: number;
  /**
   * Whether the streak was started against a holder this window had already
   * observed gone. It decides which trigger the accelerated takeover's latency
   * is measured from: the *holder* going away (the honest answer for a crash,
   * and the number a soak wants) or this window's first request.
   */
  private requestStreakFromDeadHolder = false;
  /** When this window first observed the current holder gone (see TickContext). */
  private holderGoneAt?: number;
  /**
   * When this window first read a lease record that was no longer its own,
   * while it still believed it was the owner (§4.1.2's demotion latency). The
   * demotion itself happens on a later tick — the heartbeat cadence is what
   * notices a vanished file — and that gap is the interesting number.
   */
  private ownerLeaseGoneAt?: number;
  /** Latches the one-per-streak report of a failed request retirement (§12.10). */
  private requestRetirementFailed = false;

  private degraded = false;
  private degradedCause?: string;
  private degradedSince?: number;
  private noticeShown = false;
  private handover: LeaseHandoverRecord | null = null;

  /**
   * The gate as published to `mayPoll()`. It starts open — "no decision yet"
   * polls (§8) — and is recomputed after every decision and every tick failure.
   */
  private pollAllowed = true;
  private decisionSettled = false;
  private readonly gateListeners = new Set<(mayPoll: boolean) => void>();

  private lastDecision?: LeaseDecision;
  private lastDecisionSignature?: string;
  private lastDecisionLogAt = 0;

  constructor(options: LeaseSupervisorOptions) {
    this.logger = options.logger;
    this.host = options.host ?? vscodeWindowLeaseHost();
    this.clock = options.now ?? (() => Date.now());
    this.instanceIds = options.instanceIds ?? (() => []);
    this.isEnabled = options.isLeaseEnabled ?? isMultiWindowLeaseEnabled;
    this.onDidChangeSettings =
      options.onDidChangeSettings ??
      ((listener) =>
        vscode.workspace.onDidChangeConfiguration((event) => {
          if (event.affectsConfiguration(LEASE_ENABLED_SETTING)) {
            listener();
          }
        }));
    this.onDegraded = options.onDegraded;
    this.extensionHostStartedAt = this.clock();
    this.store =
      options.store ??
      new LeaseStore({
        directory: options.directory,
        windowId: options.windowId ?? defaultWindowLabel(),
        ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      });
  }

  /** The role §11.1's diagnostics would report right now. */
  get role(): LeaseRole {
    return this.currentRole;
  }

  /** This window's focus state as of the last read (event or tick). */
  get focusedNow(): boolean {
    return this.focused;
  }

  /** The last decision, for the stage-2 diagnostics and for tests. */
  get decision(): LeaseDecision | undefined {
    return this.lastDecision;
  }

  /** Whether the one-time degradation notice has been shown (§7.1). */
  get degradationNoticeShown(): boolean {
    return this.noticeShown;
  }

  /** The last handover this window took part in, or null (§11.1 stage 2). */
  get lastHandover(): LeaseHandoverRecord | null {
    return this.handover;
  }

  /**
   * Whether this window must poll and alert right now (§8).
   *
   * The whole safety rail is this method: everything except a *confirmed*
   * healthy follower polls. A caller that cannot reach the lease at all should
   * treat the answer as `true` — that is what "no gate" means to the poller.
   */
  mayPoll(): boolean {
    return this.computeMayPoll();
  }

  /**
   * Registers a gate listener. The `false → true` transition is the signal a
   * window that has just become the owner uses to poll immediately instead of
   * waiting out the current interval.
   */
  onDidChange(listener: (mayPoll: boolean) => void): { dispose(): void } {
    this.gateListeners.add(listener);
    return {
      dispose: () => {
        this.gateListeners.delete(listener);
      },
    };
  }

  /** The sync state the diagnostics command reports (see `pollingDiagnostics.ts`). */
  snapshot(): LeaseSupervisorSnapshot {
    return {
      role: this.currentRole,
      focused: this.focused,
      pid: this.store.processId,
      ownerNonce: this.store.nonce,
      extensionHostStartedAt: this.extensionHostStartedAt,
      ...(this.heartbeatWrittenAt === undefined ? {} : { lastHeartbeatWrittenAt: this.heartbeatWrittenAt }),
      consecutiveHeartbeatFailures: this.heartbeatFailures,
      degraded: this.degraded,
      ...(this.degradedCause === undefined ? {} : { degradedCause: this.degradedCause }),
      ...(this.degradedSince === undefined ? {} : { degradedSince: this.degradedSince }),
      noticeShown: this.noticeShown,
      handover: this.handover,
      leaseEnabled: this.isEnabled(),
      mayPoll: this.computeMayPoll(),
    };
  }

  /** One read of the lease file and its neighbourhood, for the diagnostics. */
  async inspect(): Promise<LeaseInspection> {
    return this.store.inspect();
  }

  /**
   * Begins the election: subscribes to the focus event and to the setting, and
   * starts the election itself — or does not, when the setting is off, in which
   * case this window polls exactly as it did before the lease existed.
   */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.settingsSubscription = this.onDidChangeSettings(() => this.syncEnabled());
    this.syncEnabled();
  }

  /**
   * Re-reads the setting and starts or stops the election accordingly. Called
   * once at `start()` and on every change of the setting, so turning the lease
   * off (or back on) takes effect without a window reload.
   */
  private syncEnabled(): void {
    if (this.disposed) {
      return;
    }
    if (!this.isEnabled()) {
      if (this.electionRunning) {
        const run = this.stopElection().catch((error: unknown) => {
          // The teardown already reports its own failures; this only keeps a
          // rejected teardown from surfacing as an unhandled rejection.
          this.logger.debug(`lease stop failed: ${errorCode(error) ?? 'unknown'}`);
        });
        this.stopping = run;
        void run.finally(() => {
          if (this.stopping === run) {
            this.stopping = undefined;
          }
        });
        return;
      }
      // Deliberately debug: a user who turned the setting off does not need a
      // line about it on every window start, but "why is this window quiet?"
      // is answerable from the log.
      this.logger.debug(`${LEASE_ENABLED_SETTING} is off; this window polls on its own.`);
      return;
    }
    if (this.electionRunning) {
      return;
    }
    if (this.stopping !== undefined) {
      // A fast off→on toggle: wait for the teardown to finish releasing the
      // old lease, or the release could unlink a lease the new election has
      // just claimed.
      void this.stopping.then(() => this.syncEnabled());
      return;
    }
    this.startElection();
  }

  /** Starts the election proper (setting on): focus subscription, tick, first decision. */
  private startElection(): void {
    this.electionRunning = true;
    // A fresh election has no decided state yet: the gate stays open until a
    // tick says otherwise (§8).
    this.decisionSettled = false;
    this.currentRole = 'follower';
    // Subscribe before the first read so a focus change between the two is not
    // lost between the event and the tick fallback.
    this.focusSubscription = this.host.onDidChangeFocus((focused) => this.onFocusChange(focused));
    const now = this.clock();
    const focused = this.readFocus();
    this.logger.info(
      this.line({ now, focused, focusedForMs: 0, claimRequestCount: 0, observations: [] }, 'start', 'lease-mode', {
        leasePath: this.store.leasePath,
        tickMs: LEASE_CLAIM_TICK_MS,
        heartbeatMs: LEASE_HEARTBEAT_MS,
        hMs: LEASE_FOCUS_DEBOUNCE_H_MS,
        nMs: LEASE_HANDOVER_HYSTERESIS_N_MS,
        k: LEASE_UNANSWERED_REQUEST_LIMIT_K,
      }),
    );
    this.syncFocus(focused, now, 'start');
    const timer = setInterval(() => {
      void this.tick();
    }, LEASE_CLAIM_TICK_MS);
    // §3.5: an unref'd timer can never keep a window (or anything else that
    // loads this module) alive for an election that only matters while a
    // window is there to take part in it.
    timer.unref();
    this.timer = timer;
    void this.tick();
  }

  /**
   * Stops the election because the setting went off (§2.1's "turn this off to
   * let every window poll on its own"): the timer and the focus subscription go
   * away, this window releases any lease it still holds — after the ownership
   * check every release uses, so a successor is never fought — and the gate
   * opens, because from here on this window polls exactly as it does with the
   * mechanism switched off.
   */
  private async stopElection(): Promise<void> {
    if (!this.electionRunning) {
      return;
    }
    this.electionRunning = false;
    this.generation += 1;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.focusSubscription?.dispose();
    this.focusSubscription = undefined;
    await this.tickInFlight?.catch(() => undefined);
    const now = this.clock();
    const wasLeader = this.currentRole === 'leader';
    let released: Awaited<ReturnType<LeaseStore['cleanup']>>;
    try {
      released = await this.store.cleanup();
    } catch (error) {
      released = { lease: 'failed', claimRequest: 'failed' };
      this.logger.debug(`lease stop failed: ${errorCode(error) ?? 'unknown'}`);
    }
    this.currentRole = 'follower';
    this.resetOwnerState();
    this.resetFollowerRequestState();
    if (wasLeader) {
      this.recordHandover({
        direction: 'step-down',
        reason: 'close',
        at: now,
        // The release itself is the whole event and it has already happened;
        // `0` here is a measurement (the unlink completed in this call), not a
        // placeholder for "unknown".
        latencyMs: 0,
        latencyUnknown: null,
        counterpartPid: null,
        requestCount: 0,
      });
    }
    this.logger.info(
      this.line(this.contextFor(now), 'stop', 'setting-off', {
        wasRole: wasLeader ? 'leader' : 'follower',
        lease: released.lease,
        claimRequest: released.claimRequest,
      }),
    );
    this.syncPollingGate();
  }

  /**
   * Stops the election and gives up this window's lease (§5's `deactivate()`
   * path). Idempotent. After it resolves the supervisor touches the lease
   * never again: the timer is cleared, the focus subscription is disposed, a
   * tick already in flight is awaited and refuses to write (see `stale`), and
   * the release itself re-reads the lease and only unlinks it while the nonce
   * is still ours — so cleanup can never fight a window that has taken over.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const wasRunning = this.electionRunning;
    this.disposed = true;
    this.electionRunning = false;
    this.generation += 1;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.focusSubscription?.dispose();
    this.focusSubscription = undefined;
    this.settingsSubscription?.dispose();
    this.settingsSubscription = undefined;
    const wasStarted = this.started;
    this.started = false;
    // A tick that was already past its last checkpoint must settle before the
    // release below, or a late claim could re-create the lease behind it
    // (mcpBroker's cleanup waits for its attempts for the same reason). A
    // setting-off teardown in flight is the same hazard, and it is awaited
    // first because it releases the lease itself.
    await this.stopping?.catch(() => undefined);
    await this.tickInFlight?.catch(() => undefined);
    if (!wasStarted) {
      return;
    }
    const now = this.clock();
    const wasLeader = wasRunning && this.currentRole === 'leader';
    try {
      const released = await this.store.cleanup();
      if (wasLeader) {
        this.recordHandover({
          direction: 'step-down',
          reason: 'close',
          at: now,
          // The unlink completed in this call, so the latency is a real `0`
          // rather than the "not measurable" placeholder the yield paths use.
          latencyMs: 0,
          latencyUnknown: null,
          counterpartPid: null,
          requestCount: 0,
        });
      }
      this.logger.info(
        this.line(this.contextFor(now), 'release', 'dispose', {
          lease: released.lease,
          claimRequest: released.claimRequest,
        }),
      );
    } catch (error) {
      this.logger.debug(`lease release failed: ${errorCode(error) ?? 'unknown'}`);
    }
  }

  /** Resolves once the tick and any setting-off teardown in flight have settled. */
  async whenSettled(): Promise<void> {
    await this.stopping?.catch(() => undefined);
    await this.tickInFlight?.catch(() => undefined);
  }

  private onFocusChange(focused: boolean): void {
    if (this.disposed) {
      return;
    }
    this.syncFocus(focused, this.clock(), 'event');
  }

  /**
   * Records a focus state and logs the transition. `source` is the evidence
   * §2.3 prerequisite 1 asks for: `event` means the window state event arrived,
   * `tick` means it did not and the mandatory per-tick read caught it.
   */
  private syncFocus(focused: boolean, now: number, source: 'start' | 'event' | 'tick'): void {
    if (this.focusObserved && focused === this.focused) {
      return;
    }
    const first = !this.focusObserved;
    this.focusObserved = true;
    this.focused = focused;
    let focusedForMs = 0;
    if (focused) {
      this.focusedSince = now;
    } else {
      focusedForMs = this.focusedSince === undefined ? 0 : Math.max(0, now - this.focusedSince);
      this.focusedSince = undefined;
    }
    const context: TickContext = { now, focused, focusedForMs, claimRequestCount: 0, observations: [] };
    if (source === 'start' || first) {
      // The initial state, so a soak can read where the window started. No
      // "transition" happened yet, hence its own action name.
      this.logger.info(this.line(context, focused ? 'focus-gained' : 'focus-observed', 'start'));
      return;
    }
    const action = focused ? 'focus-gained' : 'focus-lost';
    const reason = source === 'tick' ? 'tick-fallback' : 'window-state';
    this.logger.info(this.line(context, action, reason, source === 'tick' ? { missedEvent: 1 } : {}));
  }

  private readFocus(): boolean {
    try {
      return this.host.isFocused();
    } catch {
      // A host that cannot answer reads as "not focused": §2.3 never lets
      // "nobody is looking" claim or keep leadership on its own.
      return false;
    }
  }

  private tick(): Promise<void> {
    if (this.disposed || this.tickInFlight !== undefined) {
      // Single flight: the previous tick's reads and writes are still running.
      // Dropping this one costs one tick, and the next is 2 s away.
      return this.tickInFlight ?? Promise.resolve();
    }
    const generation = this.generation;
    const run = this.runTick(generation).catch((error: unknown) => {
      // A failed tick leaves the lease state *unknown*, and §8's rail is that
      // uncertainty polls. Closing the gate on a successful decision and then
      // keeping it closed through a read failure would be exactly the "silent
      // window" the design forbids, so the gate opens until a decision lands
      // again. The next tick retries the same read either way.
      this.logger.debug(`lease tick failed: ${errorCode(error) ?? 'unknown'}`);
      if (!this.decisionSettled) {
        return;
      }
      this.decisionSettled = false;
      this.syncPollingGate();
    });
    this.tickInFlight = run;
    void run.finally(() => {
      if (this.tickInFlight === run) {
        this.tickInFlight = undefined;
      }
    });
    return run;
  }

  private stale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  /**
   * When this window first observed the lease's holder gone, or undefined while
   * it has no reason to think so (§11.1 stage 2's handover latency).
   *
   * Two observations set it, and they answer the same question — "since when do
   * we know the holder is not serving?":
   *
   * - a record whose pid is verifiably dead: the predecessor crashed. Nothing
   *   on disk says when, so this window's first sighting is the only anchor,
   *   and it is a *lower bound* on the real downtime; the field states it that
   *   way rather than pretending the crash timestamp is knowable;
   * - a record past `LEASE_EXPIRY_MS`: the expiry itself is the trigger, and it
   *   is knowable exactly (`heartbeatAt + LEASE_EXPIRY_MS`), so that is used
   *   even when this window started only afterwards.
   *
   * A live holder clears it, so a window that claims and later loses the lease
   * does not inherit a stale anchor from an earlier handover.
   */
  private recordHolderGone(context: TickContext, holderPidAlive: boolean | undefined): number | undefined {
    const holder = context.read?.kind === 'ok' ? context.read.record : undefined;
    const expired = holder !== undefined && context.now - holder.heartbeatAt >= LEASE_EXPIRY_MS;
    const gone = holder !== undefined && (holderPidAlive === false || expired);
    if (!gone) {
      this.holderGoneAt = undefined;
      return undefined;
    }
    if (this.holderGoneAt === undefined) {
      // An *expired* record carries its own trigger exactly
      // (`heartbeatAt + LEASE_EXPIRY_MS`); a dead pid does not, so the first
      // sighting is used — never the expiry, which for a holder that died just
      // after a heartbeat is still in the future and would make the reported
      // latency negative (and then clamped to a nonsense `0`).
      this.holderGoneAt = expired ? holder.heartbeatAt + LEASE_EXPIRY_MS : context.now;
    }
    return this.holderGoneAt;
  }

  /**
   * Records when this window first read a lease record that was not its own,
   * for the §4.1.2 demotion latency, and clears the anchor whenever the record
   * is ours again (a re-claim).
   *
   * The read that anchors it is the tick that saw the file gone or replaced —
   * not the heartbeat that later acted on it. Those are different moments on
   * purpose: the heartbeat cadence is 10 s, so the gap between "the record
   * disappeared" and "this window stopped believing it owned the lease" is
   * exactly the delay a user's "notifications stopped" report is about.
   */
  private recordOwnLeaseGone(context: TickContext, record: LeaseRecord | undefined): void {
    if (record !== undefined && record.ownerNonce === this.store.nonce) {
      this.ownerLeaseGoneAt = undefined;
      return;
    }
    // Only a window that believes it holds the lease can *lose* one; for a
    // follower every read is somebody else's record and none of them is a
    // trigger.
    this.ownerLeaseGoneAt ??= this.currentRole === 'leader' ? context.now : undefined;
  }

  /** One tick: read everything, decide, act, then publish the gate. */
  private async runTick(generation: number): Promise<void> {
    const now = this.clock();
    // §2.3 prerequisite 1: read the focus state here as well as from the event.
    const focused = this.readFocus();
    this.syncFocus(focused, now, 'tick');
    if (this.stale(generation)) {
      return;
    }
    const context: TickContext = {
      now,
      focused,
      focusedForMs: focused ? Math.max(0, now - (this.focusedSince ?? now)) : 0,
      claimRequestCount: 0,
      observations: [],
    };

    if (this.degraded) {
      // §8: the mechanism is given up for the session. Nothing is written; the
      // window polls exactly as it does today. `logDecision` dedupes this, so
      // the loop below costs one info line and then a trace line a minute.
      this.decisionSettled = true;
      this.syncPollingGate();
      this.logDecision(
        context,
        { action: 'degraded-to-full-speed', reason: 'lease-unavailable' },
        {
          cause: this.degradedCause ?? 'unknown',
          degradedSince: this.degradedSince ?? now,
        },
      );
      return;
    }

    const observation = await this.store.read();
    if (this.stale(generation)) {
      return;
    }
    const claimRequests = await this.store.readClaimRequests();
    if (this.stale(generation)) {
      return;
    }
    const holderPidAlive = await this.store.readHolderAlive(observation);
    if (this.stale(generation)) {
      return;
    }

    const read = observation.read;
    const record = read.kind === 'ok' ? read.record : undefined;
    context.read = read;
    context.holderPidAlive = holderPidAlive;
    context.holderGoneAt = this.recordHolderGone(context, holderPidAlive);
    this.recordOwnLeaseGone(context, record);
    context.claimRequestCount = claimRequests.length;
    context.observations = claimRequests;
    context.pending = selectCurrentClaimRequest(claimRequests, now, this.store.processId);

    const input: LeaseDecisionInput = {
      now,
      own: { ownerNonce: this.store.nonce, pid: this.store.processId, focused },
      lease: {
        // The store already reports an unusable path as
        // `invalid`/`unreadable`; this flag says the same thing explicitly for
        // the one read verdict that is not "no record" (§8).
        leasePathReadable: !(read.kind === 'invalid' && read.reason === 'unreadable'),
        lease: read,
        claimRequests,
        // The two states of §3.2/§4.2: a file that exists because this window
        // `wx`-created it, versus a lease that was actually published. Without
        // this the pure layer would read our own empty file as stale and try to
        // take it over — releasing it and re-creating it every tick.
        ownRecordUnpublished: this.store.holdsUnpublishedRecord,
      },
      holderPidAlive,
      ownerHealth: { consecutiveFailures: this.heartbeatFailures, failureSince: this.heartbeatFailureSince },
      ownClaimRequest: { consecutiveUnansweredRequests: this.unansweredRequests, lastRequestAt: this.lastRequestAt },
    };

    const decision = decideLeaseAction(input);
    this.lastDecision = decision;
    const degradedNow = decision.action === 'degraded-to-full-speed';
    if (degradedNow) {
      this.enterDegraded(now, 'read-unusable');
    }
    if (degradedNow) {
      // The action switch below is total, but this branch also decides the
      // session's fate: the gate opens (§8) and the one-time notice is due.
      this.decisionSettled = true;
      this.syncPollingGate();
      this.logDecision(context, decision, {
        cause: this.degradedCause ?? 'unknown',
        degradedSince: this.degradedSince ?? now,
      });
      return;
    }
    await this.applyDecision(context, decision, generation, record);
    if (this.stale(generation)) {
      return;
    }
    // Deliberately after the decision was *applied*: the gate follows the
    // outcome, not the intent. A `claim` that lost the `wx` race leaves this
    // window a follower, and a follower must not poll — reading the decision
    // instead of the role would keep the loser polling until the next tick.
    this.decisionSettled = true;
    this.syncPollingGate();
    this.logDecision(context, decision);
  }

  private async applyDecision(
    context: TickContext,
    decision: LeaseDecision,
    generation: number,
    ownRecord: LeaseRecord | undefined,
  ): Promise<void> {
    const { now, focused } = context;
    // Owner-side housekeeping (§2.3, §12.10): clearing what a dead requester
    // left behind is the owner's job — a follower must not touch another
    // window's request files. The owner is already looking at the directory, so
    // this costs no extra read.
    if (decision.action === 'keep-and-heartbeat' || decision.action === 'yield' || decision.action === 'step-down') {
      await this.pruneDeadClaimRequests(context, generation);
      if (this.stale(generation)) {
        return;
      }
    }
    switch (decision.action) {
      case 'claim': {
        // The honest record state is what decides here, not a retry latch:
        // `claimed-unpublished` puts this window in the owner branch on the next
        // tick (the pure layer reads `ownRecordUnpublished`), where the
        // heartbeat cadence retries the publish and the write-failure streak
        // bounds how long that may go on (§3.2, §4.2, §8).
        this.refreshInstancesFingerprint();
        if (decision.plan.mustReleaseStale) {
          // §4.2.3: release before claiming re-reads and re-checks staleness,
          // so a lease that became live in the meantime is left alone. The
          // accelerated branch also hands over the threshold and the identity
          // of the record it decided about (`staleRelease`), which is what lets
          // a live-but-silent holder be displaced at 30 s; every other claim
          // passes nothing and keeps the ordinary 35 s release.
          const released = await this.store.releaseStale(now, decision.plan.staleRelease);
          if (this.stale(generation)) {
            return;
          }
          this.logger.debug(
            this.line(context, 'release-stale', decision.reason, {
              outcome: released,
              ...(decision.plan.staleRelease === undefined
                ? {}
                : { releaseThresholdMs: decision.plan.staleRelease.thresholdMs }),
            }),
          );
        }
        const outcome = await this.store.claim(now);
        if (this.stale(generation)) {
          return;
        }
        await this.applyClaimOutcome(context, decision, outcome, generation);
        return;
      }
      case 'keep-and-heartbeat': {
        this.currentRole = 'leader';
        // The heartbeat is due on the *attempt* cadence, not on the last
        // success: a write that failed would otherwise be retried by every
        // 2 s tick and turn §4.1's measured write pressure into five times
        // what the design says (its own short retries already ran inside
        // `heartbeat()`).
        const due = this.heartbeatAttemptedAt === undefined || now - this.heartbeatAttemptedAt >= LEASE_HEARTBEAT_MS;
        if (!due) {
          // The tick is the 2 s layer; the heartbeat is the 10 s one (§2.3).
          return;
        }
        this.heartbeatAttemptedAt = now;
        // Read the instance set at write time, so the record a diagnostics dump
        // reads describes the instances this window actually polls now (§3.3).
        this.refreshInstancesFingerprint();
        const outcome = await this.store.heartbeat(now);
        if (this.stale(generation)) {
          return;
        }
        this.applyHeartbeatOutcome(context, outcome);
        return;
      }
      case 'yield': {
        const outcome = await this.store.yieldOwn();
        if (this.stale(generation)) {
          return;
        }
        this.currentRole = 'follower';
        this.resetOwnerState();
        this.resetFollowerRequestState();
        this.logger.info(
          this.line(context, 'yield', decision.reason, {
            outcome,
            wasRole: 'leader',
            ...(decision.yieldTo === undefined ? {} : { yieldToPid: decision.yieldTo.pid }),
            ...(ownRecord === undefined ? {} : { sinceClaimMs: Math.round(now - ownRecord.claimedAt) }),
            focusedForMs: Math.round(context.focusedForMs),
          }),
        );
        this.recordHandover({
          direction: 'step-down',
          reason: 'focus',
          at: now,
          // The trigger is the requester's own request: everything after it is
          // this window's reaction time, which is what §11.2 wants measured.
          latencyMs: decision.yieldTo === undefined ? 0 : Math.max(0, now - decision.yieldTo.at),
          latencyUnknown: null,
          counterpartPid: decision.yieldTo?.pid ?? context.pending?.request.pid ?? null,
          requestCount: context.claimRequestCount,
        });
        return;
      }
      case 'step-down': {
        const failures = this.heartbeatFailures;
        const failedForMs =
          this.heartbeatFailureSince === undefined ? 0 : Math.max(0, now - this.heartbeatFailureSince);
        // The trigger of this step-down, per §11.1 stage 2. Two causes, each
        // with its own knowable moment, so the reported figure is the real
        // latency from the decision to the completed release rather than a
        // blanket `0`:
        //
        // - a write-failure streak: the decision is taken when the streak
        //   reaches the grace window, so the trigger is exactly
        //   `heartbeatFailureSince + LEASE_OWNER_STEP_DOWN_MS`;
        // - a record that aged out with no write failure (a throttled timer, a
        //   laptop that slept): the trigger is the moment our own record
        //   crossed that same threshold.
        //
        // Read before the release, which clears the counters this is derived
        // from, and before the record the release removes.
        const ownHeartbeatAt = context.read?.kind === 'ok' ? context.read.record.heartbeatAt : undefined;
        const stepDownTriggerAt = Math.max(
          this.heartbeatFailureSince === undefined
            ? (ownHeartbeatAt ?? now) + LEASE_OWNER_STEP_DOWN_MS
            : this.heartbeatFailureSince + LEASE_OWNER_STEP_DOWN_MS,
          // Never in the future: the decision is taken no earlier than its own
          // threshold, and a threshold still ahead of `now` means one tick of
          // latency rather than a negative one.
          now,
        );
        // Read before the release: after it, the store has forgotten whether the
        // record ever landed.
        const wasUnpublished = this.store.holdsUnpublishedRecord;
        const outcome = await this.store.yieldOwn();
        if (this.stale(generation)) {
          return;
        }
        this.currentRole = 'follower';
        this.resetOwnerState();
        this.resetFollowerRequestState();
        this.logger.info(
          this.line(context, 'step-down', decision.reason, {
            outcome,
            failures,
            failedForMs: Math.round(failedForMs),
            stepDownMs: LEASE_OWNER_STEP_DOWN_MS,
            recordPublished: wasUnpublished ? 0 : 1,
          }),
        );
        this.recordHandover({
          direction: 'step-down',
          reason: 'expiry',
          at: now,
          // From the decision to the completed release: the writes above are
          // what it cost, and reporting `0` for that used to hide them.
          latencyMs: Math.max(0, now - stepDownTriggerAt),
          latencyUnknown: null,
          counterpartPid: null,
          requestCount: 0,
        });
        if (decision.reason === 'owner-step-down-unwritable') {
          // A full step-down window of failed writes is the mechanism itself
          // being unusable, not a hiccup: give it up for the session (§8) and
          // say so once, exactly like the unreadable-path degradation. The
          // lease is already released above, so nothing here can fight a window
          // that takes over.
          this.enterDegraded(now, 'record-write-failed');
        }
        return;
      }
      case 'inactive': {
        if (this.currentRole === 'leader') {
          // The record stopped being ours between two ticks (another window
          // took it over, or the file was replaced). Demotion is an ownership
          // event, so it is reported even though the decision itself is the
          // quiet follower branch.
          this.demote(context, 'owner-changed');
        }
        this.currentRole = 'follower';
        if (!focused) {
          return;
        }
        // H: a window must be continuously focused for this long before it
        // asks for the lease, so alt-tabbing back and forth is not "the user
        // is working here" (§2.3).
        if (context.focusedForMs < LEASE_FOCUS_DEBOUNCE_H_MS) {
          return;
        }
        // §2.3's cadence: the first K requests go out one per tick, which is
        // what bounds the K escalation at "K ticks ≈ 6 s"; only after K have
        // been ignored does the request cadence back off, so an owner that is
        // ignoring them can never be turned into a request storm.
        const delayMs = this.nextRequestDelayMs();
        if (this.lastRequestAt !== undefined && now - this.lastRequestAt < delayMs) {
          return;
        }
        await this.publishClaimRequest(context, generation);
        return;
      }
      case 'degraded-to-full-speed': {
        // Handled in `runTick` before the action switch; kept total on purpose.
        return;
      }
    }
  }

  private async applyClaimOutcome(
    context: TickContext,
    decision: Extract<LeaseDecision, { action: 'claim' }>,
    outcome: 'claimed' | 'claimed-unpublished' | 'contended' | 'unavailable',
    generation: number,
  ): Promise<void> {
    const { now } = context;
    if (outcome === 'unavailable') {
      // §8: the mechanism itself is unusable — give it up, keep polling.
      this.enterDegraded(now, 'claim-unavailable');
      return;
    }
    if (outcome === 'contended') {
      // Another window's `wx` won the race. Nothing is written; this window
      // stays a follower and re-evaluates on the next tick (§4.2.2).
      this.currentRole = 'follower';
      this.logger.debug(this.line(context, 'claim', decision.reason, { outcome }));
      return;
    }
    const previousHolder = context.read?.kind === 'ok' ? context.read.record : undefined;
    // Captured before `resetFollowerRequestState` below: the handover reports
    // the K counter as it stood when the escalation succeeded, and the reset
    // that clears it for the next streak is exactly what would zero it here.
    const requestCount = this.unansweredRequests;
    this.currentRole = 'leader';
    this.heartbeatAttemptedAt = now;
    this.heartbeatWrittenAt = now;
    this.resetFollowerRequestState();
    if (outcome === 'claimed-unpublished') {
      // The `wx` create stands, so this window is the owner, but the record
      // never landed: same write-failure bookkeeping as a failed heartbeat, so
      // the pure layer keeps it in the owner branch (via
      // `ownRecordUnpublished`) and steps it down after one step-down window of
      // unsuccessful publishes — with the accurate reason, and no second
      // release/unlink of our own file in between (§3.2, §4.2, §8).
      if (this.heartbeatFailures === 0) {
        this.heartbeatFailureSince = now;
      }
      this.heartbeatFailures += 1;
    } else {
      this.heartbeatFailures = 0;
      this.heartbeatFailureSince = undefined;
    }
    // Our own request is moot now; removing it (only after re-reading it) is
    // the same ownership check the yield path uses.
    const cleared = await this.store.clearClaimRequest();
    if (this.stale(generation)) {
      return;
    }
    this.logger.info(
      this.line(context, 'claim', decision.reason, {
        outcome,
        wasRole: 'follower',
        requestCleared: cleared,
        ...(decision.plan.requestedBy === undefined ? {} : { requestedByPid: decision.plan.requestedBy.pid }),
      }),
    );
    this.recordHandover(this.takeoverHandover(context, decision, previousHolder?.pid ?? null, requestCount));
    // The handover is complete and this window is the holder: whatever "the
    // holder is gone" meant a moment ago is settled, so the next handover must
    // measure from its own trigger rather than inherit this one's.
    this.holderGoneAt = undefined;
  }

  private applyHeartbeatOutcome(
    context: TickContext,
    outcome: 'written' | 'not-owner' | 'missing' | 'failed' | 'unavailable',
  ): void {
    const { now } = context;
    if (outcome === 'written') {
      const recovered = this.heartbeatFailures;
      const failedForMs = this.heartbeatFailureSince === undefined ? 0 : Math.max(0, now - this.heartbeatFailureSince);
      this.heartbeatFailures = 0;
      this.heartbeatFailureSince = undefined;
      this.heartbeatWrittenAt = now;
      if (recovered > 0) {
        // The streak's end is an event a soak needs; the writes themselves are
        // the healthy state and stay at debug (§7.1: healthy is quiet).
        this.logger.info(
          this.line(context, 'heartbeat', 'recovered', { failures: recovered, failedForMs: Math.round(failedForMs) }),
        );
      } else {
        this.logger.debug(this.line(context, 'heartbeat', 'written', { failures: 0 }));
      }
      return;
    }
    if (outcome === 'failed') {
      if (this.heartbeatFailures === 0) {
        this.heartbeatFailureSince = now;
      }
      this.heartbeatFailures += 1;
      const failedForMs = this.heartbeatFailureSince === undefined ? 0 : Math.max(0, now - this.heartbeatFailureSince);
      const message = this.line(context, 'heartbeat', 'write-failed', {
        failures: this.heartbeatFailures,
        failedForMs: Math.round(failedForMs),
        stepDownMs: LEASE_OWNER_STEP_DOWN_MS,
      });
      // The first failure of a streak is reported once; the rest until the
      // threshold are the retry window §4.1 documents, not news.
      if (this.heartbeatFailures === 1) {
        this.logger.info(message);
      } else {
        this.logger.debug(message);
      }
      return;
    }
    if (outcome === 'unavailable') {
      this.enterDegraded(now, 'heartbeat-unavailable');
      return;
    }
    // 'not-owner' / 'missing': §4.1.2, another window owns it now or the file
    // is gone. Demote; the next tick re-evaluates from scratch.
    this.demote(context, outcome === 'missing' ? 'lease-missing' : 'owner-changed');
  }

  /**
   * §4.1.2: the record is no longer ours — log it and start over as a follower.
   *
   * The recorded handover is the demotion side of the same event the next owner
   * reports as a takeover, so the reason comes from `demotionReason` (never a
   * blanket `expiry`).
   *
   * The latency is the real span from the moment this window *noticed* it no
   * longer held the lease (`ownerLeaseGoneAt`, recorded by the tick that read
   * the file) to this completed release: for the missing-file case that is the
   * gap between the disappearance of the record and the heartbeat that acted on
   * it, which is exactly the delay a "notifications stopped" report needs to
   * see. When the window was already a follower at the observation — it cannot
   * tell "I lost ownership just now" from "I never had it" — there is nothing
   * to measure and the payload says `no-trigger-recorded` instead of a `0`.
   */
  private demote(context: TickContext, reason: 'owner-changed' | 'lease-missing'): void {
    const previousRole = this.currentRole;
    const wasHoldingLease = previousRole === 'leader';
    this.currentRole = 'follower';
    this.resetOwnerState();
    this.resetFollowerRequestState();
    this.logger.info(this.line(context, 'demote', reason, { wasRole: previousRole }));
    this.recordHandover({
      direction: 'step-down',
      reason: demotionReason(reason),
      at: context.now,
      ...(wasHoldingLease
        ? { latencyMs: Math.max(0, context.now - (this.ownerLeaseGoneAt ?? context.now)), latencyUnknown: null }
        : { latencyMs: null, latencyUnknown: 'no-trigger-recorded' as const }),
      counterpartPid: context.read?.kind === 'ok' ? context.read.record.pid : null,
      requestCount: 0,
    });
  }

  /**
   * The minimum delay before this window asks again (§2.3): one request per
   * tick while fewer than K have gone unanswered — that is what makes the K
   * escalation take "K ticks" — and the exponential backoff after K, so a
   * window whose requests are being ignored cannot become a request storm.
   */
  private nextRequestDelayMs(): number {
    return this.unansweredRequests < LEASE_UNANSWERED_REQUEST_LIMIT_K
      ? LEASE_CLAIM_TICK_MS
      : claimRequestBackoffMs(this.unansweredRequests);
  }

  /** Publishes this window's request to displace the owner (§2.3 step 1). */
  private async publishClaimRequest(context: TickContext, generation: number): Promise<void> {
    try {
      // `writeClaimRequest` retires this window's previous request first, so the
      // steady state is **one request file per requesting window** (§3.2/§12.10)
      // rather than one per attempt.
      const published = await this.store.writeClaimRequest(context.now, { focused: true });
      if (this.stale(generation)) {
        return;
      }
      // A retirement that failed leaves the previous file behind (the publish
      // must not be blocked by it), so report it — once per streak, not once per
      // tick, because the next attempt retries the same unlink.
      if (published.retiredPrevious === 'failed') {
        if (!this.requestRetirementFailed) {
          this.requestRetirementFailed = true;
          this.logger.info(
            this.line(context, 'request', 'retire-failed', {
              file: 'previous-request',
              retrying: 'next-publish',
            }),
          );
        }
      } else {
        this.requestRetirementFailed = false;
      }
      const request = published.request;
      if (this.unansweredRequests === 0) {
        this.requestStreakStartedAt = context.now;
        // Whether this window is asking against a holder it already knows is
        // gone decides the accelerated takeover's latency anchor: the holder's
        // disappearance (the bug-report case) or this first request.
        this.requestStreakFromDeadHolder = context.holderGoneAt !== undefined;
      }
      this.unansweredRequests += 1;
      this.lastRequestAt = context.now;
      this.logger.info(
        this.line(context, 'request', 'focus-debounce-elapsed', {
          hMs: LEASE_FOCUS_DEBOUNCE_H_MS,
          focusedForMs: Math.round(context.focusedForMs),
          requestNumber: this.unansweredRequests,
          k: LEASE_UNANSWERED_REQUEST_LIMIT_K,
          nextRequestAfterMs: this.nextRequestDelayMs(),
          requestAt: request.at,
          // What the next tick does with this: the focused window takes the
          // lease once the owner yields (or once K unanswered requests make it
          // take the lease by force).
          wouldAction: 'claim',
        }),
      );
    } catch (error) {
      // A request is advisory: a failed write costs one backoff period and
      // never degrades the mechanism (§2.3).
      this.lastRequestAt = context.now;
      this.logger.debug(this.line(context, 'request', 'write-failed', { error: errorCode(error) ?? 'unknown' }));
    }
  }

  /**
   * Owner-side housekeeping: clear the request files a dead window left behind
   * (§2.3, §12.10). The rules live in `LeaseStore.pruneStaleClaimRequests`; this
   * only decides *when* — while the owner is already reading the directory — and
   * logs what was removed.
   */
  private async pruneDeadClaimRequests(context: TickContext, generation: number): Promise<void> {
    const removed = await this.store.pruneStaleClaimRequests(
      context.now,
      context.observations,
      context.pending?.fileName,
    );
    if (this.stale(generation) || removed.length === 0) {
      return;
    }
    this.logger.debug(
      this.line(context, 'prune-requests', 'stale-dead-requester', {
        pruned: removed.length,
        pendingRequestPid: context.pending?.request.pid ?? 'none',
      }),
    );
  }

  /**
   * Gives the lease mechanism up for the session (§8): nothing is written any
   * more and the window polls at full speed, exactly as it does with the
   * setting off. The one-time §7.1 notice is due at this moment, and only now:
   * this is a decided, persistent unavailability, not the "no decision yet"
   * state every window starts in. The callback runs after the gate has opened,
   * so a message that says "this window polls on its own" is true when it is
   * shown.
   */
  private enterDegraded(now: number, cause: string): void {
    const first = !this.degraded;
    this.degraded = true;
    this.currentRole = 'degraded';
    if (!first) {
      return;
    }
    this.degradedCause = cause;
    this.degradedSince = now;
    // Force the next decision line to count as a change, so the cause is
    // logged once at info level instead of waiting for the trace interval.
    this.lastDecisionSignature = undefined;
    this.syncPollingGate();
    // The notice is "shown" only when there is someone to show it: without a
    // callback nothing was shown, and the diagnostics must not claim otherwise.
    this.noticeShown = this.onDegraded !== undefined;
    try {
      this.onDegraded?.(cause);
    } catch (error) {
      this.logger.debug(`lease degradation notice failed: ${errorCode(error) ?? 'unknown'}`);
    }
  }

  /**
   * Publishes the gate: `mayPoll()` is derived state, and a change in it is the
   * only thing that reaches the notification poller (see the module comment).
   * The notification itself is what makes a window that just became the owner
   * poll immediately.
   */
  private syncPollingGate(): void {
    const allowed = this.computeMayPoll();
    if (allowed === this.pollAllowed) {
      return;
    }
    this.pollAllowed = allowed;
    this.logger.info(
      this.line(this.contextFor(this.clock()), 'polling-gate', allowed ? 'granted' : 'suppressed', {
        role: this.currentRole,
        ...(this.degraded ? { cause: this.degradedCause ?? 'unknown' } : {}),
      }),
    );
    for (const listener of [...this.gateListeners]) {
      try {
        listener(allowed);
      } catch (error) {
        // A consumer that throws is a bug in the consumer; the election must
        // not stop over it (§8's direction is "keep polling", not "stop").
        this.logger.debug(`lease gate listener failed: ${errorCode(error) ?? 'unknown'}`);
      }
    }
  }

  /**
   * §8 in one expression: everything uncertain polls, and only a decision that
   * says "a valid live lease is held by another window" does not.
   *
   * The order matters. The role is the belt-and-braces half — anything that is
   * not a follower polls — and the pure layer's `decisionPollsLocally` is the
   * actual rule: it answers `false` for exactly one action (`inactive`, the
   * follower branch, which is only reachable with a valid, non-stale record
   * whose holder is alive). A `claim` that lost the `wx` race is a *settled*
   * decision that polls locally, and it must keep polling: `EEXIST` is not the
   * confirmed read §8 requires before a window goes quiet.
   */
  private computeMayPoll(): boolean {
    if (this.disposed || !this.electionRunning) {
      return true;
    }
    if (this.degraded) {
      return true;
    }
    if (this.currentRole !== 'follower') {
      return true;
    }
    if (!this.decisionSettled || this.lastDecision === undefined) {
      return true;
    }
    return decisionPollsLocally(this.lastDecision);
  }

  /** A context for a log line outside a tick (gate changes, disable, dispose). */
  private contextFor(now: number): TickContext {
    const focused = this.focused;
    return {
      now,
      focused,
      focusedForMs: focused ? Math.max(0, now - (this.focusedSince ?? now)) : 0,
      claimRequestCount: 0,
      observations: [],
    };
  }

  /** The last handover this window took part in, for the diagnostics (§11.1). */
  private recordHandover(handover: LeaseHandoverRecord): void {
    this.handover = handover;
  }

  /**
   * The handover record for a takeover this window just completed (§11.1 stage
   * 2). One place, because the trigger — and therefore `latencyMs` — has to be
   * derived the same way for every claim path, and because the anchor has to be
   * cleared here rather than at the decision that produced it: until the claim
   * actually succeeded, no ownership had changed.
   */
  private takeoverHandover(
    context: TickContext,
    decision: Extract<LeaseDecision, { action: 'claim' }>,
    previousHolderPid: number | null,
    requestCount: number,
  ): LeaseHandoverRecord {
    return {
      direction: 'takeover',
      reason: takeoverReason(decision.reason),
      at: context.now,
      ...this.handoverLatency(context, decision),
      counterpartPid: previousHolderPid ?? decision.plan.requestedBy?.pid ?? null,
      requestCount,
    };
  }

  /**
   * The takeover's latency, and why it is unknown when it is (§11.1 stage 2).
   *
   * The trigger, per path:
   *
   * - `follower-takeover-absent` (the file is gone): **unknown**. The release
   *   that removed the file left no timestamp behind, and this window may have
   *   started long after it. Reporting `0` here — as this used to — claims an
   *   instantaneous handover that was never measured.
   * - `follower-takeover-expired`: from the moment the record became
   *   expirable, which is exact arithmetic on a timestamp that is on disk. A
   *   *dead holder pid* reaches this path too (`isLeaseStale` treats it as
   *   immediately stale), and there the figure is the time left in the expiry
   *   window at the moment of the claim, clamped at zero: when the crash is
   *   discovered late — measured at ~11–13 s after a hard kill, i.e. while the
   *   expiry is still in the future — the honest answer is "the takeover
   *   happened as soon as the window allowed", which is what `0` says.
   * - `follower-takeover-accelerated` (the K escalation): from this window's
   *   first unanswered request, or from its first sighting of the holder gone
   *   when the streak started against an already-gone holder. Either way it is
   *   a measurement of *this* window, never a guess about the predecessor.
   *
   * (The escalation is dormant for a *cold-start* streak at the shipped
   * constants — see `never invents a latency for the K escalation when the
   * streak is built from scratch` in `leasePollingGate.test.ts` — but a streak
   * that is already at K does displace an owner that is alive but silent: the
   * claim's release re-checks the record at the same 30 s threshold rather than
   * at the 35 s expiry (§4.2.3), which is what the 2026-09-28 measurement was
   * about.)
   */
  private handoverLatency(
    context: TickContext,
    decision: Extract<LeaseDecision, { action: 'claim' }>,
  ): Pick<LeaseHandoverRecord, 'latencyMs' | 'latencyUnknown'> {
    if (decision.reason === 'follower-takeover-absent') {
      return { latencyMs: null, latencyUnknown: 'predecessor-release-time-unobservable' };
    }
    if (decision.reason === 'follower-takeover-accelerated') {
      // `holderGoneAt` is the holder's disappearance and wins when the streak
      // was started against one; otherwise this window's first request is the
      // trigger (the owner was alive but ignoring us).
      const anchor = this.requestStreakFromDeadHolder
        ? (this.holderGoneAt ?? this.requestStreakStartedAt)
        : this.requestStreakStartedAt;
      return anchor === undefined
        ? { latencyMs: null, latencyUnknown: 'no-trigger-recorded' }
        : { latencyMs: Math.max(0, context.now - anchor), latencyUnknown: null };
    }
    const holder = context.read?.kind === 'ok' ? context.read.record : undefined;
    if (decision.reason === 'follower-takeover-expired' && holder !== undefined) {
      return { latencyMs: Math.max(0, context.now - (holder.heartbeatAt + LEASE_EXPIRY_MS)), latencyUnknown: null };
    }
    // No reachable path today; a total return keeps a future claim path from
    // silently inheriting a `0`.
    return { latencyMs: null, latencyUnknown: 'no-trigger-recorded' };
  }

  /**
   * Restamps the record's instance-set fingerprint from the live config just
   * before a write (§3.2, §3.3). It is diagnostics only — the decision layer's
   * input has no field for it — so it can never influence an election; the point
   * is that a later diagnostics dump describes the instances this window polls
   * *now*, not the ones it had at activation.
   */
  private refreshInstancesFingerprint(): void {
    this.store.updateInstancesFingerprint(instanceSetFingerprint(this.instanceIds()));
  }

  private resetOwnerState(): void {
    this.heartbeatFailures = 0;
    this.heartbeatFailureSince = undefined;
    this.heartbeatAttemptedAt = undefined;
  }

  private resetFollowerRequestState(): void {
    this.unansweredRequests = 0;
    this.lastRequestAt = undefined;
    this.requestStreakStartedAt = undefined;
    this.requestStreakFromDeadHolder = false;
  }

  /**
   * Logs one decided action. Ownership events and focus-driven decisions are
   * `info`; everything else is `debug`, and a decision that repeats is silent
   * — except for one trace line a minute, so a soak can tell a quiet election
   * from a dead supervisor.
   */
  private logDecision(
    context: TickContext,
    decision: LeaseDecision,
    extra?: Record<string, string | number | boolean>,
  ): void {
    const signature = `${this.currentRole}|${decision.action}|${decision.reason}|${context.focused}`;
    const unchanged = signature === this.lastDecisionSignature;
    this.lastDecisionSignature = signature;
    const traceDue = context.now - this.lastDecisionLogAt >= TRACE_INTERVAL_MS;
    if (unchanged && !traceDue) {
      return;
    }
    this.lastDecisionLogAt = context.now;
    const message = this.line(context, decision.action, decision.reason, {
      ...this.decisionExtras(context, decision),
      ...extra,
    });
    const actionable =
      !unchanged && (FOCUS_DRIVEN_REASONS.has(decision.reason) || OWNERSHIP_ACTIONS.has(decision.action));
    if (actionable) {
      this.logger.info(message);
    } else {
      this.logger.debug(message);
    }
  }

  /** The election state every decision line carries, so a log is self-contained. */
  private decisionExtras(context: TickContext, decision: LeaseDecision): Record<string, string | number | boolean> {
    const extras: Record<string, string | number | boolean> = {};
    const read = context.read;
    if (read === undefined) {
      extras.leaseRead = 'skipped';
    } else if (read.kind === 'ok') {
      extras.lease = 'held';
      extras.holderPid = read.record.pid;
      extras.heartbeatAgeMs = Math.round(context.now - read.record.heartbeatAt);
      if (read.record.ownerNonce === this.store.nonce) {
        extras.sinceClaimMs = Math.round(context.now - read.record.claimedAt);
        if (this.heartbeatFailures > 0) {
          // A soak reads the step-down threshold from here (§4.1, §12.9).
          extras.failures = this.heartbeatFailures;
          extras.failedForMs =
            this.heartbeatFailureSince === undefined ? 0 : Math.round(context.now - this.heartbeatFailureSince);
        }
      }
    } else {
      extras.lease = read.kind === 'invalid' ? `invalid-${read.reason}` : 'missing';
      if (this.store.holdsUnpublishedRecord) {
        // The one case where an unreadable record is *not* a stale lease: the
        // file exists because this window `wx`-created it and the record never
        // landed (§3.2, §4.2). Named explicitly so a soak can tell the two apart
        // without inferring it from the reason string.
        extras.ownRecordUnpublished = 1;
        if (this.heartbeatFailures > 0) {
          extras.failures = this.heartbeatFailures;
          extras.failedForMs =
            this.heartbeatFailureSince === undefined ? 0 : Math.round(context.now - this.heartbeatFailureSince);
        }
      }
    }
    if (context.holderPidAlive !== undefined) {
      extras.holderAlive = context.holderPidAlive ? 1 : 0;
    }
    extras.requests = context.claimRequestCount;
    if (context.pending !== undefined) {
      extras.pendingRequestPid = context.pending.request.pid;
    }
    if (decision.action === 'claim') {
      if (decision.plan.mustReleaseStale) {
        extras.mustReleaseStale = 1;
      }
      if (decision.plan.requestedBy !== undefined) {
        extras.requestedByPid = decision.plan.requestedBy.pid;
      }
    }
    if (decision.action === 'yield') {
      extras.wouldAction = 'yield';
    }
    if (decision.reason === 'owner-keep-hysteresis') {
      // The would-be handover the N window suppressed: this line, next to the
      // real yield that follows it, is what N is calibrated from.
      extras.wouldAction = 'yield';
      extras.nMs = LEASE_HANDOVER_HYSTERESIS_N_MS;
    }
    if (
      decision.reason === 'owner-keep-focused' ||
      decision.reason === 'owner-keep-requested-unfocused' ||
      decision.reason === 'owner-keep-requested-stale'
    ) {
      // `keep` is the decision, and stating it as the would-be action keeps the
      // handover-frequency count honest: these lines are *refusals*, not missed
      // handovers. Only `owner-keep-hysteresis` above is a suppressed handover.
      extras.wouldAction = 'keep';
    }
    return extras;
  }

  private line(
    context: TickContext,
    action: string,
    reason: string,
    extra?: Record<string, string | number | boolean>,
  ): string {
    return formatLeaseLogLine({
      role: this.currentRole,
      action,
      reason,
      pid: this.store.processId,
      noncePrefix: noncePrefix(this.store.nonce),
      focused: context.focused,
      focusedForMs: context.focusedForMs,
      at: context.now,
      polling: this.pollAllowed ? 'unchanged' : 'suppressed',
      ...(extra === undefined ? {} : { extra }),
    });
  }
}

/** `errno`-style code when the thrown value has one, for log lines. */
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * The one supervisor of this window, held at module scope so `deactivate()` can
 * reach it without the extension having to keep a reference (the same shape
 * `mcpBroker.ts` uses for its takeover watcher).
 */
let activeSupervisor: LeaseSupervisor | undefined;

/**
 * What the activation site knows and the lease module must not go looking for:
 * where globalStorage is, which build is running, and where the configured
 * instance identities come from.
 */
export interface LeaseStartOptions {
  /** `<globalStorageUri.fsPath>` (§3.1). */
  directory: string;
  /** `context.extension.packageJSON.version`: the record's `appVersion` (§3.2). */
  appVersion: string;
  /**
   * The configured instances' identifiers, read at every write (§3.2, §3.3).
   * The config's own `instance.id` is the identity being hashed — no second
   * notion of "which instance" is invented here.
   */
  instanceIds: () => readonly string[];
  /** The §7.1 one-time degradation notice, wired by the activation site. */
  onDegraded?: (cause: string) => void;
}

/**
 * Starts the polling lease for `<globalStorage>/mcp-leader-lease.json` (§3.1).
 * The caller owns nothing but the returned disposable; `deactivate()` reaches
 * the same instance through `disposePollingLease()`.
 */
export function startPollingLease(options: LeaseStartOptions, logger: LeaseLogger): LeaseSupervisor {
  const supervisor = new LeaseSupervisor({
    directory: options.directory,
    appVersion: options.appVersion,
    instanceIds: options.instanceIds,
    ...(options.onDegraded === undefined ? {} : { onDegraded: options.onDegraded }),
    logger,
  });
  activeSupervisor = supervisor;
  supervisor.start();
  return supervisor;
}

/** Stops the election and releases this window's lease, if it still owns it. */
export async function disposePollingLease(): Promise<void> {
  const supervisor = activeSupervisor;
  activeSupervisor = undefined;
  await supervisor?.dispose();
}
