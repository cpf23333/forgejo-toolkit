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
     `## [<version>] - <date>` and opens a fresh `## [Unreleased]` (post-release
     step of the checklist in `docs/release.md`). -->

## [Unreleased]

### Added

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
- The MCP server gains `get_pr_review_brief`, which answers a whole pull request
  review in one call: the pull request header, the diff statistics with a
  per-file additions/deletions table, each reviewer's latest conclusion plus an
  aggregate summary, and the unresolved inline review comments — replacing the
  four calls a review used to start with, and marking every part it had to cut
  short. The `review-pull-request` prompt now starts from it, and the tool
  surface grows from 29 tools to 30.

### Changed

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
