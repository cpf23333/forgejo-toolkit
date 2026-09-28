---
'forgejo-toolkit': patch
---

A hung window is now taken over about one heartbeat earlier. When a focused
window has already asked the lease holder K times for the lease and the holder's
heartbeat is more than 30 s old (three missed heartbeats) while its process is
still alive — a hung window — the accelerated takeover really happens at ~30 s
instead of waiting out the 35 s expiry. The release that precedes the takeover
used to re-check the record against the full expiry, answer `not-owner`, fail the
create and leave the handover to the ordinary expiry path several seconds later;
it now re-checks against the same 30 s threshold that justified the takeover, and
only against the exact record the decision saw (same pid, owner nonce and claim
time), so a record another window wrote in between can never be unlinked. Nothing
else changes: the anti-ping-pong window N, the K counter and the ordinary 35 s
expiry path are untouched, and a window with fewer than K unanswered requests
still waits.
