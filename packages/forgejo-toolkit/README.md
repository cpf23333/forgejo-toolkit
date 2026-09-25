English | [中文](https://codeberg.org/cpf23333/forgejo-toolkit/src/branch/main/README.zh.md)

# Forgejo Toolkit

A VS Code extension for [Forgejo](https://forgejo.org/) (and Codeberg) with a rich Webview-based dashboard: browse repositories, manage issues and pull requests, review PR diffs, and work with notifications — without leaving your editor.

## Features

- **Multiple instances**: connect to several Forgejo/Codeberg instances; access tokens are stored in VS Code SecretStorage.
- **Dashboard**: repositories, issues and pull requests per instance; a linked-repository card follows your workspace git remotes (including multi-remote and nested-repository setups).
- **Repository browsing**: README preview, file browser with search and file history, branches / tags / releases management.
- **Issues & PRs**: list, search, create, edit, close / reopen, delete; Markdown rendering with attachments; comments with image upload.
- **Pull requests**: diff viewer with per-commit diffs, merge (merge / squash / rebase), revert, status checks and merge blockers, create a PR from the current branch in one click from the status bar.
- **PR review**: inline review comments in VS Code's native diff editor, multi-line comments, pending reviews with Comment / Approve / Request changes.
- **Worktrees**: check out a PR into a local worktree, or start work on an issue with a dedicated branch.
- **Notifications**: unread badge, filtering, background polling with VS Code alerts.
- **CI / Actions**: runs, job logs, artifacts download, cancel and trigger workflows.
- **Publish & clone**: publish a local repository to your instance, or clone through VS Code's Git: Clone with server-side search.
- **MCP server for AI agents**: every configured instance is exposed to Copilot agent mode as its own read-only MCP server — 29 tools (issues, PRs, Actions, code browsing, workspace repository detection), prompt templates, and automatic instance matching with zero setup.
- **Localization**: English and 中文.

## Commands

Every command lives in the Command Palette (`Ctrl+Shift+P`, prefix `Forgejo Toolkit`): Open Dashboard, Open Setup Guide, Open Settings, Refresh Instances, Copy Permalink, Publish to Forgejo, View Log, Create PR from Current Branch, Add Pull Review Comment, Delete Review Comment, and Copy MCP Config for Agents Window. Some also appear in the editor context menu, the SCM view, or the status bar.

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

## Notes

- The extension communicates with Forgejo via the REST API (`/api/v1`).
- Access tokens are stored in VS Code SecretStorage (never in plain settings).
- The webview uses `acquireVsCodeApi()` to communicate with the extension host.
- The MCP server needs VS Code ≥ 1.102 and appears automatically in agent mode (no setup). In the Agents window, extension-contributed servers do not reach Agent Host sessions (a current VS Code limitation) — run **"Copy MCP Config for Agents Window"** from the Command Palette to generate a `.mcp.json` pointing at a stable, upgrade-proof path instead.

## Development

```bash
pnpm install
pnpm run build
pnpm run check
```

Open this package in VS Code and press `F5` to launch the Extension Host.

## Scripts

| Script                     | Description                                   |
| -------------------------- | --------------------------------------------- |
| `pnpm run build`           | Build both extension and webview (production) |
| `pnpm run build:extension` | Build extension host only                     |
| `pnpm run build:webview`   | Build webview only                            |
| `pnpm run watch:extension` | Watch extension host                          |
| `pnpm run watch:webview`   | Watch webview                                 |
| `pnpm run check`           | Type-check both TypeScript projects           |
| `pnpm run test`            | Run webview and extension unit tests          |
| `pnpm run package`         | Production build + package a `.vsix` via vsce |

## Packaging

Always package via the script — it runs a production build (mock code
stripped, no sourcemaps) before `vsce` packs the `.vsix`:

```bash
pnpm run package
```
