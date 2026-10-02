---
'forgejo-toolkit': patch
---

The generated API client now comes from kubb 5 instead of kubb 4. The generated
code still sends every request through the project's own request layer, so proxy
handling, timeouts, cancellation, retries and the error type the extension
reports are unchanged — that is what the migration turned on, and it needed no
hand edit to generated output: the generated operation takes the client per call
and the bundled client resolves its transport, so the shared request layer is
simply the transport. Two things did change behind the scenes. The endpoint audit
that compares what the client calls against the pinned specification read the old
generated shape, so it had been reporting zero endpoints while exiting
successfully; it now reads the specification by operation id and fails loudly
when it can resolve no operations or match no call site. And the generator's
wrapper settings are pinned back to the previous behaviour — integers stay
numbers, barrels stay named, responses still return their body — instead of the
new defaults. Path parameters are now percent-encoded by the generator, which the
previous one did not do; a serializer that keeps separators preserves single
segment routes and nested file paths, and it re-adds the refusal of `.` and `..`
segments. No user-visible behaviour changes.
