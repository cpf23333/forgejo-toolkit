---
'forgejo-toolkit': minor
---

Add the AI pre-review: a `forgejoToolkit.aiPreReviewPullRequest` action — offered on the pull request
detail page as the button "AI pre-review (whole PR)", and from the pull request diff editor's title as
the fast path out of an open diff — that asks a chat model (through `vscode.lm` on the host) to review
the whole pull request and turns only the comments you confirm into drafts of a pending review. It
never submits a review, nothing is written unconfirmed, and the confirmation list starts with nothing
selected. Off by default through the `forgejoToolkit.aiPreReview` setting; with it off the command
refuses without sending anything, and the affordances are not offered at all — the detail page's
button hides while the switch is off and follows a change to that setting live, and the diff editor's
title entry requires the switch as well as `forgejoToolkit.inPullRequestDiff`, so a run is no longer
offered only to refuse once clicked. The button reviews the whole pull request because that is what a
run does: the action is **no longer contributed to a single file's context menu**, where the offer and
the scope did not match, and it sends nothing by being rendered — the click is what asks, and it posts
the pull request's coordinates to the host, which validates them and runs exactly the flow the diff
editor's title button runs. The run says its scope wherever it speaks: the progress lines name the
whole pull request (with the number of changed files once the file list has arrived), and the
cancellation, "no usable comments", model-failure, budget and contract-failure messages say the same.
Anchors are validated against the diff's real lines and dropped — never moved, flipped or clamped —
when they do not fit, and the run shows cancellable progress while it reads and asks.

**Which chat model reviews a pull request is your choice, and the extension neither makes it for you
nor switches between models.** `forgejoToolkit.aiPreReviewModel` is the one place that choice lives,
and it is an ordinary setting you can see and edit in the Settings UI: leave it empty — the default —
and the next pre-review lists **every** chat model VS Code offers and asks which one to use, showing
each model's name, `vendor/family`, id and input budget together with the provider that would receive
the brief; the pick is written into that setting and used for the run, so every later run uses that
same model without asking. Dismissing the list cancels the run with nothing sent, nothing created and
the setting unchanged. The command `forgejoToolkit.aiPreReviewChooseModel` (in the command palette,
available whatever the feature switch says, since choosing sends nothing) changes the choice later,
and every message that needs one points at it. The extension's own Settings page offers that same
choice where you look for settings: a dropdown built from the models VS Code is offering at that
moment — each row naming the model and its `vendor/family`, with the provider that would receive the
brief and the model's input budget on the row's detail line — a refresh button for the list, since it
changes between runs, and, when there is nothing to offer, the reason on screen instead of an empty
dropdown. Picking an option writes the same value into `forgejoToolkit.aiPreReviewModel` at the same
global scope the command writes, and the page tells you whether the write landed. The manifest field
itself stays free text: a contributed setting is a static declaration, and VS Code cannot render a
runtime list as its dropdown. Your configured model is used as it is: validation never substitutes
another one — a value that is not one of the accepted `vendor/family` or `vendor/id` forms, or that
names a model VS Code does not offer, refuses the run and lists every offered model with its
`vendor/family`, its id and its `maxInputTokens`; a chosen model whose input budget cannot hold the
feature's fixed instructions is refused with both numbers (tokens needed, tokens available) and a
pointer at the command, with no larger model swapped in behind your back; and a request that does not
fit after whole files are dropped names the same two numbers. When a model's answer is not the JSON
the feature asks for, the run asks **that same model** the same question again — at most two asks of
the one model you chose, so at most two model calls in a run — because a provider that answers an
empty stream or a fragment on one call often answers the next; the evidence for that is a probe over
12 offered models and 3 request shapes (36 calls, only 6 of which returned anything, all of them a bare
`{}`) plus a real run that failed 3/3 with 5–10 character fragments. Only a contract failure is
retried: a failing model call, a declined consent, a cancellation, or a valid answer whose anchors were
all dropped still ends the run, and the retry never moves to another model. If both attempts fall short
the message names the model, how many calls the run made, and how each answer fell short (an empty
answer, an answer that is not JSON, or JSON whose shape is wrong, naming the field), and points at the
choose-a-model command instead of leaving you with "try again".

**What the model receives is decided by `forgejoToolkit.aiPreReviewPromptScope`**, which replaces the
boolean `forgejoToolkit.aiPreReviewIncludeDiff`. The old switch defaulted to off, and with it off the
model received no code at all — only the pull request's metadata, the changed-file paths and their line
counts, and the metadata of existing review comments — so the review looked like it had worked while it
could not really review anything. The new setting's default, `ask`, means "you have not chosen yet":
the first pre-review that reads it shows **one modal** naming the provider the content would go to and
what each answer sends, **sends nothing and writes nothing before you answer**, and ends the run if you
dismiss it (nothing requested, nothing sent, nothing created). The answer is written into the setting at
global scope, exactly like the model choice, so it is visible and editable in the Settings UI and the
question is asked once rather than once per run; set it back to `ask` to be asked again. The four
stated scopes are `metadata-only` (the model sees **no code at all** and can only comment on file-level
matters), `changed-lines-only` (the added and removed lines with their file and hunk headers, and none
of the surrounding context — the cheapest scope that still sends code), `full-diff` (the whole diff,
exactly what the removed switch sent, including the context lines) and `changed-files` — the
**recommended** scope — which sends the whole diff plus the **full text of every changed file at the
pull request's head version**, so the model can read the code around a change. Every scope keeps the
existing budgets (`PR_REVIEW_DIFF_BUDGET`, `PR_REVIEW_MAX_DIFF_FILES`) and adds a file count cap and a
shared character budget for the file texts; a cut drops whole files from the end and says so in the
prompt. Only files the pull request changed are read, the diff is still fetched in every scope because
anchor validation uses its line tables, and no scope sends an access token, a URL or host name, or the
body of an existing review comment. A leftover value of the removed key is not a choice: the extension
does not read it at all, so a `settings.json` that still holds it is simply flagged by VS Code as an
unknown setting and the extension behaves exactly as if it were not there.

**The answer is read from the response's stream parts, and `LanguageModelChatResponse.text` is kept
only as a fallback.** On some providers `text` is not the answer at all: measured on a real machine, one
provider's chat model returned the expected 27-character JSON literal in the response's text parts
while `text` delivered the model's reasoning trace (`{"":",cdef12`), so every pre-review against that
model failed with "the answer was not JSON" and created nothing. The extension now consumes the response
once, collects the text parts and the reasoning parts as separate candidates, and lets the JSON contract
decide which one is the answer — text parts first, reasoning parts next if the text parts are absent or
do not satisfy the contract, and the `text` projection last when neither candidate carried text. Two
candidates are never concatenated, a candidate is never repaired, and no other model is substituted.
When nothing satisfies the contract the run fails exactly as before (the failing model, the attempt
count and a bounded excerpt of the answer it examined) and creates nothing. At debug level the run now
names the stream it used and the reason, and the diagnostics dump records both candidates, labelled.
Runs whose answer already arrived through `text` behave as they did.

**Confirming what to keep is a purpose-built editor-tab panel, not a quick pick.** The confirmation step
used to be a multi-select quick pick, which put each proposed comment's body inside its label — where VS
Code truncates it — and set no `description` and no `tooltip` for the rest, so a person could not read
the comment they were about to accept; the panel gives every candidate a card with its **whole body**
(wrapped and selectable) and its anchor (`path:line` or range, plus the side), a checkbox, and a link
that opens the pull request's diff at that line on the anchor's own side. The header states what the
quick pick had no room for: the pull request, the model that answered (with its vendor, so the privacy
point stays on screen), the **prompt scope that run actually used**, how many candidates passed the
anchor validation, and how many were dropped, **grouped by reason**. Nothing is checked by default and
the extension contributes no accept-all control of its own; the platform's `Toggle all checkboxes`
belonged to VS Code's multi-select quick pick, which this panel does not use. Checking cards and
pressing Create writes them as drafts of a **PENDING** review through the existing path — the extension
still never submits a review — and the panel then shows the outcome and a button that opens the pull
request. Cancelling, pressing Escape or closing the tab creates nothing. Apart from the body text you may
edit, the answer names only cards the panel offered, so a modified webview message can select what it
was offered but never invent a comment: the anchor fields it sends are ignored, and the paths and shas
come from the host's own copy. **The body of a card is editable before it becomes a
draft**: each card is a multi-line editor pre-filled with the model's wording, what you leave in it is
what the draft is created with, an edited card is marked `Edited` and offers one click to **restore the
wording the model proposed**, and the input is capped at the extension's per-comment limit (1024
characters) with the cap stated when it is reached instead of the text being cut silently. Only the body
is editable: the anchor (path, line, range, side) still comes from the run's own validated candidates
and is never sent by the panel, so a modified page can propose text but cannot move a comment. The
answer now carries the checked cards together with their bodies (`entries: [{index, body}]` instead of
`indexes: []`), and the extension re-validates every entry before writing anything — the index must be
one it offered, the body a string that is non-empty after trimming and within the limit — refusing the
**whole** create, with one message naming the card, if any entry fails. A ticked card whose body was
emptied is refused the same way rather than skipped silently, because creating fewer drafts than the
button promised is the surprise this refusal exists to prevent. A body the extension itself had cut now
carries its "truncated" announcement inside the cap, so such a card can still be created unedited.

**Comment bodies are written in the language you read the extension in**, instead of always in English.
The prompt the feature sends is an English instruction block, and nothing in it named your language — so
every candidate body came back in English whatever the editor's language was, which an acceptance run on
a Chinese editor showed. The run now resolves the language exactly as the rest of the extension resolves
the interface it presents to you: `forgejoToolkit.locale` when it states `en` or `zh` (and that setting
wins if it disagrees with the editor, because every surface that shows these bodies — including the
confirmation panel — renders in it), and VS Code's display language otherwise, with anything unexpected
reading as English rather than being guessed at. The language is named in the prompt in its own script
(`简体中文`, `English`), and the rule draws the same line the JSON contract draws: the keys and every value
that is not prose — the schema's field names, `"head"`/`"base"`, paths and the numbers — stay exactly as
specified, and only `body` is written in that language; otherwise an anchor's path or side could come
back translated and be dropped by the validation that never repairs one. The instruction block is still
built once per run, so both attempts of the model you chose send the same bytes, and the debug-only
diagnostics dump still shows the exact messages that went out.

A failed answer is diagnosable without turning debugging on: each failed attempt writes one line to the
"Forgejo Toolkit" output channel naming the model by vendor, family and id, saying which attempt of the
chosen model it was, how long the answer was, and quoting a bounded excerpt of the answer — at most 200
characters, escaped onto a single line, so the handful-of-characters fragments a flaky provider returns
are visible in full while a long answer is cut. A successful run still logs no answer text at all, and
the excerpt never carries the brief, the diff or the prompt; the debug-level shape line is unchanged and
the full answer stays in the debug-only diagnostics file. The new
`forgejoToolkit.aiPreReviewOpenDiagnostics` command ("AI Pre-Review: Open Diagnostics") opens
`ai-pre-review-diagnostics.log` in the editor, or — when it does not exist yet, which is the normal state
while `forgejoToolkit.debug` has never been on — says so and names the setting that creates one; reading
a local file sends nothing, so the command is offered whatever the feature switch says. A run that only
succeeded on the retry logs which attempt answered and how many calls the run had spent by then. With
`forgejoToolkit.debug` on, a run also appends the exact messages it sent and the full raw answers it
received to `ai-pre-review-diagnostics.log` in the extension's log directory — one block per model call,
numbered both as the ask of that model and as the call of the run, so a model asked twice can be told
apart — and the new `forgejoToolkit.aiPreReviewProbeChatModels` command — offered only while that setting
is on, and sending nothing while `forgejoToolkit.aiPreReview` is off — asks the model you chose (the one
`forgejoToolkit.aiPreReviewModel` names) the same trivial question with each request shape, so a model
that cannot answer an extension at all can be told apart from a request it cannot handle; it asks nothing
at all while that setting is empty or names a model your editor does not offer, saying which of the two
it is and listing the offered models instead of spending calls on models you did not choose, and the dump
header records which model was asked and why. With debug off no diagnostics file is written at all, the
channel still carries only the bounded excerpt on a contract violation, and the probe sends nothing while
`forgejoToolkit.aiPreReview` is off.

Two smaller fixes ride along. The debug-only `forgejoToolkit.aiPreReviewProbeChatModels` command's palette
entry now requires the feature switch as well as `forgejoToolkit.debug` — its handler already refused
while the switch was off, and it still checks both settings itself — while the run command is unchanged
apart from that: it still refuses when the switch is off, and it still stays out of the command palette,
and choosing a model was never gated on that switch. And a status-check state this extension has no
wording for no longer prints the raw `dashboard.detail.checksState.…` key in the pull request's checks
panel: a combined status it does not recognize now shows the localized "Unknown" label, the same fallback
the merge-blocker line already used.
