/**
 * Stage 1 of the multi-window polling lease: the supervisor (§11.1 stage 1).
 *
 * It owns every timer, every `vscode` touch and every write, so the decision
 * layer stays the clock-free, editor-free function `leaseDecision.ts` is. Each
 * tick it assembles a `LeaseDecisionInput` from real state — its own nonce, pid
 * and focus, the lease it just read, the holder's pid liveness, its own
 * heartbeat-write failure counters and its own unanswered claim requests —
 * calls `decideLeaseAction`, and then acts.
 *
 * **Stage 1 changes nothing observable, and that is a property of the shape of
 * this module, not a promise.** There is no channel from here to the poller:
 * this module imports no `notifications/**` module, and nothing in
 * `notifications/**` imports it (both directions are pinned by
 * `src/__tests__/leaseShadowGuards.test.ts`). Every decision is therefore a
 * decision about the *election* only — `inactive` (a follower, §4.2) included,
 * because in stage 1 the follower still polls. What the supervisor acts on is
 * exactly the set of things that cannot alter polling: claim the lease when it
 * is free, heartbeat while owner, yield when the pure layer says so, release on
 * dispose. What it logs is what it would have done, so one week of shadow logs
 * can answer whether the election is stable, how often a handover would happen
 * and how long a focus change takes to move leadership (§11.1 stage 1, §11.2).
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
 * names (`leader` / `follower` / `degraded`), the action, the decision layer's
 * closed-union reason, `pid`, the nonce's first 8 characters, the focus state,
 * the focused-for duration and the tick's epoch time. Ownership events and
 * focus-driven decisions are `info`; everything else is `debug`, and a decision
 * that repeats is silent until it changes (or for one `debug` trace line a
 * minute), because "healthy is quiet" is what makes a soak readable (§3.5).
 */

import * as vscode from 'vscode';
import {
  LEASE_CLAIM_TICK_MS,
  LEASE_FOCUS_DEBOUNCE_H_MS,
  LEASE_HANDOVER_HYSTERESIS_N_MS,
  LEASE_HEARTBEAT_MS,
  LEASE_OWNER_STEP_DOWN_MS,
  LEASE_UNANSWERED_REQUEST_LIMIT_K,
} from './leaseConstants';
import {
  claimRequestBackoffMs,
  decideLeaseAction,
  selectCurrentClaimRequest,
  type LeaseDecision,
  type LeaseDecisionInput,
} from './leaseDecision';
import { LeaseStore, instanceSetFingerprint, noncePrefix } from './leaseStore';
import type { ClaimRequestObservation, LeaseRead, LeaseRecord } from './leaseTypes';

/** The role names `docs/design/multi-window-polling-lease.md` §11.1 uses. */
export type LeaseShadowRole = 'leader' | 'follower' | 'degraded';

/**
 * Everything the supervisor needs from the editor, as a narrow port. The
 * production implementation is `vscodeWindowLeaseHost()`; tests supply a fake,
 * which is why no test has to stand up a real window.
 */
export interface LeaseShadowHost {
  /** `vscode.window.state.focused`, read synchronously on every tick (§2.3). */
  isFocused(): boolean;
  /** `vscode.window.onDidChangeWindowState`, reduced to its `focused` flag. */
  onDidChangeFocus(listener: (focused: boolean) => void): { dispose(): void };
}

/** The slice of `Logger` this module uses. */
export interface LeaseShadowLogger {
  info(message: string): void;
  debug(message: string): void;
}

/** Everything the supervisor needs to exist. */
export interface LeaseShadowOptions {
  /** `<globalStorageUri.fsPath>`: where the lease lives (§3.1). */
  directory: string;
  logger: LeaseShadowLogger;
  /** Defaults to the real `vscode.window` read (§2.3). */
  host?: LeaseShadowHost;
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
}

/** The fields of one shadow line, in the order they are rendered. */
export interface LeaseShadowLogFields {
  role: LeaseShadowRole;
  action: string;
  reason: string;
  pid: number;
  /** `noncePrefix(ownerNonce)`: the first 8 characters, as §7.1 requires. */
  noncePrefix: string;
  focused: boolean;
  focusedForMs: number;
  /** `Date.now()`-style epoch ms of the tick that decided this (§6). */
  at: number;
  extra?: Record<string, string | number | boolean>;
}

/** The tag every stage-1 line starts with, so a soak can grep one prefix. */
const SHADOW_PREFIX = 'lease-shadow';

/**
 * How often an *unchanged* decision is repeated at `debug` level. The soak
 * evidence is the transitions; this is only a liveness trace, and one line a
 * minute keeps it out of the way of the events that matter.
 */
const SHADOW_TRACE_INTERVAL_MS = 60_000;

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
 * Render one shadow line: `lease-shadow key=value …`, fixed key order, extras
 * in the order the caller listed them, and `polling=unchanged` always last.
 *
 * That last field is the stage-1 invariant made visible: whichever action a
 * decision produced — `claim`, `keep-and-heartbeat`, `inactive`, `yield`,
 * `step-down`, `degraded-to-full-speed` — this window keeps polling, because
 * nothing in stage 1 consumes the decision. A test asserts it on every line of
 * every scenario.
 */
export function formatLeaseShadowLine(fields: LeaseShadowLogFields): string {
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
  parts.push('polling=unchanged');
  return `${SHADOW_PREFIX} ${parts.join(' ')}`;
}

/** The `vscode.window`-backed host: the only place this module reads the editor. */
export function vscodeWindowLeaseHost(): LeaseShadowHost {
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
}

/** Applies a claim, heartbeat, yield or step-down and its bookkeeping. */
export class LeaseShadowSupervisor {
  private readonly logger: LeaseShadowLogger;
  private readonly host: LeaseShadowHost;
  private readonly store: LeaseStore;
  private readonly clock: () => number;
  /** The configured instance identifiers, read when a record is written (§3.3). */
  private readonly instanceIds: () => readonly string[];

  private timer?: NodeJS.Timeout;
  private focusSubscription?: { dispose(): void };
  /** Bumped by `dispose()`; a tick from an older generation must not write. */
  private generation = 0;
  private started = false;
  private disposed = false;
  private tickInFlight?: Promise<void>;

  private currentRole: LeaseShadowRole = 'follower';
  private focusObserved = false;
  private focused = false;
  private focusedSince?: number;

  /** `consecutiveFailures` / `failureSince` of §4.1, fed to the pure layer. */
  private heartbeatFailures = 0;
  private heartbeatFailureSince?: number;
  /** When the last heartbeat write was *attempted*; the 10 s gate (§4.1). */
  private heartbeatAttemptedAt?: number;

  /** The follower's K counter and anti-storm anchor (§2.3, §12.10). */
  private unansweredRequests = 0;
  private lastRequestAt?: number;
  /** Latches the one-per-streak report of a failed request retirement (§12.10). */
  private requestRetirementFailed = false;

  private degraded = false;
  private degradedCause?: string;
  private degradedSince?: number;

  private lastDecision?: LeaseDecision;
  private lastDecisionSignature?: string;
  private lastDecisionLogAt = 0;

  constructor(options: LeaseShadowOptions) {
    this.logger = options.logger;
    this.host = options.host ?? vscodeWindowLeaseHost();
    this.clock = options.now ?? (() => Date.now());
    this.instanceIds = options.instanceIds ?? (() => []);
    this.store =
      options.store ??
      new LeaseStore({
        directory: options.directory,
        windowId: options.windowId ?? defaultWindowLabel(),
        ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      });
  }

  /** The role §11.1's diagnostics would report right now. */
  get role(): LeaseShadowRole {
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

  /**
   * Begins the shadow election: subscribe to the focus event, read the focus
   * state once, arm the tick and take a first tick immediately — a free lease
   * should be claimed now, not one tick from now (§5: the winner starts
   * polling at once).
   */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    // Subscribe before the first read so a focus change between the two is not
    // lost between the event and the tick fallback.
    this.focusSubscription = this.host.onDidChangeFocus((focused) => this.onFocusChange(focused));
    const now = this.clock();
    const focused = this.readFocus();
    this.logger.info(
      this.line({ now, focused, focusedForMs: 0, claimRequestCount: 0, observations: [] }, 'start', 'shadow-mode', {
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
    this.disposed = true;
    this.generation += 1;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.focusSubscription?.dispose();
    this.focusSubscription = undefined;
    const wasStarted = this.started;
    this.started = false;
    // A tick that was already past its last checkpoint must settle before the
    // release below, or a late claim could re-create the lease behind it
    // (mcpBroker's cleanup waits for its attempts for the same reason).
    await this.tickInFlight?.catch(() => undefined);
    if (!wasStarted) {
      return;
    }
    const now = this.clock();
    try {
      const released = await this.store.cleanup();
      this.logger.info(
        this.line(
          { now, focused: this.focused, focusedForMs: 0, claimRequestCount: 0, observations: [] },
          'release',
          'dispose',
          {
            lease: released.lease,
            claimRequest: released.claimRequest,
          },
        ),
      );
    } catch (error) {
      this.logger.debug(`lease-shadow release failed: ${errorCode(error) ?? 'unknown'}`);
    }
  }

  /** Resolves once the tick currently in flight (if any) has settled. */
  async whenSettled(): Promise<void> {
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
      // A tick must never surface as an unhandled rejection; the next tick
      // retries the same read.
      this.logger.debug(`lease-shadow tick failed: ${errorCode(error) ?? 'unknown'}`);
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

  /** One tick: read everything, decide, act only where polling cannot change. */
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
    if (decision.action === 'degraded-to-full-speed') {
      this.enterDegraded(now, 'read-unusable');
    }
    this.logDecision(
      context,
      decision,
      this.degraded ? { cause: this.degradedCause ?? 'unknown', degradedSince: this.degradedSince ?? now } : undefined,
    );
    if (decision.action === 'degraded-to-full-speed') {
      return;
    }
    await this.applyDecision(context, decision, generation, record);
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
          // so a lease that became live in the meantime is left alone.
          const released = await this.store.releaseStale(now);
          if (this.stale(generation)) {
            return;
          }
          this.logger.debug(this.line(context, 'release-stale', decision.reason, { outcome: released }));
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
        return;
      }
      case 'step-down': {
        const failures = this.heartbeatFailures;
        const failedForMs =
          this.heartbeatFailureSince === undefined ? 0 : Math.max(0, now - this.heartbeatFailureSince);
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
    this.currentRole = 'leader';
    this.heartbeatAttemptedAt = now;
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

  /** §4.1.2: the record is no longer ours — log it and start over as a follower. */
  private demote(context: TickContext, reason: 'owner-changed' | 'lease-missing'): void {
    const previousRole = this.currentRole;
    this.currentRole = 'follower';
    this.resetOwnerState();
    this.resetFollowerRequestState();
    this.logger.info(this.line(context, 'demote', reason, { wasRole: previousRole }));
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
          // What stage 2 would do with this: the focused window takes the
          // lease once the owner yields (or once K unanswered requests make it
          // take the lease by force). Stage 1 only records that it would.
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
   * more and the window polls at full speed, exactly as it does today.
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
    const traceDue = context.now - this.lastDecisionLogAt >= SHADOW_TRACE_INTERVAL_MS;
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
    return formatLeaseShadowLine({
      role: this.currentRole,
      action,
      reason,
      pid: this.store.processId,
      noncePrefix: noncePrefix(this.store.nonce),
      focused: context.focused,
      focusedForMs: context.focusedForMs,
      at: context.now,
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
let activeSupervisor: LeaseShadowSupervisor | undefined;

/**
 * What the activation site knows and the lease module must not go looking for:
 * where globalStorage is, which build is running, and where the configured
 * instance identities come from.
 */
export interface LeaseShadowStartOptions {
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
}

/**
 * Starts the stage-1 shadow election for `<globalStorage>/mcp-leader-lease.json`
 * (§3.1). The caller owns nothing but the returned disposable; `deactivate()`
 * reaches the same instance through `disposeLeaseShadowMode()`.
 */
export function startLeaseShadowMode(
  options: LeaseShadowStartOptions,
  logger: LeaseShadowLogger,
): LeaseShadowSupervisor {
  const supervisor = new LeaseShadowSupervisor({
    directory: options.directory,
    appVersion: options.appVersion,
    instanceIds: options.instanceIds,
    logger,
  });
  activeSupervisor = supervisor;
  supervisor.start();
  return supervisor;
}

/** Stops the shadow election and releases this window's lease, if it still owns it. */
export async function disposeLeaseShadowMode(): Promise<void> {
  const supervisor = activeSupervisor;
  activeSupervisor = undefined;
  await supervisor?.dispose();
}
