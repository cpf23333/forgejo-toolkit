# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- Maintainers: the `## [<version>]` section is extracted verbatim and published
     as the release body (see `.forgejo/workflows/release.yml`), so keep it
     user-facing and up to date — never place maintainer notes inside a version
     section. This root file is the authoritative release-notes source, and it is
     also the copy that ships with the extension
     (`packages/forgejo-toolkit/CHANGELOG.md`, kept byte-for-byte identical by a
     test); the per-package changelog `pnpm run version-packages` writes is only a
     fallback for the release body. While a version is unreleased its notes stay
     under `## [Unreleased]`; cutting the release renames that heading to
     `## [<version>] - <date>` and opens a fresh `## [Unreleased]` (step 1 of
       the checklist in `docs/release.md`, before the release runs). -->

## [Unreleased]

### Added

- **Configure your own AI endpoint.** The AI features no longer depend on the
  language models your editor happens to offer: the settings page has an AI
  Endpoints section where you add an OpenAI-compatible endpoint — a server on your
  own machine or a hosted gateway — with its display name and id, its address, its
  authentication style (`Bearer`, an `api-key` header, or none), the models it
  declares (id and display name), custom request headers, and a local-only switch.
  The API key and **every** header value live in the editor's secret storage and
  are never written into settings — a gateway usually carries its token in a
  header — so the page says only whether a value is set, and clearing one is an
  explicit action. Everything here is machine-scoped, so a workspace cannot point
  your requests at an address of its own choosing, and an endpoint id or display
  name you leave blank is generated from the address (collisions get a suffix, and
  the page warns while you create one that its id cannot change afterwards, because
  the stored secrets are keyed by it). **Test connection** runs against one endpoint
  and reports the address it used without the query string that can carry a
  secret. The AI pre-review can run on such an endpoint instead of on your editor's
  models.
- **Decide whether the extension may send, and to where.** Saving an endpoint and a
  key is not permission: a separate switch has to allow requests to configured
  endpoints, and each feature still asks its own question about what may leave your
  machine, so a configured endpoint and a stored key send nothing by themselves. A
  local-only rule — global, and once more per endpoint — refuses any endpoint whose
  host is not this machine or a private network; the configured address is what is
  checked, no name lookup is made, and an address that cannot be read counts as not
  local. A per-feature binding names the endpoint and the model a feature uses, and
  every run states in its confirmation panel, its diagnostics and the log which
  transport, endpoint, address and model served it, so you can see where your
  content went. The two ways of reaching a model never substitute for each other:
  an endpoint that fails is reported as a failure and never quietly falls back to
  your editor's models, or the other way round.
- **The endpoint's model list is detected for you.** The endpoint editor asks the
  endpoint for its model list once you have typed an address and a credential (or
  changed the authentication style) and stopped for about 800 milliseconds, and
  fills in only the model rows you have not written yourself — anything you typed
  stays as it is. One request is sent per combination of address, authentication
  style and credential, further typing cancels the pending one, only the model
  listing is ever requested (never a completion), and nothing is written to your
  settings before you save. An address the local-only rule refuses is refused
  before a byte leaves the machine, a probe that gets no answer says so on the
  model rows and in the report card below them, and an endpoint that has no model
  list at all is not a failure: the report says the models have to be filled in by
  hand.
- **Your AI endpoints travel with the rest of your configuration.** An export now
  carries a non-secret AI section — each endpoint's display name, address,
  authentication style, declared models, the **names** of its custom headers, the
  local-only policy and the per-feature bindings — and importing it offers those
  endpoints in the same preview the instance list already uses: a plain `http://`
  address is called out there rather than only when a request is finally attempted,
  an id you already have is a choice between keeping the configured endpoint,
  importing the file's alongside it under a new id, or replacing it, and the preview
  states plainly whether the file carried any credentials at all. The API key and
  every header value go into the export **only** when you encrypt it, on the same
  path as the instance tokens, and on the way back they are stored in the editor's
  secret storage rather than in settings — an unencrypted export contains none of
  them, which the export itself says before it writes the file, and importing one
  leaves the credentials you already had for that endpoint in place. Importing
  cannot turn anything on: it never writes the switch that allows requests to
  configured endpoints, never enables an AI feature, and never changes the model
  transport you chose, so the first run after an import still asks you what may
  leave your machine. An export written by an older version still imports, and
  importing an endpoint whose address this extension refuses would say so in the
  preview instead of writing it.
- **Your settings page now covers the settings.** Nine settings that used to be
  reachable only through the editor's own settings user interface are now presented
  where they belong: the notification polling switch, the multi-window polling
  lease, the MCP server switch with its three write-tool gates and the write-audit
  switch, and the AI pre-review switch with its prompt scope — the consent value
  that decides how much an AI pre-review may send, which until now could neither be
  seen nor changed from the page that owns the feature. Each one states its default
  in words instead of prefilling it, and changing one writes only that setting; when
  the editor refuses a write, the control goes back to the stored value and says
  what the host answered. The two settings that stay in the editor's own settings
  interface — the polling interval, because it is a bounded number, and the model
  transport, because it is a three-value choice — are named in place in their
  sections, with an entry point that opens the editor's settings filtered to this
  extension so the rest are one click away.

### Changed

- The release guide now opens the next `## [Unreleased]` section before the
  release runs, in the same commit that names the released section for its
  version, so the changelog always carries a place for the next cycle and nothing
  depends on a step remembered after the release.

### Fixed

- An AI pre-review against an endpoint that stopped at the endpoint's own output
  limit now says that, instead of only that the answer was not JSON. The message
  names the endpoint the way the consent question does, says the answer hit the
  endpoint's output limit and could not be read because of it, and offers the two
  ways out — raise the limit configured on the endpoint, or choose a model that
  follows the instruction — and it is said at most once per run, even when both
  attempts were truncated. The diagnostics file records the same fact. Your
  editor's own model API reports no such reason, so this message never appears on
  that path.

## [0.1.1] - 2026-10-02

### Changed

- The extension is bundled by the same Rolldown engine that already builds the
  webviews, so the packaged extension is about 20% smaller (1,926,650 bytes to
  1,541,037, and 16.9% smaller gzipped) and both builds are faster. Nothing about
  the extension's behaviour changes.
- The release guide now names the changelog section for the version being
  released **before** the release workflow runs, instead of renaming it
  afterwards: the dry run's `found the section for this version` line becomes
  a real check, and the notes never call a published version unreleased.

## [0.1.0] - 2026-10-02

### Highlights

- The AI pre-review is usable end to end, and every decision stays yours: you
  choose the model and you choose what leaves your machine. Nothing is sent until
  you answer the one-time question about the prompt scope, whose recommended
  answer sends the diff plus the changed files themselves.
- Its proposed comments arrive in a panel where nothing is checked by default and
  the wording can be edited before any draft exists, so nothing becomes public
  until you submit the review yourself.
- **Replying to a review comment** works from the comment thread. The reply lands
  on the pull request where everyone sees it and is echoed into the thread it
  answers, so it is still there after a window reload.
- The workflow dispatch form offers the inputs a workflow declares and a ref
  selector that lists branches **and** tags, so a tag can be dispatched.
- A comment can now be added to a multi-line selection, and the right side of a
  diff is the one that gets the comment.

### Added

- **Reply to a pull request review comment** from the thread itself. Forgejo has
  no reply object, so the reply is an ordinary pull request comment carrying the
  platform's own quote block — the attribution line naming the original author and
  linking the original comment (`@user wrote in <url>:`), a blank line, and the
  quoted comment line by line — but written with **your text first**, a blank
  line, then that quote block, and with leading blank lines in your text dropped
  so the body's first line is never empty. That order is a deliberate divergence
  from the platform's own replies, and the reason is measured: Forgejo's instance
  home activity feed stores the **first line** of a comment body as its
  activity-row excerpt (hard-truncated with `…` at roughly 190 characters) and
  renders that instead of the comment, so a quote-first body reads there as its
  quote — our quote-first reply showed the quote (comment 123, activity row 580),
  Forgejo's own web-UI quoted reply showed only its attribution line (comment 125,
  row 582), and a reply whose body carried no quote at all showed its text
  (comment 124, row 581). Reply-first puts your own words in front of every
  excerpting consumer (home feed, notifications, mail, mobile), and the quote
  still renders as a quote. The reply is posted as a **pull request timeline
  comment** — the issue-comment endpoint (Forgejo's web UI writes its own replies
  as review comments with `origin=timeline` and `reply=<comment id>`; a possible
  future refinement, not what this path does) — so it is visible on the pull
  request immediately and needs no review submission. A successful post is also
  **echoed into the thread you replied in**, below its
  comments: the reply as posted, read-only and marked **Posted to the pull
  request timeline**, so it is not mistaken for a review comment. The echo is a
  rendering aid over server data, not a server object — it is never written back,
  re-posted or counted — and it is **re-derived from the pull request's timeline
  on every render**: the extension reads that timeline, matches each quote
  reply's attribution line (`@user wrote in <url>:`) to the review comment its
  URL names, and attaches it to that comment's thread. So the reply is still in
  its thread after a **window reload**, and replies composed elsewhere —
  Forgejo's web UI, a phone — appear in the thread as well. The local echo left
  from the POST only covers the moment before the timeline returns the new row;
  the two records are deduped on the timeline comment's id, so the reply renders
  exactly once. The timeline read is one request per render pass (shared by all
  open files of the pull request and cached briefly; a file with no comment
  thread issues none), paged to the shared 500-item list cap. Your **pending
  review** is left alone: that draft area belongs to the
  AI pre-review, whose drafts stay invisible until you submit the review, while a
  reply placed there (as earlier builds did) stayed hidden in the timeline until
  you submitted the whole review and picked a verdict. All the comments on one
  anchor render as a single thread — which is how the web UI shows an anchor — so
  the thread you answer is the conversation, and `canReply` is on for every
  thread the extension creates. Before anything is sent, the anchor the thread
  carries (path, line, range and side) is revalidated against the pull request's
  real diff lines: a line that a force-push or a rebase removed is refused with a
  message, never moved to a nearby line, and the comment being quoted must still
  be readable from the thread it came from. A failed POST is reported and leaves
  nothing that looks posted. Replying is your own action, not the AI feature: it
  works with `forgejoToolkit.aiPreReview` off.
- `forgejoToolkit.mcpEnabled` (default on): turning it off withdraws the MCP
  server definitions and stops the workspace mapping and the local broker, so no
  agent reaches your instances through them.
- **Write Copilot Instructions** command: writes (or updates) a short section in
  the workspace repository's `.github/copilot-instructions.md` naming the
  Forgejo instance and repository the workspace maps to.
- `forgejoToolkit.multiWindowLease` (default on): with several VS Code windows
  open, only the window you are working in polls Forgejo for notifications and
  raises the alerts, so an instance is no longer polled once per window and a new
  notification no longer raises one alert per window. The other windows stay
  quiet and still load notifications when you open the view.
- **Copy Polling Diagnostics** command: puts a redacted JSON report of this
  window's polling and lease state (which window is polling, the last handover,
  the poll interval, the instances' probed versions) on the clipboard, for bug
  reports. It never contains an access token or any other secret.
- Two design documents for future work: the confirmation model for MCP write
  tools, and a multi-window polling lease.
- The MCP server's first **write** tool, `create_issue_comment`, which adds one
  comment to an issue or pull request. It is off by default and only available in
  a session the extension host itself established (an extension-provided MCP
  server, or a static configuration served through the host's broker): a
  configuration that only carries your own token can read but never write. VS
  Code asks you to confirm every call — the tool deliberately does not claim to
  be read-only — and the extension asks separately, through the new
  `forgejoToolkit.mcpWriteTools.createIssueComment` setting. The tool refuses,
  with an explanation naming that setting, when either gate is closed, and it
  supports `dryRun: true` (report the plan, send nothing) and an
  `idempotencyKey` (reuse it on a retry; within ten minutes the earlier result is
  returned instead of writing a second comment).
- `forgejoToolkit.mcpWriteAuditToFile` (default off): also append the MCP
  write-tool audit records to `mcp-write-audit.jsonl` in the extension's log
  folder, as JSON Lines with a 1 MB cap and two rolled files. Each record names
  the caller, instance, repository, target, tool, dry-run flag, body size and
  SHA-256, result and duration — never the comment text. Off by default, the
  records still go to the `Forgejo Toolkit` Output Channel, where they are gone
  when the window closes.
- The MCP server's second **write** tool, `submit_pull_review`, which submits an
  existing pending review with the verdict `COMMENT`, `APPROVED` or
  `REQUEST_CHANGES` (`reviewId` names the review; no other spelling of a verdict
  is accepted, and `APPROVED` / `REQUEST_CHANGES` need a review message). It is
  off by default and independent of the comment tool's switch — its own setting
  is `forgejoToolkit.mcpWriteTools.submitPullReview` — and it is available only
  in a session the extension host itself established, exactly like
  `create_issue_comment`. It shares that tool's retry key (a repeat of the same
  review within ten minutes replays the earlier result), its `dryRun` plan
  (which also says what the verdict means) and its audit line, which carries
  `reviewId` beside the target and never the review text.
- The MCP server's third **write** tool, `cancel_action_run`, which cancels a
  pending or running Actions workflow run. Its own switch,
  `forgejoToolkit.mcpWriteTools.cancelActionRun`, is off by default and
  independent of the comment and review switches — one of them being on never
  enables another. It cancels the run's pending and running jobs; the run then
  has to be triggered again, which this tool does not do. Because Forgejo's
  cancel endpoint also answers `204` for a run it leaves alone (one that already
  finished), the result says the server accepted the cancel request and points
  at `list_action_runs` for the run's real state, rather than claiming the run
  was cancelled. Being a request with no body, its audit line carries no size or
  digest at all, and a repeated cancel within ten minutes replays the earlier
  result instead of sending a second request. It is available only in a session
  the extension host itself established, exactly like the other two, and the
  tool surface grows from 32 tools to 33.
- The MCP server gains `get_pr_review_brief`, which answers a whole pull request
  review in one call: the pull request header, the diff statistics with a
  per-file additions/deletions table, each reviewer's latest conclusion plus an
  aggregate summary, and the unresolved inline review comments — replacing the
  four calls a review used to start with, and marking every part it had to cut
  short. The `review-pull-request` prompt now starts from it, and the tool
  surface grows from 29 tools to 30.
- **AI Pre-Review Pull Request** (`forgejoToolkit.aiPreReviewPullRequest`), a new
  action on the pull request detail page — the extension's own dashboard — plus
  the settings behind it. It reviews **the whole pull request**, and both the
  action and what it says out loud make that unmistakable: the button's label and
  tooltip say it, including how many changed files the pull request has, the run's
  progress lines repeat it with the number of files it read, every outcome message
  names the scope, and the confirmation panel's header states how many changed
  files the run covered. The same action is also on the pull request diff editor's
  title bar, unchanged, as the fast path out of an open diff.
  With `forgejoToolkit.aiPreReview` on, a chat model you have configured in VS
  Code reads the whole pull request and proposes line-level review comments; you
  pick the ones you agree with from a list that starts with nothing selected, and
  only those become drafts of a pending review. The extension never submits a
  review itself — the existing "Submit review" button stays the only way anything
  becomes public — an unconfirmed comment writes nothing, and a run that is
  cancelled or fails leaves no half-written comment behind. Every anchor is
  validated against the pull request's real diff lines: a comment that does not
  fit is dropped and counted, never moved to a nearby line, flipped to the other
  side or shortened. `forgejoToolkit.aiPreReview` defaults to off, and with it off
  the command refuses without sending anything anywhere. With it on, the model
  receives the pull request's title and branch names, the changed-file paths with
  their additions/deletions and status, and the metadata of existing review
  comments — never a comment body, never a URL. What code, if any, leaves your
  machine is decided by `forgejoToolkit.aiPreReviewPromptScope` — `metadata-only`
  sends none, `changed-lines-only` the added and removed lines, `full-diff` the
  whole diff, and `changed-files` the whole diff plus the changed files' own
  text — and its default `ask` means the first run shows one modal naming the
  provider and what each answer would send, sends nothing before you answer, and
  writes your answer into that setting, so the question is asked only once. The run
  reports its progress while it reads and thinks, with a cancel button; cancelling
  writes nothing. **The extension does not pick a model for you and does not
  switch between models.** `forgejoToolkit.aiPreReviewModel` is where the choice
  lives: leave it empty — the default — and the next pre-review lists every chat
  model VS Code offers and asks which one to use, showing each model's name,
  `vendor/family`, id, input budget and the provider that would receive the
  brief; the pick is written into that setting and used for the run, and every
  later run uses the same model without asking. Fill the setting in and no
  question is asked at all. Dismissing the list cancels the run with nothing
  sent, nothing created and the setting unchanged. When a model's answer is not
  the JSON the feature asks for, the run asks **that same model** the same
  question again — at most two attempts of the one chosen model, so at most two
  model calls — because a provider that returns an empty stream or a fragment on
  one call frequently answers the next; only a contract failure is retried — a
  failing model call, a declined permission prompt, a cancellation, or a valid
  answer whose anchors were all dropped still ends the run — and the retry never
  moves to another model. If both attempts fall short, the message names that
  model, how many calls the run made, and how each answer failed — an empty
  answer, an answer that is not JSON, or JSON whose shape is wrong, naming the
  field — instead of one "could not be parsed" for all three, and it points at
  the choose-a-model command. Each failed attempt also leaves one line in the
  "Forgejo Toolkit" output channel naming the model by vendor, family and id,
  which attempt it was, how long the answer was, and quoting a bounded excerpt of
  the answer: at most 200 characters, escaped onto a single line, so a
  handful-of-characters fragment is visible in full while a long answer is cut.
  A successful run still logs no answer text at all, and the excerpt never
  carries the brief, the diff or the prompt; the debug-level shape line is
  unchanged and the full answer stays in the debug-only diagnostics file.
  The new `forgejoToolkit.aiPreReviewOpenDiagnostics` command ("AI Pre-Review:
  Open Diagnostics") opens that file in the editor, or — when it does not exist
  yet, which is the normal state while `forgejoToolkit.debug` has never been on —
  says so and names the setting that creates one. Reading a local file sends
  nothing, so the command is offered whatever the feature switch says.
  Your configured model is never replaced by another one: a value that is not one
  of the accepted `vendor/family` or `vendor/id` forms, or that names a model VS
  Code does not offer, refuses the run and lists every offered model with its
  `vendor/family`, id and `maxInputTokens`; a chosen model whose input budget
  cannot hold the feature's instructions is refused with both numbers and no
  substitution; and when the request itself does not fit it names the tokens
  needed, the budget available and the switch that shrinks the request. It never
  falls back to a heuristic "review".
  With `forgejoToolkit.debug` on, a run also writes the exact messages it sent
  and the full raw answers it received to `ai-pre-review-diagnostics.log` in the
  extension's log directory, and the debug-only
  `forgejoToolkit.aiPreReviewProbeChatModels` command asks **the model you
  chose** — the one `forgejoToolkit.aiPreReviewModel` names — the same trivial
  question with each request shape, so a model that cannot
  answer an extension at all can be told apart from a request it cannot handle.
  It asks nothing at all while that setting is empty or names a model your
  editor does not offer: it says which of the two it is and lists the offered
  models instead of spending calls on models you did not choose.
  With debug off no diagnostics file is written at all, the channel still carries
  only the bounded excerpt on a contract violation, and the probe sends nothing
  while `forgejoToolkit.aiPreReview` is off.
- Which chat model reviews a pull request is yours to choose, and the extension
  neither makes that choice for you nor switches between models. The
  window-scoped `forgejoToolkit.aiPreReviewModel` setting is the one place the
  choice lives, and it is an ordinary setting you can see and edit in the
  Settings UI: name a model as `vendor/family` or `vendor/id` (an optional
  `@version` suffix is accepted), for example `deepseek/deepseek-flash`, and
  every run uses that one model. Leave it empty — the default — and the next
  pre-review asks: it lists every chat model VS Code offers, with each model's
  name, `vendor/family`, id, input budget and — because the brief goes to
  whichever provider is behind the model — which provider would receive it. The
  answer is written into the setting and used for the run, so later runs use the
  same model without asking, and dismissing the list cancels the run with nothing
  sent, nothing created and the setting unchanged. A new command,
  `forgejoToolkit.aiPreReviewChooseModel`, changes the choice later; it is in the
  command palette whatever the feature switch says (choosing a model sends
  nothing), and every message that needs a different model points at it. A
  configured value that is not one of those forms, or that names a model VS Code
  does not offer, does not start the run: the message names what you configured
  and lists every offered model with its `vendor/family`, its id and its
  `maxInputTokens`, so you can correct it — it is never silently ignored, and the
  brief never goes to a provider you did not name. A model whose input budget
  cannot hold the feature's instructions is refused the same way, with both
  numbers, and is never quietly replaced by a larger one.
- The AI pre-review's chat model can now be chosen from the extension's own
  Settings page, not only from the command and the setting. The row lists the
  chat models VS Code is offering at that moment — each option with its display
  name and `vendor/family`, and, on the row being looked at, the provider that
  would receive the brief together with the model's `maxInputTokens` — and it has
  a **refresh** button, because the list changes between runs. When there is
  nothing to offer it says why instead of showing an empty dropdown (no language
  model API, a listing that failed, or no model installed), and a configured value
  that names none of the offered models is called out on the row. Picking a model
  writes the same value into `forgejoToolkit.aiPreReviewModel` at global scope
  that `forgejoToolkit.aiPreReviewChooseModel` writes, and the row reports whether
  the write landed — a failed write puts the stored value back on screen, so the
  choice shown is never one that was not stored. Choosing sends nothing to any
  provider and works with `forgejoToolkit.aiPreReview` off: it is configuration,
  not use. The contributed setting itself stays a free-text field on purpose — the
  list of models only exists at run time, and VS Code cannot render a runtime list
  as a contributed setting's dropdown.
- The workflow dispatch form now offers the inputs a workflow declares instead of
  an empty key/value editor: it reads `on.workflow_dispatch.inputs` from the
  workflow file at the ref the form has selected (`.forgejo/workflows`,
  `.gitea/workflows` or `.github/workflows`), shows each input's name beside its
  description, renders a text field for `string`, a checkbox for `boolean` and a
  dropdown built from `options` for `choice` (any other declared type becomes a
  text field rather than a broken control), prefills the declared `default` and
  refuses to submit while a `required` input is empty. A workflow whose file
  cannot be fetched or parsed — a private path, an unsupported shape, no `inputs:`
  block, an API error — is still dispatchable through the raw key/value editor,
  which the form says it is using; values already typed anywhere in the form are
  never dropped when it switches between the two modes.

### Changed

- The AI pre-review is no longer offered from a **file's** context menu. A run
  reads every changed file and the whole diff, so an entry that sat on one file
  promised a scope it never had; the maintainer's decision was to move the entry
  to the pull request detail page, where a button labelled "AI pre-review (whole
  PR)" posts that pull request's coordinates to the same run. The diff editor's
  title button is unchanged. The command itself, its refusals, its settings and
  everything it writes are exactly as they were: only the user-chosen model is
  asked, the strict contract and anchor validation are untouched, the prompt-scope
  dialog and its fail-closed behaviour are untouched, drafts are still PENDING
  review comments only, a review is still never submitted, and the diagnostics
  stay debug-only.
- The AI pre-review's confirmation step is no longer a multi-select quick pick.
  That control put each proposed comment's body inside its label, which VS Code
  truncates, with no `description` and no `tooltip` to hold the rest, so you
  could not read the comment you were about to accept. It is now an editor-tab
  panel with one card per candidate: the whole body (wrapped and selectable),
  the anchor (`path:line` or range, and the side), a checkbox, and a link that
  opens the pull request's diff at that line on the anchor's own side. The
  header names the pull request, the model that answered (with its vendor), the
  prompt scope that run actually used, how many candidates passed the anchor
  validation, and how many were dropped, grouped by reason — none of which the
  quick pick had a surface for. Nothing is checked by default and the extension
  contributes no accept-all control of its own; the platform's `Toggle all
checkboxes` belonged to VS Code's multi-select quick pick, which this panel
  does not use. Checking cards and pressing Create writes them as drafts of a
  pending review through the same path as before — the extension still never
  submits a review — and the panel then reports the outcome and offers a button
  that opens the pull request. Cancelling, pressing Escape or closing the tab
  creates nothing. ~~The answer carried card indexes only, so a modified webview
  message could select what it was offered but never invent a comment.~~ The
  answer now carries the checked cards together with the text you left in each
  card's editor, and the extension re-validates every entry before it writes
  anything, so a modified message can propose a body but still cannot move a
  comment — see the entry on editing a proposed comment before it becomes a draft.
- The AI pre-review's proposed comments can now be **edited in the confirmation
  panel before any draft exists**. Each card used to be read-only text, so the
  only way to fix a wording was to create the comment first and correct it in the
  diff afterwards — which writes text you have not agreed to yet. Every card is
  now an editor pre-filled with the model's wording: the draft is created with
  the text you leave in it, an edited card is marked `Edited` and can be reset to
  the model's wording in one click, and the input is capped at the extension's
  per-comment limit (1024 characters) with the cap stated when it is reached
  rather than the text being cut silently. Only the body is editable — the path,
  line, range and side still come from the run's own validated candidates and are
  never sent by the panel — and the extension re-validates every entry it is sent:
  the index must be one it offered, and the body a string that is non-empty after
  trimming and within the limit. One bad entry refuses the **whole** create with a
  message naming that card, and so does a ticked card whose body was emptied:
  nothing is written, and the panel keeps its question so you can fix that body
  and press Create again. A body the extension itself had cut is now cut so its
  "truncated" announcement fits inside the limit, which is what lets such a card
  be created without an edit first.
- The AI pre-review no longer decides for you whether code is sent. The boolean
  `forgejoToolkit.aiPreReviewIncludeDiff` — off by default, and with it off the
  model received no code at all — is replaced by
  `forgejoToolkit.aiPreReviewPromptScope`, whose default `ask` means "you have not
  chosen yet". The first pre-review that reads `ask` shows one modal naming the
  provider the content would go to and what each answer sends; nothing is
  requested, sent or written before you answer, and dismissing it ends the run
  with nothing sent and nothing created. Your answer is written into the
  setting, so the question is asked once rather than once per run — set it back
  to `ask` to be asked again. Four scopes are stated: `metadata-only` (the model
  sees no code at all, so it can only comment on file-level matters),
  `changed-lines-only` (the added and removed lines with their file and hunk
  headers and none of the surrounding context — the cheapest scope that still
  sends code), `full-diff` (the whole diff, exactly what the removed switch
  sent) and `changed-files`, the recommended one, which sends the whole diff
  plus the full text of every changed file at the pull request's head version,
  so the model can read the code around a change. Every scope is bounded by the
  budgets that were already there, cut from the end and announced in the prompt;
  only files the pull request changed are read, and no scope sends an access
  token, a URL or host name, or the body of an existing review comment. The
  extension does not read a leftover value of the removed key at all: such a key
  is simply an unknown setting to VS Code and changes nothing here. The
  confirmation list, the anchor validation, the drafts-only writes, the retry
  bound and the debug diagnostics are unchanged.
- The AI pre-review's proposed comment bodies are written in the language you
  read the extension in, not always in English. The instruction block it sends is
  English and nothing in it named your language, so every body came back in
  English whatever the editor's language was — an acceptance run on a Chinese
  editor showed exactly that. The run now resolves the language the way the rest
  of the extension resolves the interface it presents to you:
  `forgejoToolkit.locale` when it states `en` or `zh`, and that setting decides
  even if it disagrees with the editor, because every surface that shows these
  bodies (the confirmation panel included) renders in it; with the setting unset
  the editor's display language decides, and anything unexpected — a value the
  manifest does not contribute, or a display language that is not Chinese — reads
  as English rather than being guessed at. The prompt names the language in its
  own script (`简体中文`, `English`) and states the boundary in the same rule: the
  JSON keys and every value that is not prose — the schema's field names,
  `"head"`/`"base"`, paths and the numbers — stay exactly as specified, and only
  `body` is written in that language, so a translated path or side cannot be
  produced and then dropped by the anchor validation, which never repairs one.
  The prompt is still built once per run, so both attempts of the model you chose
  send the same bytes, and the debug-only diagnostics dump still records the
  exact messages that went out. Nothing else changed: the feature switch and the
  prompt scope, the JSON contract, the anchor validation, the drafts-only writes,
  the retry bound and the diagnostics.
- The AI pre-review no longer chooses a model on its own. Automatic selection in
  every form is gone — the budget-sorted preference, the fallback to the largest
  input budget, the "models that answered the contract earlier in this window"
  ordering, the run-time rotation to the next candidate, and the window-scoped
  memory of a pick — because the maintainer requires that the extension list the
  available models, let you choose, and then use that model consistently. What
  replaced it is the setting as the single source of truth plus a picker that
  writes into it, and a new `forgejoToolkit.aiPreReviewChooseModel` command for
  changing it later. What stayed is validation, which never substitutes: an
  unusable configured value or a chosen model that cannot hold the instructions
  refuses the run with the facts and points at the command. The one automatic
  behaviour left around failures is the bounded retry, and it now stays on the
  model you chose: when an answer is not the JSON the feature asks for, that same
  model is asked the same question again, at most **2 attempts** in total — the
  run's whole call bound, replacing the previous three-models × two-attempts
  arithmetic of at most six calls. A diagnostic probe over 12 offered models and
  3 request shapes (36 calls, only 6 of which returned anything) and a run that
  failed 3/3 with 5–10 character fragments are why asking again is worth it; they
  are not a reason for the extension to pick a different model, which is your
  decision alone. Nothing that is not a contract violation is retried — a failing
  model call, a declined permission prompt, a cancellation, or a valid answer
  whose anchors were all dropped still ends the run exactly as before. The
  failure message now reports the calls it actually spent and how each of that
  model's attempts fell short, and no other model is named or called; the debug
  diagnostics dump numbers each call as the attempt of the chosen model and as
  the call of the run, so two blocks for the same model are distinguishable.
- **Default behaviour change**: notification polling is now coordinated between
  VS Code windows. With `forgejoToolkit.multiWindowLease` on (the new default) a
  window that is not the polling owner no longer polls and no longer raises
  notification alerts, and the window you are working in takes the job over.
  Turn the setting off to get the previous behaviour back — every window polls
  and alerts for itself — and note that any failure of the coordination already
  falls back to exactly that, so notifications are never silently dropped.
- Each webview surface downloads only what it renders: the onboarding wizard and
  the review-comment editor have their own entry instead of booting the whole
  dashboard shell (the wizard drops from 474,079 B to 398,830 B, about −15.9%,
  the review-comment editor from 458,135 B to 326,163 B, about −28.8%, and the
  dashboard itself from 343,758 B to 335,855 B), and a build-time check fails if
  a panel ever reaches the dashboard again.
- The webview message catalog is now split by language, so a surface never
  downloads the language it is not showing: the two catalogs were 49,574 B, 31.3%
  of the shared chunk every surface loaded, and that chunk is 118,495 B now
  instead of 158,289 B (about −25%), while the Chinese catalog became a 20,815 B
  chunk (8,191 B gzip) that no surface preloads. The dashboard drops from
  339,778 B to 321,398 B (about −5.4%), the review-comment editor from 331,145 B
  to 311,974 B (about −5.8%); switching language stays atomic, and a build-time
  check fails if a catalog that must stay lazy turns static.
- The extension host and the MCP server are now emitted by one ESM build with
  code splitting, so the dependency graph they had in common ships once: their
  entries plus the shared chunk come to about 1.56 MB (extension.mjs 230 KB,
  mcp-server.mjs 11 KB and a 1.33 MB shared chunk) where the two separate bundles
  took about 2.94 MB (about −47%), and the packaged `.vsix` drops from 1246 KB to
  891 KB (about −28.5%). The MCP entry's "no `vscode`" guarantee is now enforced
  against the build's module graph, and the stable-path shim keeps its
  `mcp-server.js` name.
- The create-PR status bar asks the server for the branch's pull requests
  instead of reading the whole open list every time (ten requests become one in
  the common case), and its "may be past the list cap" warning now appears only
  when the pull request really is missing.
- The 401/403 guidance re-appears when the stored token changes, instead of
  staying silent for the rest of the session.
- API failures carry a structured error (status, headers, body), so a
  server-authored message is rendered directly instead of being re-parsed out of
  the message text.
- A probed Forgejo version is now shared between VS Code windows: it is recorded
  beside the instance list, so the first window to probe an instance writes the
  result there and the other windows reuse it instead of probing every instance
  again on startup. A record older than a minute is treated as unknown and probed
  again, so a server upgrade or downgrade is never held back until the session
  ends, and a window that reuses a record does not repeat the too-old-version
  warning the probing window already raised.
- Only one window probes an instance at a time, in the normal case. The window
  that probes first records that it is probing, and a second window that needs the
  same version waits for that result (up to ten seconds) instead of sending its
  own request; the wait never blocks a user action indefinitely and falls back to
  probing if it expires, if the probing window has gone, or if the shared state
  cannot be read. The too-old-version warning is deduplicated across windows the
  same way, so it is raised once no matter how many windows are open — including
  when two windows do end up probing at the same instant, which can still happen
  because VS Code's shared state offers no way to make that check atomic.
- The version gate behind the Actions features renews itself when it is used: if
  the recorded version has expired, the gated call probes for it before deciding,
  instead of allowing the feature for the rest of the session because the recorded
  value had gone stale. There is still no background polling, and a version that
  cannot be determined allows the feature, exactly as before.
- The local MCP broker is now handed over between VS Code windows without a
  reload: only the window that binds the per-profile endpoint serves it, and
  when that window closes or is killed one of the other windows binds the
  endpoint itself and re-registers, so a client launched from a static
  `mcp.json` reaches the new owner with no change on its side while the token
  still never leaves the extension host. A session that was already running
  when the owner died still exits and has to be started again, after which it
  forwards through the new owner within a few seconds.
- The first-run setup guide opens in **one** window instead of one per window.
  Windows restored together on a fresh install used to decide with the editor's
  `hasShownWelcome` flag, whose read-then-write is not atomic, so several of them
  could open the guide at once. They now coordinate through a short-lived offer
  token in the profile's globalStorage (`first-run-guide-offer.json`, created
  with an exclusive create and mode `0600` — the polling lease's own primitive):
  the window that creates it opens the guide and the others stay silent while
  that offer is plausible, meaning the window that made it is still running and
  the token is still fresh. The token records an offer in flight, not that the
  guide has been shown: once its owner is gone or the offer has expired the next
  window takes it over and offers the guide again, so a profile with no
  configured instance keeps being nudged exactly as before. What keeps the guide
  away permanently is still the completion flag, written when the guide is
  completed or when an instance exists. If the token cannot be created at all —
  a read-only profile directory, a denied create — that window opens the guide
  rather than staying silent.

### Security

- MCP server definitions no longer carry the access token. VS Code persists every
  registered definition — environment included — in the profile's workspace
  storage, so the token the extension handed to its stdio server was a copy of a
  credential sitting on disk in cleartext right next to SecretStorage. The
  definition now names only the instance, and the process VS Code spawns forwards
  to the same local broker the static `mcp.json` route already used, where the
  token is read from SecretStorage and never leaves the extension host. Nothing
  changes for a launch you configured yourself: your own `mcp.json` may still
  carry `FORGEJO_MCP_TOKEN` if you want it to, and the static route still
  degrades to anonymous public-data reads when no extension window is running.
  When no broker is reachable the extension now publishes no definition at all
  and logs why, instead of registering a server that would answer anonymously
  while the client believed it was authenticated.
- The local MCP broker was hardened after an independent review: a request
  whose bytes arrive split across reads is no longer corrupted, one
  unterminated line is capped at 4 MB and the listener at 64 connections, so a
  local process can no longer grow the pre-handshake buffer without bound, and
  the registration file and Unix socket are written owner-only (0600/0700)
  instead of inheriting the umask. A registration left behind by a crashed
  window is ignored, and shutting one broker down no longer unlinks a
  successor's live socket.

### Fixed

- Windows: the stable-path MCP shim (the `.mcp.json` and Agents-window launch
  route) could not start at all, because it pointed at a path the ESM loader
  refuses.
- Two VS Code windows no longer discard each other's notification baseline,
  which could swallow a notification round after an instance was added.
- A list that is exactly at the 500-row cap is no longer called truncated when
  the server's own total proves it complete.
- A README that is a symlink or a submodule is described as such (in your
  language) instead of being reported as an oversized withheld file.
- Accessibility: every progress ring announces a localized name instead of
  English "Loading"; the test/save outcome is announced; the view filter no
  longer claims a tab relationship it cannot deliver; the dashboard is not
  remounted (nor its title announced twice) when reopened.
- A failed comment reaction, dependency change, or labels/assignees/milestones
  load now says so instead of looking like an empty result, and the timer state
  is not presented as "not running" when it could not be read.
- The review-comment editor no longer clears its submitting guard for a reply
  belonging to another pull request, and the panel no longer closes the editor
  you just opened when a submit resolves after you switched.
- Comment bodies no longer disappear after flipping the comment sort order, and
  a failed image upload no longer leaves its message in another comment's
  editor.
- The polling diagnostics report no longer states a handover reason that depends
  on which window you ask: a window that lost the lease now records what actually
  happened (another window displaced it, or the file disappeared) instead of a
  blanket "expiry", and the takeover side and the demotion side of the same
  handover agree. Its `handover.latencyMs` is now a real measurement on every
  path where one exists, and `null` plus a `handover.latencyUnknown` reason where
  it genuinely does not — a `0` that meant "not measurable" used to be
  indistinguishable from a real zero, on exactly the crash path a bug report is
  about.
- The polling diagnostics report's window list is now called `visibleWindows`,
  which is what it is: the holder plus every window competing for the lease. A
  quiet window that is neither leaves no trace on disk and is not listed; the old
  name read as a complete registry of the profile's windows.
- In the same report, every `versions.probeCache` row now carries the time its
  version was probed and whether that record has expired (`probedAt` and
  `stale`), and `versions.followsInstanceConfig` reports `true`: the probe cache
  really does live beside the instance configuration and is shared between
  windows, so the rows a follower window reports are what its feature gates read.
- A repository, Issue or Pull Request list now shows only the answer to its
  own request: a reply that arrives late, from an instance you just removed or
  from a server that has since been replaced, is discarded instead of landing
  in the list or its cache, whatever order the replies arrive in. The setup
  wizard follows the same rule.
- On an editor that provides no MCP server definition API (VS Code forks such
  as VSCodium), the extension now skips that one registration with a log line
  instead of risking a failed activation, and the workspace-state sync the
  static-config MCP path relies on still starts. The FAQ explains how to run
  the extension and the MCP server on such forks.
- The workflow dispatch form's ref field is labelled "Ref (branch/tag)" and now
  offers both: it listed the repository's branches alone, so a tag could not be
  selected or dispatched. Branches and tags come from the same refs request the
  repository browser already makes for its branch and tag lists (no new
  endpoint), each option names its kind — "Branch: main", "Tag: v0.0.1" — the
  way the Issue/PR form's ref selector does, and the value dispatched is still
  the plain ref name. The field still starts on the repository's default branch,
  keeps a ref you chose when the lists are loaded again, and filters fuzzily like
  the repository's branch pickers; the repository detail's branches stand in
  until the refs request answers, so it never regresses to a bare text box.
- The AI pre-review action is no longer offered while
  `forgejoToolkit.aiPreReview` is off: its editor title entry is gated on the
  setting as well as on the diff, and the pull request detail page's button is
  hidden, so neither appears only to refuse when clicked. The
  debug-only `forgejoToolkit.aiPreReviewProbeChatModels` command is gated the
  same way — it now needs the switch as well as `forgejoToolkit.debug`, which
  its own handler already required. The run command still refuses while the
  switch is off, it is still absent from the command palette, and choosing a
  chat model is unaffected.
- A status-check state this extension has no wording for no longer prints the raw
  `dashboard.detail.checksState.…` key in a pull request's checks panel: an
  unrecognized combined status now shows the localized "Unknown" label, the same
  fallback the merge-blocker line already used.
- An AI pre-review that ends with no parsable answer is now diagnosable without
  turning `forgejoToolkit.debug` on. A failure that said only "the answer was not
  JSON" could not tell a degenerate model from a truncated answer from a bad
  prompt, so each failed attempt now writes one line to the "Forgejo Toolkit"
  output channel naming the model by vendor, family and id, which attempt of the
  chosen model it was, how many characters the answer had, and a bounded excerpt
  of it — at most 200 characters, escaped onto a single line, so the
  handful-of-characters fragments a flaky provider returns are visible in full
  and a long answer is cut. The failure message says where that excerpt is, and a
  new `forgejoToolkit.aiPreReviewOpenDiagnostics` command opens the diagnostics
  file with the full prompt and answer in the editor; when the file does not exist
  yet — which is the normal state while `forgejoToolkit.debug` has never been on —
  it says so and names that setting instead of failing or opening nothing.
  Reading a local file sends nothing, so the command works whatever the feature
  switch says. A successful run still logs no answer text at all, and the excerpt
  never carries the diff, the brief or the prompt.
- The AI pre-review now reads the model's answer from the response's stream parts
  and keeps the `text` projection only as a fallback, which makes the feature work
  on providers whose `text` projection is not the answer. Measured on a real
  machine: one provider's chat model returned the expected 27-character JSON
  literal in the response's text parts while `LanguageModelChatResponse.text`
  delivered the model's reasoning trace (`{"":",cdef12`), so every pre-review
  against that model failed with "the answer was not JSON" and created nothing.
  The run now consumes the response once, collects the text parts and the
  reasoning parts as separate candidates, and lets the JSON contract decide which
  one is the answer: the text parts are tried first, the reasoning parts next if
  the text parts are absent or do not satisfy the contract, and the `text`
  projection last when neither carried text. Two candidates are never
  concatenated, a candidate is never repaired, and no model is substituted. When
  nothing satisfies the contract the run fails exactly as before — the failing
  model, the attempt count and a bounded excerpt of the answer it examined — and
  creates nothing. At debug level the run says which stream it used and why, and
  the diagnostics dump records both candidates, labelled. Runs whose answer was
  already arriving through `text` are unaffected.
- The multi-line comment highlight no longer keeps re-applying itself. With
  `forgejoToolkit.debug` on and one expanded multi-line comment thread, the
  extension filled the "Forgejo Toolkit" output channel with
  `Thread range decorations applied per visible editor: …` lines on its own, and
  clearing the channel started it again: the visible-ranges listener re-applied
  the decorations, that re-apply wrote the debug line, and writing it changed the
  output editor's own visible ranges, which re-triggered the listener. The line
  is now written only when the detail it reports actually changes, so an
  identical re-application is silent, and the visible-ranges trigger ignores
  every document the decorations never touch — the output channel, the
  comment-input documents and any other file — so neither the extension's own
  logging nor editing a comment box schedules decoration work. The diagnostic
  itself is unchanged: on every genuine change it still reports which visible
  editor got how many ranges and which got zero.
- Adding a review comment on a changed line of an open pull request diff no
  longer answers "Comments can only be added to lines within the pull request
  diff", and a selected range becomes a multi-line comment again. A diff editor
  shows two documents of the same file, so the two sides carry the same scheme
  and path and differ only in the query that holds `isBase`; the editor the
  command resolved was matched on the path alone and could land on the other
  side, whose line table does not contain the line you clicked. The match now
  compares the whole document identity, so the side the click names is the side
  that is validated — and the AI pre-review, which resolves its target the same
  way, no longer reads anchors against the other side either. The command handler
  also stopped pre-empting the selection: it passed the caret line as if it were
  the clicked line, which collapsed every selection to one line, because the
  comment controller only consults the selection when it is given no line
  number. A selection that legitimately runs past the diff keeps being refused,
  but when only its end is out of range the message now names that line instead
  of the blanket refusal that read as "your first line was wrong".
- A VS Code window that has stopped responding while it still holds the polling
  lease is now taken over **about one heartbeat earlier** than before: a focused
  window that has already asked the holder for the lease K times and sees a
  heartbeat more than 30 s old (three missed heartbeats) with the holder's
  process still alive really does take over at ~30 s, instead of losing the race
  to the 35 s expiry and taking over only after it. The release that precedes
  that takeover used to re-check the record against the full expiry, answer
  `not-owner` and leave the handover to the ordinary expiry path a few seconds
  later; it now re-checks against the same 30 s threshold that justified the
  takeover, and only against the exact record the decision saw (same pid, owner
  nonce and claim time), so a record another window wrote in between can never be
  unlinked. Nothing else changed: the anti-ping-pong window N, the K counter and
  the ordinary 35 s expiry path are untouched, and a window with fewer than K
  unanswered requests still waits.

## [0.0.1] - 2026-09-26

First public release (0.0.1). Forgejo Toolkit brings Forgejo and Codeberg into
VS Code: a multi-instance dashboard, repository browsing, Issues and pull
requests, PR review in the native diff editor, PR worktrees, notifications,
search, Actions, and a read-only MCP server for AI agents.

### Added

- **Instances.** Add, edit, remove and test multiple Forgejo/Codeberg instances;
  tokens live in VS Code SecretStorage, and the instance list can be exported or
  imported (optionally password-encrypted) with conflict detection for duplicate
  URLs and tokens.
- **Dashboard.** Repository, Issue and Pull Request tabs grouped by instance,
  with the Issue/PR tabs scoped to the current account; repository cards show the
  default branch, stars, forks plus browser/copy actions, and a linked-repository
  card covers the repository of the current workspace.
- **Repository browsing.** README preview through VS Code's Markdown preview,
  recent commits, branch/tag/Release lists with create and delete, and a file
  browser with directory tree, file search, single-file history and a diff
  viewer.
- **Issues and pull requests.** List, detail, create, edit, close/reopen and
  delete, comments with attachments, Markdown rendering with mentions, and
  reactions, subscriptions, time tracking and dependency management on the detail
  page. The detail page also shows merge status with its blockers and the CI
  status checks, and offers merge (merge/squash/rebase) and revert-merge.
- **Pull request review.** Inline review comments in VS Code's native diff
  editor, including multi-line comments, with a dedicated editor panel for rich
  comments (Markdown toolbar, preview, `@`/`#` completion, image upload) and a
  comment / approve / request-changes conclusion when submitting.
- **Pull request worktrees.** Open a PR in a worktree created from
  `refs/pull/<n>/head`, with a configurable open mode and cache directory,
  worktree management in the settings view, and a confirmation before local
  commits or changes are discarded.
- **Editor integration.** Comment on diff lines, create issues from `TODO`/
  `FIXME` comments with a permanent source link, start work on an issue in a
  dedicated worktree, and a status bar entry that pushes the current branch on
  demand and opens the create-PR dialog.
- **Notifications and search.** Notification centre with unread badge, status and
  type filters and single/all mark-as-read, background polling with desktop
  notifications, global repository/Issue/PR search across instances, and keyword
  filtering in repository lists.
- **Actions.** Workflow run history with incremental paging, run detail with
  jobs, logs and artifacts, artifact download, cancellation of a running run, and
  manual workflow dispatch with inputs.
- **MCP server.** Every configured instance with a stored access token is
  exposed to MCP clients (VS Code ≥ 1.102) as its own read-only stdio server
  covering Issues, PRs, notifications, repositories, search, Actions, files,
  commits, reviews and metadata, with input validation and result truncation.
  A `get_workspace_repository` tool maps the open workspace to its repository
  on the matching instance, prompt templates (`review-pull-request`,
  `analyze-ci-failure`, `triage-issue`) package common read-only workflows, and
  `get_ci_failure_summary` condenses a failed Actions run into error lines and
  log tails sized for an agent's context. The token travels through the
  child's environment and never appears in schemas, results or logs.
  The Agents window and other MCP clients (Kimi Code, Cline, etc.) load the
  server from a static `mcp.json` instead: a stable, upgrade-proof shim path
  (written by the extension on every activation) plus zero-configuration
  instance auto-matching (git remote / workspace state) make the config
  secret-free. When the extension host is running, a broker lets that static
  server forward to the extension over a local pipe with a per-launch
  handshake key, so authenticated tools work there too — the token never
  leaves the extension host or touches disk. A **Copy MCP Config for Agents
  Window** command generates the config.
- **Settings and localization.** Language switch, debug logging to the
  "Forgejo Toolkit" output channel, worktree configuration, and English/Chinese
  localization for the webview, the extension manifest and the packaged README.
- **Engineering.** Kubb-generated API client shipped as source, a shared request
  client, MSW-based mocks for offline development, oxlint/oxfmt, vue-tsc with
  strict templates, and a human-triggered Forgejo CI plus a release workflow that
  validates the commit, packages the extension and optionally creates the
  Codeberg release with the `.vsix` attached.
