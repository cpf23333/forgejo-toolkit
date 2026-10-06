---
'forgejo-toolkit': minor
---

**Suggest labels for an issue.** An issue's page now has a **Suggest labels** action: a
chat model reads that issue's title and body and the repository's own label list — every
label's name and description, with archived labels left out — and proposes the labels
that apply, each on its own line with a checkbox. **Nothing is applied for you**: tick
what you agree with and press **Apply in the edit form**, and the issue's edit dialog
opens pre-filled — a label is written when _you_ save that form, never before, and the
extension itself never writes one. It suggests labels only: it does not read, send or
suggest assignees, and it never touches the assignee field. A repository that declares no
label at all does not show the action, because there would be nothing to suggest. Off by
default, and separately from the two other AI features.

What may leave your machine is your own decision, recorded in
`forgejoToolkit.issueTriagePromptScope`: `issue-only` sends the issue's own text plus the
repository's label list, and `issue-and-comments` adds the discussion, each comment with
its author and date. The default `ask` means the first run shows one modal naming the
provider that would receive the content and what each answer sends — nothing is read,
requested or sent before you answer, and your answer is stored there so you are asked
once. Only what that run actually read can become a suggestion: a label name that does
not exactly match one of them is dropped and counted in the panel rather than matched
approximately. The model comes from the same place the other AI features take theirs —
your editor's models, or a configured endpoint bound to `issueTriage` — a failure is
reported and never retried on another model, and an answer the endpoint stopped at its
own output limit says so. Both of this feature's settings are machine-scoped, so a
workspace cannot turn it on or widen what it sends.
