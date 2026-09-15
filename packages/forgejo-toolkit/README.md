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
- **Localization**: English and 中文.

## Notes

- The extension communicates with Forgejo via the REST API (`/api/v1`).
- Access tokens are stored in VS Code SecretStorage (never in plain settings).
- The webview uses `acquireVsCodeApi()` to communicate with the extension host.

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
