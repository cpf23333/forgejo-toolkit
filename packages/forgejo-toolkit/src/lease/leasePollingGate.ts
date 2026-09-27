/**
 * The polling lease's one output: whether this window may poll and alert
 * (§11.1 stage 2).
 *
 * Stage 1 deliberately had *no* channel from the lease to the notification
 * poller — neither direction existed, and two tests pinned that. Stage 2 is the
 * release that turns the election into behaviour, so exactly one channel
 * exists, and this module is it: a two-method contract with no IO, no timer and
 * no editor API, so `notifications/**` can depend on the *question* without
 * depending on the lease's filesystem, its decision table or its supervisor.
 * `src/__tests__/leasePollingGuards.test.ts` fails if the notification module
 * graph reaches any other lease module.
 *
 * The contract is deliberately fail-open, and that is the safety rail of §8
 * rather than a detail: a consumer that has no gate (or a broken one) polls.
 * The implementation on the other side only answers `false` for one state — a
 * valid, live lease held by another window — and answers `true` for the
 * setting being off, for a degraded mechanism, for every other decision, and
 * for "no decision yet". "Only the owner polls" is therefore only ever reached
 * from a *confirmed* follower, never from an unknown one.
 */

/** The question the notification poller asks before every round (and on every change). */
export interface LeasePollingGate {
  /**
   * True while this window must poll and raise alerts exactly as it does with
   * the lease turned off (§8). False only for a confirmed healthy follower.
   */
  mayPoll(): boolean;
  /**
   * Called when the answer changes, with the new value. The poller's
   * `false → true` transition is what makes a window that has just become the
   * owner poll **immediately** instead of after the next interval (§7.2's
   * "takeover polls now" rule, which §2.3's focus handover needs too).
   */
  onDidChange(listener: (mayPoll: boolean) => void): { dispose(): void };
}
