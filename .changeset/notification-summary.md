---
'forgejo-toolkit': minor
---

**A discussion summary, from the notifications list or the issue / pull-request detail page.** An issue or
pull-request notification now offers **Summarize discussion**, and so does the issue or pull request's own
detail page: a chat model reads that entity's timeline and the read-only summary opens in an editor-area
panel whose header names the model, the scope tier that run actually used, and whether anything was
truncated.

The feature is off until you enable `forgejoToolkit.notificationSummary`. The first run then asks once
which scope may be sent — the opening post on its own, the post and its comments, or those plus the
metadata of timeline events — and records your answer in
`forgejoToolkit.notificationSummaryPromptScope`. Until you answer, nothing is read, no model is called
and no setting is written. Nothing is ever written back to the server, and the summary is not stored.
