/**
 * Every tunable of the multi-window polling lease, in one place.
 *
 * The specification is `docs/design/multi-window-polling-lease.md`; each
 * constant names the section it came from, because the numbers are the part of
 * that document that is still expected to move. §12's last entry is the only
 * open item: H / N / K, the staleness threshold and the heartbeat retry /
 * step-down numbers are recorded *starting* values, to be re-tuned from the
 * stage-1 shadow logs and the stage-2 soak (§11.1, §11.2). Mechanisms are
 * decided; these numbers are not.
 *
 * Nothing here consults, or even names, an editor state store: the election is
 * file-only by decision (§2 decision 1, §3.1, §12.2), and this module tree must
 * never grow a second arbiter. The reverse guard in
 * `src/__tests__/leaseGuards.test.ts` enforces that, mention included.
 */

/** The lease's fixed file name in the extension's globalStorage directory (§3.1). */
export const LEASE_FILE_NAME = 'mcp-leader-lease.json';

/**
 * The version stamped into a lease record (§3.2). A record with another version
 * is not something this build can reason about, so it counts as stale (§8).
 */
export const LEASE_RECORD_VERSION = 1;

/**
 * Heartbeat interval (§2 decision 2, §4.1): the owner refreshes
 * `heartbeatAt` this often.
 *
 * Deliberately independent of the notification polling interval, which is
 * ≥ 60 s (`src/config.ts`): the lease has to notice a dead owner long before a
 * polling interval elapses, so it cannot borrow that clock.
 */
export const LEASE_HEARTBEAT_MS = 10_000;

/**
 * Expiry (§2 decision 2, §4.2): a lease whose `heartbeatAt` is older than this
 * is stale and may be taken over. Three heartbeats, so a single missed
 * heartbeat is not enough.
 */
export const LEASE_EXPIRY_MS = 35_000;

/**
 * The owner's own step-down threshold (§4.1, §12.9): after this much continuous
 * heartbeat-write failure the owner degrades and re-claims, instead of
 * continuing to believe it is the owner.
 *
 * 2 × expiry, i.e. 70 s ≈ the 8th consecutive failed heartbeat. The two
 * outcomes on this path are both safe — keep polling risks a short double
 * poll, step down too early risks a window with nobody polling (§4.1, §8) — so
 * the threshold is deliberately much longer than one expiry: a read handle
 * that happens to straddle one rename must not trigger it.
 */
export const LEASE_OWNER_STEP_DOWN_MS = 2 * LEASE_EXPIRY_MS;

/**
 * Attempts per heartbeat write, retries included (§4.1, §12.9): the first try
 * plus three retries. On Windows `fs.rename` over a target that any process
 * holds open fails with `EPERM` (§13.1); retrying shortly after is what keeps
 * that from being reported as a heartbeat failure at all.
 */
export const LEASE_HEARTBEAT_WRITE_ATTEMPTS = 4;

/** Delay between those attempts (§4.1, §12.9: "a few hundred milliseconds"). */
export const LEASE_HEARTBEAT_RETRY_DELAY_MS = 250;

/**
 * The focus debounce H (§2.3 parameter table, §12.10): a window must be focused
 * continuously for this long before it sends a claim request.
 *
 * Recorded span 10–15 s; the midpoint is used so a later re-tune in either
 * direction is a one-line change. The point is only that alt-tabbing back and
 * forth does not count as "the user is working in this window".
 */
export const LEASE_FOCUS_DEBOUNCE_H_MS = 12_500;

/**
 * The anti-ping-pong window N (§2.3 parameter table, §12.10): a window that has
 * just taken the lease does not yield for this long, so two focused windows
 * cannot trade the lease back and forth.
 *
 * The upper bound of H, by the document's own reasoning: after taking over, a
 * window must stay quiet for at least one debounce period before the next
 * candidate can displace it.
 */
export const LEASE_HANDOVER_HYSTERESIS_N_MS = 15_000;

/**
 * The requester's tick (§2.3, §12.10). This is *not* the heartbeat interval:
 * the requester re-reads the lease and, if it is still the wrong window's,
 * sends another claim request on this cadence, which is what bounds the
 * handover delay at K ticks. Kept separate on purpose — merging it into
 * `LEASE_HEARTBEAT_MS` would silently stretch the worst-case handover from ~6 s
 * to ~30 s.
 */
export const LEASE_CLAIM_TICK_MS = 2_000;

/**
 * How many consecutive unanswered claim requests a focused window tolerates
 * before it stops waiting for the full expiry (K = 3, §2.3, §12.10).
 *
 * With K ticks of 2 s this bounds the handover at ~6 s instead of 35 s. The
 * cost is a short window with two pollers and therefore a duplicated alert,
 * which is the safe direction: a duplicate alert, never a missing one (§8).
 */
export const LEASE_UNANSWERED_REQUEST_LIMIT_K = 3;

/**
 * The staleness threshold used by the *accelerated* takeover (§2.3, §4.1,
 * §12.10): a record older than this, next to K unanswered requests, counts as
 * "the current owner is unreachable" rather than "the current owner is between
 * two heartbeats".
 *
 * It is **three heartbeat periods**, and that multiple is the whole point: a
 * threshold below one period can never distinguish a dead owner from a live one,
 * because a healthy owner's record is legitimately up to `LEASE_HEARTBEAT_MS`
 * old at any moment. The recorded starting value of 5 s — below the 10 s
 * heartbeat — made this branch fire against healthy owners; it evicted a leader
 * whose record was 6 s old and made §11.2's "zero non-intentional owner changes"
 * unreachable (the soak timeline is in §11.2, the rule in §4.1).
 *
 * Deliberately *not* the expiry, and deliberately below it: 3 × 10 s = 30 s is
 * what lets the K escalation act before waiting out the 35 s lease — by at most
 * one heartbeat period. The accelerated branch also respects the anti-ping-pong
 * window N (§2.3): K buys an earlier *attempt*, never the right to displace a
 * window that has just taken the lease.
 *
 * A future reader can check the two properties without re-deriving them: the
 * consistency test in `src/__tests__/leaseDecision.test.ts` asserts the literal
 * 30 s, the `LEASE_HEARTBEAT_MS` multiple, and
 * `LEASE_ACCELERATED_STALE_MS < LEASE_EXPIRY_MS`. A retune of the heartbeat that
 * breaks either order fails that test instead of silently turning this branch
 * into dead code (at or above the expiry) or into a false-positive generator (at
 * or below one heartbeat).
 */
export const LEASE_ACCELERATED_STALE_MS = 3 * LEASE_HEARTBEAT_MS;

/**
 * A claim request older than this is ignored (§2.3: a request is only honoured
 * when it is newer than the lease it asks to displace): a window that crashed
 * mid-request must not keep an owner stepping down forever.
 */
export const LEASE_CLAIM_REQUEST_MAX_AGE_MS = 15_000;

/**
 * A `<lease>.part` file older than this belongs to a crashed write and is
 * cleared before a new write; a younger one may be another window's write in
 * flight, so the attempt simply retries instead of deleting it (§4.2.5).
 */
export const LEASE_STALE_PART_MAX_AGE_MS = 35_000;

/**
 * Backing-off retry for claim requests (§2.3: "a rejected or failed request
 * retries with backoff; it must not become a request storm"), and the same
 * base for the K escalations' cadence.
 */
export const LEASE_REQUEST_RETRY_BASE_MS = 2_000;

/** Upper bound for that backoff (§2.3). */
export const LEASE_REQUEST_RETRY_MAX_MS = 30_000;
