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
- Two design documents for future work: the confirmation model for MCP write
  tools, and a multi-window polling lease.

### Changed

- Each webview surface downloads only what it renders: the onboarding wizard and
  the review-comment editor have their own entry instead of booting the whole
  dashboard shell (about 16% and 29% less to load), and a build-time check fails
  if a panel ever reaches the dashboard again.
- The create-PR status bar asks the server for the branch's pull requests
  instead of reading the whole open list every time (ten requests become one in
  the common case), and its "may be past the list cap" warning now appears only
  when the pull request really is missing.
- The 401/403 guidance re-appears when the stored token changes, instead of
  staying silent for the rest of the session.
- API failures carry a structured error (status, headers, body), so a
  server-authored message is rendered directly instead of being re-parsed out of
  the message text.

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
