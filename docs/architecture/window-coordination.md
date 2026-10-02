# Cross-Window Coordination

Every VS Code window runs its own extension host, so a profile with several windows
open has several processes with their own timers, their own in-memory state, and no
direct channel between them. Two mechanisms exist only because of that:

- **The notification-polling lease** (`packages/forgejo-toolkit/src/lease/`) elects one
  window to poll and alert, so N windows do not each poll the same instances and raise
  the same toast.
- **The shared server-version probe cache**
  (`packages/forgejo-toolkit/src/api/serverVersionCache.ts`) records one window's
  `/api/v1/version` probe where every other window can reuse it, so N windows do not
  each probe every instance.

Both were decided in the [multi-window polling lease design
document](../design/multi-window-polling-lease.md) — the probe cache in its §9 route 2 —
which remains the decision record for the mechanisms and for the numbers this page
quotes. This page describes what the code does today.

## The notification-polling lease

The lease is a file, not a message. Every window's extension host elects itself against
`<globalStorage>/mcp-leader-lease.json` and the notification poller asks the resulting
gate before every round: the owner polls and alerts, a confirmed follower does not. A
window whose host exposes no `globalStorage` starts no election at all and polls on its
own.

### The lease file and its record

`mcp-leader-lease.json` holds one JSON record (`LEASE_FILE_NAME`,
`LEASE_RECORD_VERSION` in `leaseConstants.ts`): `version`, `ownerNonce`, `pid`,
`windowId`, `claimedAt`, `heartbeatAt`, `releaseReason`, `appVersion` and
`instancesFingerprint`. The nonce is 8 random bytes per extension host process
(`LEASE_WINDOW_NONCE` in `leaseStore.ts`) and is the _only_ thing ownership is decided
by — never a pid (which is recycled) and never a timestamp comparison across windows.
The instance fingerprint is a digest of the configured instance **ids**, so it carries
no address; it is written for diagnostics and is deliberately absent from the decision
layer's input, so it structurally cannot influence an election.

Nothing in the mechanism reads or writes the editor's state store. The election is
file-only by decision, because `globalState` has no cross-window change event and its
read-modify-write is not atomic — "who leads" would become a probability. A guard test
in `src/__tests__/leaseGuards.test.ts` enforces that, mention included.

### Claiming, heartbeating and releasing

- **Claim** (`LeaseStore.claim`) is one `fs.open(path, 'wx')`. The kernel decides
  "does not exist → create" in a single step, so exactly one window's create succeeds
  and everyone else gets `EEXIST`, which the store reports as `contended` — a follower
  stays a follower and re-evaluates on the next tick. There is deliberately no unlink
  and retry inside the claim: unlinking as a reaction to `EEXIST` is the failure mode
  the design forbids, because two followers would delete each other's — and the
  winner's — just-written record.
- **Heartbeat** (`LeaseStore.heartbeat`) re-reads the file, refuses to write unless the
  record is still ours, and then refreshes `heartbeatAt` through the atomic-write shape:
  a `.part` sibling created with `wx`, fsynced, closed, then renamed over the target.
  The one exception is the narrow repair case — a _malformed_ record this window itself
  created and failed to publish (`holdsUnpublishedRecord`) is written again with the
  claim time kept in memory, because nobody else may repair that file.
- **Yielding** (`LeaseStore.yieldOwn`, used for a focus handover and for `deactivate()`)
  removes the file only after re-reading it and confirming the record still names this
  window. `deactivate()` calls `disposePollingLease()`, so a closed window gives the
  lease up immediately instead of making the survivors wait out the expiry; a window
  that has already been displaced touches nothing.
- **Releasing a stale record** (`LeaseStore.releaseStale`, on the takeover path) also
  re-reads and re-validates first, so a lease that became live in the meantime is left
  alone.

The cadences are deliberately separate: the **tick** is `LEASE_CLAIM_TICK_MS` (2 s) —
read the lease, re-read the focus state, decide, maybe publish a claim request — and
the **heartbeat** is `LEASE_HEARTBEAT_MS` (10 s) measured from the last _attempt_ rather
than the last success, so a failed write is not retried by every 2 s tick. The heartbeat
cannot borrow the notification interval (which is ≥ 60 s, `src/config.ts`): the lease has
to notice a dead owner long before a polling interval elapses. Expiry is
`LEASE_EXPIRY_MS` (35 s, three heartbeats), so one missed heartbeat is not enough; a
record whose holder pid is verifiably dead (`process.kill(pid, 0)`, `EPERM` counted as
alive) is takeoverable immediately rather than after the expiry. An owner that cannot
refresh its own record steps down after `LEASE_OWNER_STEP_DOWN_MS` (2 × expiry = 70 s),
and the step-down reason names the write failure when there is one.

### Claim requests and the four yield guards

A follower that wants the lease does not touch the holder's file: it publishes
`<lease>.claim.<pid>.<token>`, one request file per requester replaced in place, after
being continuously focused for `LEASE_FOCUS_DEBOUNCE_H_MS` (H = 12.5 s, the midpoint of
the recorded 10–15 s span) — alt-tabbing back and forth is not "the user is working in
this window". Requests go out one per tick for the first K = 3
(`LEASE_UNANSWERED_REQUEST_LIMIT_K`), then on the exponential backoff
(`claimRequestBackoffMs`, 2 s base, 30 s cap) so an ignored requester cannot become a
request storm; a request is only honoured while it is newer than the lease and not
older than `LEASE_CLAIM_REQUEST_MAX_AGE_MS` (15 s). The owner prunes the request files
of _dead_ requesters once they have aged out — the safety net for a window that died
between publishing and retiring its file.

As the owner, holding on is the default; handing over needs all four guards to pass
(`leaseDecision.ts`, `decideAsOwner`):

1. the anti-ping-pong window N = 15 s (`LEASE_HANDOVER_HYSTERESIS_N_MS`) has elapsed
   since `claimedAt`, so two windows cannot trade the lease back and forth;
2. the request is from a **focused** window — an unfocused requester never justifies a
   handover, whoever is looking;
3. the request is newer than our own claim;
4. this window is **not** focused itself. The corrected rule (2026-09-27 soak) is that
   handing over while the user is looking at this window buys nothing, and when two
   windows both reported `focused` it produced a handover every N + one tick.

As a follower, only the holder's apparent absence justifies a claim: a missing or
invalid record (released first, with the re-read above, when it is invalid), an expired
or dead-pid record, or the accelerated arm below. A live holder with a fresh heartbeat
leaves this window `inactive` — it does not poll, and only the gate's change
notification brings it back.

### The polling gate

The lease's single output is `LeasePollingGate.mayPoll()`
(`leasePollingGate.ts`), implemented by the supervisor. It is fail-open in every
direction that is not a _confirmed_ healthy follower:

- the setting off, the mechanism degraded, the election not running, no decision yet, a
  decision whose action polls locally, or a tick that threw ⇒ **poll**;
- only an `inactive` decision — a valid, live, non-stale lease held by another window —
  closes the gate.

The notification poller (`notificationPoller.ts`) asks it once at the start of every
round: a suppressed round makes no requests and writes nothing, while the interval stays
armed so the next round asks again. A `false → true` transition calls back into the
poller, which is what makes a window that has just become the owner poll **immediately**
instead of waiting out the interval (five minutes by default). The gate is deliberately
not consulted again when the toast is shown: a handover is "the round belongs to
whoever started it", and the new owner's immediate round reads the baseline the old one
already wrote, so the same notification is not alerted twice.

The gate only governs the poller's own rounds. The notifications view's on-demand
`getNotifications` request is handled by the webview view provider directly, so **every
window still loads its notifications when opened** — a follower is silent, not blind.

### The setting is read live

`forgejoToolkit.multiWindowLease` (declared in `packages/forgejo-toolkit/package.json`)
defaults to on, and `isMultiWindowLeaseEnabled()` reads the raw value as `unknown` and
keeps the default for anything but an explicit `false`, so a hand-edited `settings.json`
cannot throw inside activation. The supervisor reads it on start and on **every change**
to it. Turning it off does not merely ignore the election: the timer and the focus
subscription are disposed and this window releases any lease it still holds, because a
window that kept heartbeating while the user asked for "every window polls for itself"
would hold the lease against the windows that did not opt out.

### Failure degrades into polling, once, with a notice

Anything that makes the mechanism unusable — an unreadable lease path, a claim that
reports `unavailable`, a heartbeat write that is not a transient lock, a full step-down
window of failed record writes — puts the window into the `degraded` role for the
session. Nothing is written any more, the gate opens, and the window polls and alerts
exactly as it does with the setting off: a failure degrades towards _more_ requests,
never towards silence and never towards a missing notification. A transient Windows
`EPERM` from a held-open handle is explicitly not this case: the heartbeat retries it
(`LEASE_HEARTBEAT_WRITE_ATTEMPTS` = 4 attempts, 250 ms apart), so a lock that clears
inside that span never becomes a reported failure.

Degrading shows **one notice per session** (`leaseDegradedNotice.ts`), with two real
buttons:

- **Copy Diagnostics** runs `forgejoToolkit.copyPollingDiagnostics`;
- **Turn Off in This Window** writes `forgejoToolkit.multiWindowLease: false` — at
  workspace scope when the window has a folder (a workspace value beats a user value, so
  a user-level write would look like a button that does nothing), otherwise at user
  scope.

The wording deliberately says the feature is not missing, only that requests are more
numerous; degrading is the safe direction, and a message that reads like an error would
teach users to distrust a mechanism that is working as designed.

### Polling diagnostics

`forgejoToolkit.copyPollingDiagnostics` (`commands/copyPollingDiagnostics.ts`) copies a
redacted JSON report to the clipboard and prints it, with a one-line summary, to the
output channel — which is also what answers "which window is polling, and when did it
last change hands" through **View Log**. The extension has no telemetry, so this payload
is the only evidence a bug report can carry. `buildPollingDiagnostics`
(`lease/pollingDiagnostics.ts`) is a pure function of its inputs and assembles:

- `schemaVersion` (currently 1) and `generatedAt`;
- `window` — role, focus, pid, nonce prefix, session id, workspace name and folders,
  extension host start, last heartbeat write, consecutive heartbeat failures;
- `visibleWindows` — this window first, then the current holder and every pid with a
  claim request on disk. The name is deliberate: it is **not** a registry of open
  windows, because a quiet follower leaves no trace on disk and cannot appear;
- `lease` — path and whether it is absolute, writability plus any probe error code,
  existence, the _validated_ record with `heartbeatAgeMs` / `expiresInMs` and the
  credential-field self-check (`containsTokenField`), the parse error when it could not
  be used, and the raw `.claim.*` files;
- `handover` — the last takeover or step-down this window took part in, with its
  direction, reason, latency (or why the latency is unknown) and requester count;
- `polling` — whether polling is enabled, the interval, whether the lease is enabled,
  the degraded reason and since when, whether the notice was shown, and the last and
  next scheduled poll;
- `versions.probeCache` — one row per configured instance with the redacted URL, the
  version the gates use and where it came from (`source`: `declared` / `probed` /
  `unknown`), the declared string verbatim when the record has one, and — when the value
  was read from the shared cache — when it was written and whether it is stale;
- `env` — extension and VS Code versions, OS/arch/release, locale, remote name.

Two rules are hard constraints rather than summaries: **no credential ever appears**
(no token, no `Authorization` header, no secret value, and no "has a token" boolean
either), and **the raw lease text is never included** (`rawTextIncluded` is the constant
`false`): a hand-edited file could hold anything. Instance URLs are included — they are
the user's own configuration and the only coordinate that identifies a row — after the
same userinfo redaction the log lines use.

### Focus following is unverified per platform

The leadership handover is driven by window focus, and the mechanism reads that signal
twice on purpose: `vscode.window.onDidChangeWindowState` starts the H clock exactly and
reports the transition, and **every tick also reads `vscode.window.state.focused`
directly**, so a platform that drops or delays the event costs at most one tick and
never the handover. A focus change the event did not report is logged with
`source=tick-fallback missedEvent=1`.

Whether a given platform reports focus faithfully — and in particular whether two
windows can both report `focused` — is **not verified per platform**. The mechanism is
built so that this uncertainty is harmless: when the focus signal is not trustworthy,
the correct behaviour is _no handover at all_, and that is what the guards produce. A
request from a window that is not focused never justifies a handover, an owner that is
itself focused refuses to yield (`owner-keep-focused` — the rule the 2026-09-27
dual-window soak forced), and the N window blocks a handover to a window that has just
taken the lease. "Nobody is focused" therefore needs no branch of its own: with no
focused requester there is nothing to yield to and polling simply continues where it
is. The cost of that conservatism is a handover that happens one poll interval later,
not a window that stops alerting.

### The accelerated takeover is dormant only for a cold-start streak

`follower-takeover-accelerated` is the one follower path that claims a holder which still
looks alive _before_ its record is stale: focused window, outside N, at least K
unanswered requests, and a record older than `LEASE_ACCELERATED_STALE_MS` (3 × heartbeat
= 30 s — three missed heartbeats is evidence of an unreachable owner, where a threshold
below one heartbeat could never tell a dead owner from a live one, which is what the 5 s
starting value did before the soak overturned it).

The arm is dormant only for a streak built from scratch, and the arithmetic is why. It
may only act inside the window `[3 × heartbeat, expiry)` — `[30 s, 35 s)`, five seconds
wide — while a follower that has to build its streak from scratch waits H = 12.5 s for
its first request and then needs K = 3 requests at the 2 s tick, about 6 s more:
18.5 s > 5 s, so the record always expires first and the takeover is the plain expiry
path. A streak that is already at K when the owner goes quiet is a different case, and
it is the one the arm now acts on: the K counter is cleared only by an ownership change
or by the election stopping (`resetFollowerRequestState`), never by a focus change, so
such a streak reaches the arm on the next 2 s tick while the holder's pid is still alive
and its record sits between 30 s and 35 s — and the arm really does displace that
live-but-silent holder there, because the release names the record the decision saw and
re-measures the age against `LEASE_ACCELERATED_STALE_MS` instead of `LEASE_EXPIRY_MS`
(the identity guard and the re-read threshold, and the decision that set them, are
recorded in the [design document's §4.1](../design/multi-window-polling-lease.md#41-当前主导者的心跳)).
Either way the record is never fabricated: the handover record states the latency it can
actually measure, and a handover it cannot measure reports `latencyUnknown` instead of
inventing a `0`.

The branch is kept correct, and pinned, because it is live rather than merely being
retuned: `src/__tests__/leaseDecision.test.ts` pins the 30 s literal, its being a
heartbeat multiple and `LEASE_ACCELERATED_STALE_MS < LEASE_EXPIRY_MS`, and
`leasePollingGate.test.ts` pins the cold-start inequality, so a heartbeat or K retune
that makes the escalation reachable from a cold start fails a test that must then be
replaced by one that exercises it.

## The shared version-probe cache

Activation probes `/api/v1/version` for every configured instance, and the answer gates
features (the Actions API needs ≥ 1.19; a version below the supported floor raises a
soft warning). With one probe per instance per window that work is duplicated N times,
so the probe result is stored beside the instance configuration and reused.

### One slot, one key

The cache lives in the editor's `globalState` under
`forgejoToolkit.serverVersions` — declared next to `forgejoToolkit.instances` in
`src/config.ts`, and installed into the cache module by `ConfigManager`'s constructor
(`createMementoServerVersionCache`), which is where the extension context and that key
are known. Entries are keyed by the normalised instance URL (trailing slashes removed),
so the configured and canonical spellings share one entry, and the slot holds three
sections: the instance entries, the `#inflight` markers and the `#notices` records. The
`#` prefix cannot collide with an instance key, which always names an authority. There
is no new file and no second key: every section is read and written through the same
merge write, and a store that is unusable (the MCP server process, a host without a
usable `globalState`) makes reads report "nothing shared" and the caller fall back to
its process-local map — nothing in the module throws at a caller.

The merge write re-reads the slot immediately before writing and replaces only the keys
this window is responsible for, so entries other windows wrote survive. That narrows the
race; it cannot close it, because `get` → `update` is not atomic.

### Fresh, stale, unknown — and why unknown allows

Every entry carries `writtenAt` and expires after `SERVER_VERSION_CACHE_TTL_MS` (60 s).
An expired entry is reported as `stale` rather than hidden — the diagnostics show the
value while the gates treat it as unknown — and the reader must probe again. The
direction is not negotiable: an expired "high version" would otherwise let a window run
gated behaviour for the rest of the session without ever probing, so _stale is unknown,
unknown is not a value, and unknown allows_. `resolveServerVersion` returns the shared
entry only while it is fresh and usable, with one exception — a probe this window itself
made _after_ the shared entry was written is newer knowledge about the same URL, and is
used if it is still fresh. Unparseable and unknown versions pass `isVersionSupported` and
`assertActionsSupported`, which is the same fail-open direction.

An instance save or edit invalidates the entry: `clearServerVersion` deletes the shared
entry, but that write is asynchronous, so for a moment afterwards the entry it
invalidated still reads — and may still look fresh. The window therefore records
`versionInvalidatedAt` first and treats any entry written at or before that stamp as
unusable (`isSharedEntryUsable`), which is what keeps the refresh that follows a save
from silently skipping the network. Removing an instance deletes its entry, marker and
notice record together.

### The declared version comes first

The probe can be wrong or unavailable: a reverse proxy or path prefix that blocks
`/api/v1/version`, an unrecognised fork or version string, a timeout on an unreachable
instance, a renumbered upstream. Features then silently disappear, so the user can state
the truth instead. `forgejoToolkit.instances` carries an optional
`declaredServerVersion` per instance, edited where the instances are edited (the Settings
form) and validated with the same `parseServerVersion` the probe's answer goes through —
a value that does not parse is refused with a readable message, never stored and
silently ignored. An absent field is "no declaration, use the probe"; an older record
simply has none.

`resolveServerVersion` states the order in one place: **declared → probed → unknown**. A
declaration wins outright — it is read from the instance record (through a reader
`ConfigManager` registers, so the module stays free of `vscode`), not from the probe
cache, and the cache is not consulted at all — so the probe, the 60-second TTL and the
cross-window merge write cannot overwrite, expire or displace it. `probeServerVersion`
does not even send the request for a declared instance; it raises the low-version notice
from the declared value, with wording that names the declaration, because the user's own
statement is what makes the extension refuse. Every gate reads the same resolution, so
`assertActionsSupported` refuses a too-low declared version and says so.

The polling diagnostics report the resolution: each instance row carries `source`
(`declared` / `probed` / `unknown`), the declared string verbatim and the value the gates
used, so a bug report can tell why a feature was offered or refused.

The declaration is a property of the instance, so it has to hold wherever the instance is
resolved — not only in the window that owns the record:

- **The MCP server the extension provides** forwards into the broker, so the host's client
  and the host's reader apply; nothing extra is carried.
- **The MCP server launched from a static `mcp.json`** (the Agents window / Agent Host, or
  a third-party client) builds its own client when no broker is reachable, and has no
  instance record. It therefore reads the declaration from the registry the extension host
  publishes next to the per-window state files — `globalStorage/mcp-instances.json`, whose
  entries gain `declaredServerVersion` — and installs it as the same reader through
  `setDeclaredServerVersionResolver`, so it resolves declared → probed → unknown with the
  same source reporting and the same "a declared instance is not probed" rule
  (`registerDeclaredServerVersions` in `mcp/autoConfig.ts`, called by `mcp/server.ts`). The
  value is a version string in an already credential-free file: no new environment
  variable, no new launch argument, and no secret channel. A registry with no declaration
  for the instance — or a carried value that cannot be a version — leaves the probe in
  charge, exactly as before.

### The in-flight marker

A fresh entry is not enough to stop two windows probing at once. `withSharedServerVersion`
is the coordination every prober goes through: use the cache if it can already answer;
otherwise, if another **live** window is probing, wait — bounded — for that window's
entry and adopt it; otherwise claim the marker, probe, record the result, release the
marker. The marker is `{ pid, at }` under `#inflight`:

- it stays believable for `SERVER_VERSION_PROBE_MARKER_TTL_MS` (45 s), which outlasts
  the probe's own 30 s request timeout plus the merge write that follows it;
- a marker whose pid is no longer alive (`process.kill(pid, 0)`, `EPERM` counted as
  alive) reads as absent immediately — waiting on a dead prober is the one case the
  wait bound cannot settle quickly — and is taken over;
- the waiter re-reads every `SERVER_VERSION_PROBE_POLL_INTERVAL_MS` (200 ms) for at most
  `SERVER_VERSION_PROBE_WAIT_TIMEOUT_MS` (10 s, inside the 5–15 s the design allows),
  and gives up early when the marker disappears, is its own, or its owner died;
- on any of those, on a claim lost to another window, or on a store that cannot be
  read, the window probes itself. Every wait is bounded and fails open.

### The notice record

Only the window that actually probed raises the low-version warning, so the value
adopted from the cache does not warn a second time — an adopted value was reported by
whichever window produced it. The `#notices` record keeps that decision across windows:
`recordSharedServerVersionNotice` returns `true` only for the first caller for a given
version, and `writeSharedServerVersion` clears the notice when the version changes, so a
server that is downgraded and then upgraded can warn again about the new version. A
store that cannot be written reports the caller's own first-ness honestly, because
suppressing a notice the user needs is worse than repeating one.

### The on-demand re-probe at the gate

The TTL makes the cache safe but, on its own, also makes the gate decay: nothing
re-probes on a schedule, so 60 s into a session the recorded version is unknown and
`isVersionSupported(undefined) === true` opens every gate for the rest of it. The answer
is not a background timer but to ask at the one moment the answer is about to be used.
`assertActionsSupportedAfterProbe` probes when `getServerVersion(url)` is unknown, then
evaluates `assertActionsSupported`; the probe's own failure is swallowed, and the gates
that follow see "unknown" and allow.

That is the path every gated call takes. The nine Actions methods on `ForgejoClient`
(`api/client.ts`) route through `_assertActions`, which calls the probe function above
with `_probeAndRecordServerVersion`. The probe is deduplicated in two layers: within
this process, concurrent gated calls share the promise cached on the client; across
windows, the fetch runs inside `withSharedServerVersion`, so a window that sees another
window's live marker waits for that window's entry instead of issuing its own request.
`probeServerVersion` (`api/versionProbe.ts`) is the activation-time entry point: it
consults `reusableSharedServerVersion` first and returns without a request when the
entry is fresh, and only the window whose probe produced a version calls
`warnIfUnsupported`.

Broker sessions reach the same code: `mcpBroker.ts` builds the same `ForgejoClient`, so
tool calls take the same gate — and the broker runs inside the extension host, where
`ConfigManager` has installed the shared slot. The standalone MCP server process
(`mcp/`) is one of the hosts without a usable `globalState`, which is exactly the case
the process-local fallback and the bounded probe exist for.

### Why a cache and not an arbiter

`globalState` has no cross-window change event and its `get` → `update` is not atomic,
so a concurrent write can be lost. That is acceptable here and only here: a lost update
costs one extra probe and can never change a decision about who polls — the election is
file-only and never reads this key. The same reasoning covers the marker, which exists
only to save one of two racing windows a request: a marker that is lost, ignored, or
overwritten costs one probe, never a wrong gate and never a blocked user action.

### Accepted residue

Two windows that write a marker inside the same read-check-write span can both be told
`true` and each probe once; `globalState` cannot make that span atomic, so the residue is
knowingly accepted rather than papered over. It costs one duplicate request, and the
notice record is what keeps it from becoming a duplicate warning: the window that loses
the race re-reads `#notices` after its own probe and stays quiet.
