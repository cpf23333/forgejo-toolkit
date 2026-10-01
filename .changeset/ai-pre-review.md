---
'forgejo-toolkit': minor
---

Add the AI pre-review: an action on the pull request detail page and from the diff editor's title that asks a
chat model to review the whole pull request and turns only the comments you confirm into PENDING drafts, never
submitting one.

**Which model reviews is your choice** (`forgejoToolkit.aiPreReviewModel`; the extension neither picks one for
you nor substitutes another), and **so is what it receives**: `forgejoToolkit.aiPreReviewPromptScope` replaces
the old boolean, whose default `ask` shows one modal on the first run — naming the provider and what each
answer sends — and writes nothing until you answer, so the question is asked once. Its scopes are
`metadata-only` (no code), `changed-lines-only`, `full-diff` and `changed-files` (the recommended one).

**Confirming what to keep is a purpose-built panel**, not the quick pick that hid each body in a truncated
label: each candidate gets a card with its whole body, its anchor and a link into the diff, nothing is checked
by default, and the extension adds no accept-all control. **The body is editable before the draft exists**, and
the panel's `{index, body}` entries are re-validated host-side: any entry not offered, empty after trimming or
over the per-comment limit refuses the whole create, and bodies follow your language.

**The answer is read from the response's stream parts, with `text` as a fallback**, so a provider whose `text`
is the reasoning trace no longer fails with "the answer was not JSON". A failed answer is diagnosable without
debugging on: each attempt names the model and quotes a bounded excerpt of the answer (at most 200 characters),
while a successful run logs no answer text. The debug-only dump and the command that opens it,
`forgejoToolkit.aiPreReviewOpenDiagnostics`, are unchanged.
