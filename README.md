English | [中文](./README.zh.md)

# Forgejo Toolkit

[![Codeberg](https://img.shields.io/badge/Codeberg-forgejo--toolkit-blue.svg)](https://codeberg.org/cpf23333/forgejo-toolkit)

A VS Code extension for [Forgejo](https://forgejo.org/) that provides a Webview-based dashboard, repository browsing, Issue / PR management, PR worktree support, and more.

## Features

- **Multi-instance management**: add, edit, and remove multiple Forgejo/Codeberg instances. Access tokens are stored in VS Code SecretStorage.
- **Dashboard panel**: repository, Issue, and Pull Request lists in the VS Code sidebar, grouped by instance, with keyword search and status filters.
- **Linked repositories**: detects workspace git remotes (multi-remote and multi-root workspaces included) and shows linked repository cards for quick navigation.
- **Repository details**: README preview, recent commits, branch / tag / release management (create / delete, release attachments), and a file browser with search and file history.
- **Issue / PR management**: list, detail, create, edit, close / reopen, and delete; Markdown rendering, comments, attachments, labels, assignees, milestones, due dates, dependencies, reactions, subscriptions, and time tracking.
- **PR review**: inline review comments (single-line and multi-line) in the native diff editor with a rich-text composer; submit reviews as comment, approve, or request changes.
- **PR diff and merge**: changed-file list, per-commit diffs, merge status with blocking reasons, CI status checks, and merge / squash / rebase / revert support.
- **PR Worktree**: check out `refs/pull/<index>/head` into a local worktree with configurable open mode and cache directory; Start Work on Issue creates an issue branch the same way.
- **Publish and create PRs**: publish a local repository or branch to Forgejo, clone through the Git: Clone quick pick, and create PRs from the status bar button.
- **Notifications**: unread badge, background polling with toast alerts, filters, and mark-as-read.
- **Global search**: search repositories, Issues, and PRs across instances.
- **CI / Actions**: run history, job logs, artifact downloads, run cancellation, and workflow dispatch with inputs.
- **MCP Server**: exposes your Forgejo instance to Copilot agent mode and other MCP clients with zero configuration — read-only tools for issues, PRs, Actions, and code browsing (VS Code ≥ 1.102).
- **Settings export / import**: export instances (optionally encrypted) and settings to JSON, and import them back with a conflict preview.
- **Internationalization**: supports switching between Chinese and English.
- **Debug logs**: optional API request logging to the `Forgejo Toolkit` Output Channel.

## Screenshots

| Onboarding                                                                                                      | Dashboard                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ![Onboarding](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/en/onboarding.png) | ![Dashboard](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/en/dashboard.png) |

| Repository overview                                                                                                         | Pull request                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ![Repository overview](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/en/repo-overview.png) | ![Pull request](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/en/pull-request.png) |

| Issue                                                                                                 |
| ----------------------------------------------------------------------------------------------------- |
| ![Issue](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/en/issue.png) |

## Installation

> **Not published yet.** Forgejo Toolkit has not been released: there is no
> Marketplace or Open VSX listing, and no Codeberg release with a `.vsix`
> attached. The store links below only start working once the first release is
> published, so build the `.vsix` yourself for now.

### From a VSIX

Once released, every version attaches the packaged `.vsix` to its
[Codeberg release](https://codeberg.org/cpf23333/forgejo-toolkit/releases) page;
until then, build it yourself:

```bash
pnpm --filter forgejo-toolkit package
```

The file is written to `packages/forgejo-toolkit/forgejo-toolkit-<version>.vsix`.
Install it with **Extensions → ... → Install from VSIX**.

### From a store (after the first release)

After 0.0.1 is published, the extension can be installed from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cpf23333.forgejo-toolkit)
(search for "Forgejo Toolkit"), or from
[Open VSX](https://open-vsx.org/extension/cpf23333/forgejo-toolkit) for editors
that use it, such as VSCodium.

## Usage

1. After installing the extension, click the **Forgejo Toolkit** icon in the activity bar to open the Dashboard.
2. On first use you will enter the onboarding page to configure the Forgejo instance URL and access token.
3. Browse repositories, Issues, and PRs in the Dashboard; click a repository card to open repository details.
4. On Issue / PR detail pages you can comment, edit, close / reopen.
5. On a PR detail page, click "Open in Worktree" to check out to a local worktree.

## Commands

All commands are available from the Command Palette (`Ctrl+Shift+P`, prefix `Forgejo Toolkit`); some also appear in editor context menus and the status bar.

| Command                           | What it does                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Dashboard                    | Opens the Forgejo dashboard in the sidebar.                                                                                                           |
| Open Setup Guide                  | Opens the first-run setup wizard.                                                                                                                     |
| Open Settings                     | Opens the extension settings view.                                                                                                                    |
| Refresh Instances                 | Re-reads the instance configuration and refreshes the dashboard.                                                                                      |
| Copy Permalink                    | Copies a permanent link to the current file or selection (also in the editor context menu).                                                           |
| Publish to Forgejo                | Publishes the current repository to your instance (also in the SCM view).                                                                             |
| View Log                          | Opens the "Forgejo Toolkit" output channel.                                                                                                           |
| Create PR from Current Branch     | Creates a pull request from the current branch (also in the status bar).                                                                              |
| Add Pull Review Comment           | Adds a review comment on the current diff line (also in the diff editor's line context menu).                                                         |
| Delete Review Comment             | Deletes the review comment under the cursor.                                                                                                          |
| Copy MCP Config for Agents Window | Writes or copies a ready-to-use MCP config for the Agents window (user-level `mcp.json`, workspace `.vscode/mcp.json`, or clipboard; see MCP Server). |

## Compatibility

- **Forgejo ≥ 16.0** — the minimum is v16 because several shipped features rely on endpoints that first appeared there (Actions run jobs/artifacts/job logs/cancel/delete and multi-line review comments). Older instances may partially work but are not supported: the extension shows a one-time warning per session and keeps every feature enabled, so v15 users will see request failures on those panels — a bare 404 from the server (see KNOWN_ISSUES).
- **Primary target: Forgejo v16.x** — the extension is developed and validated against the latest Forgejo stable release (currently the v16 series); the minimum and the validation target are the same series.
- **VS Code ≥ 1.102** — enforced via the extension's `engines.vscode` field.
- **The Actions 1.19 floor sits below the supported minimum** — the Actions API first appeared in Forgejo 1.19 and the extension compares the probed server version against that floor: a server older than 1.19 is refused with a localized "This feature requires Forgejo 1.19 or newer, but this server reports version &lt;version&gt;." error instead of a bare 404. Every version from the 1.21 era onward, including the modern v7–v16 series, compares above 1.19 — the gate can only fire for 1.18 and older — so on a Forgejo 15 instance it never fires and the Actions sub-endpoints missing there answer with the server's own 404 (see KNOWN_ISSUES). The Actions UI itself stays visible; it is the request that is refused. A server whose version cannot be probed is never blocked (the gate fails open).
- Future endpoints from newer Forgejo releases (e.g. the v17 rerun API) are gated per feature the same way and do not raise the overall minimum version either.

## MCP Server (AI Agent Integration)

The extension ships a built-in MCP server that lets AI assistants — such as Copilot agent mode — query your Forgejo instance in natural language.

- **Zero configuration**: every configured Forgejo instance that has a stored access token is automatically exposed to MCP clients as its own server via VS Code's `contributes.mcpServerDefinitionProviders` API, so an agent can reach several instances in the same session. No extra setup, no separate server to run.
- **Requirements**: VS Code ≥ 1.102 and at least one configured instance with an access token. If neither is available, the server is simply not registered.
- **Usage**: open Copilot chat in agent mode and ask in natural language, e.g. "list my issues" or "show the CI log of the latest failed run in this repo".
- **Proxy**: requests honour the editor's `http.proxy` setting, which wins over the environment's `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (each name is read in either case), and the setting is forwarded to the MCP server process as `FORGEJO_MCP_PROXY`.
- **Tool overview**: 29 tools in four groups —
  - **Core**: issues, pull requests, timelines, notifications, repository info, and search (e.g. `list_issues`, `get_pull_request`).
  - **Actions**: run history, run jobs, job logs, CI failure summaries, and artifacts (e.g. `list_action_runs`, `get_action_run_jobs`, `get_action_job_log`, `get_ci_failure_summary`).
  - **Code reading**: file contents and directory listings, repository file search, branches, tags, commits, file history, and PR diffs (e.g. `list_repo_contents`, `get_file_content`, `search_repo_files`, `get_pr_diff`).
  - **Review & metadata**: PR reviews, releases, labels, milestones, and your own repositories (e.g. `list_pull_reviews`, `whoami`).
- **Security**:
  - All tools are strictly read-only (`readOnlyHint`) — the agent cannot modify anything on your instance.
  - Because they are read-only, VS Code runs them without a per-call confirmation prompt. The tool surface is what keeps the agent in bounds: every tool maps to a `GET` endpoint (the one exception, `get_workspace_repository`, only reads a local state file the extension publishes), and every input that becomes part of a request path is validated (`owner`, `repo`, file paths) so a crafted argument cannot reach another endpoint.
  - Your token is injected from SecretStorage into the stdio subprocess via a process environment variable; it never appears in tool schemas, tool results, or logs.
  - Large response fields and oversized results are truncated to protect the agent's context window.
  - Adding or removing instances re-resolves the exposed server automatically.
  - The server makes no model calls of its own (no MCP sampling), so VS Code's per-server "Configure Model Access" menu entry — shown for every MCP server — has no effect on it.

### Using the server in the Agents window (or any static `mcp.json` host)

The server definitions above are contributed by the extension, and VS Code does **not** resolve extension-contributed MCP servers in Agents window (Agent Host) sessions — a platform limitation. To use the server there, register it through a static MCP configuration pointing at the **shim** the extension maintains in its globalStorage:

```json
{
  "servers": {
    "forgejo": {
      "command": "node",
      "args": ["%APPDATA%\\Code\\User\\globalStorage\\cpf23333.forgejo-toolkit\\mcp-server.js"]
    }
  }
}
```

The globalStorage directory differs per platform: `%APPDATA%\Code\User\globalStorage\cpf23333.forgejo-toolkit` on Windows, `~/Library/Application Support/Code/User/globalStorage/cpf23333.forgejo-toolkit` on macOS, `~/.config/Code/User/globalStorage/cpf23333.forgejo-toolkit` on Linux (Insiders builds use `Code - Insiders` instead of `Code`).

Three files can carry this snippet, and different consumers read them:

- **`<profile>/User/mcp.json`** (recommended) — VS Code's user-level MCP registry: applies to every workspace of the profile, and VS Code forwards it to Agent Host sessions.
- **`.vscode/mcp.json`** inside a workspace — VS Code reads it for that workspace only and forwards it the same way.
- **`.mcp.json` at the workspace root** — read natively by the Agent Host only: VS Code itself ignores it ("Cannot start unknown MCP server customization"), and sessions with worktree isolation never see it, because the session workspace is the isolated worktree, not your checkout.

The easiest way to write one is the **Forgejo Toolkit: Copy MCP Config for Agents Window** command — it merges the snippet into the user-level `mcp.json` or the workspace `.vscode/mcp.json`, or copies it to the clipboard. Either way the path is the shim `mcp-server.js`, not the real server bundle: the extension rewrites the shim on every activation to point at the current installation, so the configuration survives extension upgrades (the versioned `cpf23333.forgejo-toolkit-<version>` install path it replaces would not).

No environment variables are needed: the server discovers the extension's published instance registry on its own and picks the instance by matching the session workspace's git remote (the working directory is decided by the session's workspace, not by the config file). Without a `FORGEJO_MCP_TOKEN` in `env` it reads anonymously — only public data is visible. The zero-configuration variant contains no secrets, but as a general rule don't commit a workspace `mcp.json` into git: machine-specific absolute paths (and tokens, if you ever add an `env` block) don't belong in the repository.

**Authenticated without a token in the config (broker mode)**: while the extension is running in any window, the statically launched server does not stay anonymous — it transparently forwards into a local broker inside the extension host (a named pipe on Windows, a unix socket elsewhere), where the real tools run with the token. Your token never leaves the extension process and never lands in the `mcp.json` file; a per-launch handshake secret published in the extension's globalStorage (readable only by your own user) is what authorizes the forwarder. When no extension window is running, the same static configuration still works — it just falls back to anonymous, read-only access. Nothing to configure either way.

## Known Limitations

See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) (English) and [KNOWN_ISSUES.zh.md](./KNOWN_ISSUES.zh.md) (Chinese).

Main limitations:

- PR attachments must be fetched from the Issue API.
- The multi-file diff editor does not show M/R badges for modified / renamed files.
- Forgejo's PR files API may omit deleted files (the extension uses the compare API to work around this).
- Lists stop at 500 items, and only some views (issues, pull requests, comments, changed files, commits, refs, file search, MCP results) report that a list was cut off.

## Development

This is a pnpm workspace monorepo.

### Package Structure

| Package                                                  | Description                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| [`packages/forgejo-toolkit`](./packages/forgejo-toolkit) | VS Code extension host.                                      |
| [`packages/shared`](./packages/shared)                   | Shared request client and common types.                      |
| [`packages/forgejo-api`](./packages/forgejo-api)         | API client generated from the Forgejo OpenAPI specification. |

### Tech Stack

- **Extension host**: TypeScript + esbuild (CJS)
- **Webview UI**: Vue 3 + Vite 8 + @vscode-elements/elements
- **Package management**: pnpm workspaces

### Common Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build

# Type check
pnpm run check

# Run tests
pnpm --filter forgejo-toolkit test
pnpm --filter @cpf23333-forgejo-toolkit/shared test

# Development mode
pnpm run dev
```

Open the `packages/forgejo-toolkit` directory in VS Code and press `F5` to launch the Extension Host.

### Packaging

```bash
pnpm --filter forgejo-toolkit package
```

The generated `.vsix` file is located in `packages/forgejo-toolkit/`.

### Version Management

This project uses [Changesets](https://github.com/changesets/changesets) to manage monorepo versioning.

```bash
# After finishing a feature, record the change
pnpm run changeset

# When preparing a release, update versions and CHANGELOG automatically
pnpm run version-packages
```

`pnpm run release` is used for npm package publishing; the VS Code extension itself is packaged into a `.vsix` via `pnpm --filter forgejo-toolkit package`.

Changesets writes the per-package `packages/forgejo-toolkit/CHANGELOG.md`; the root
`CHANGELOG.md` is the curated, user-facing changelog and the source of the Codeberg
release notes, so it is written by hand and kept in step with the packaged copy
(see `docs/release.md`).

## Project Status

This is a personal side project. Features are tested only lightly, so bugs and edge cases are expected. Please open an issue if you run into any problems.

## Feedback & Contributions

Bug reports, feature requests, pull requests, documentation improvements, and any other feedback are welcome.  
If you have ideas for better interactions, layouts, workflows, or anything else, feel free to open an issue or start a discussion.

## License

[MIT](./LICENSE)
