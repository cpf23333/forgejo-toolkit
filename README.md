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
- **Settings export / import**: export instances (optionally encrypted) and settings to JSON, and import them back with a conflict preview.
- **Internationalization**: supports switching between Chinese and English.
- **Debug logs**: optional API request logging to the `Forgejo Toolkit` Output Channel.

## Installation

### From VSIX

```bash
pnpm --filter forgejo-toolkit package
```

Then in VS Code click **Extensions → ... → Install from VSIX** and select the generated `forgejo-toolkit-0.0.1.vsix`.

### From Marketplace

> Not yet published. It will be available on the VS Code Marketplace later.

## Usage

1. After installing the extension, click the **Forgejo Toolkit** icon in the activity bar to open the Dashboard.
2. On first use you will enter the onboarding page to configure the Forgejo instance URL and access token.
3. Browse repositories, Issues, and PRs in the Dashboard; click a repository card to open repository details.
4. On Issue / PR detail pages you can comment, edit, close / reopen.
5. On a PR detail page, click "Open in Worktree" to check out to a local worktree.

## Screenshots

> The following screenshot placeholders correspond to images in the `docs/screenshots/` directory. Replace them with real screenshots before release.

### Dashboard

![Dashboard](./docs/screenshots/dashboard.png)

### Repository Details - Overview

![Repository Overview](./docs/screenshots/repo-overview.png)

### Repository Details - File Browser

![Repository File Browser](./docs/screenshots/repo-file-browser.png)

### Repository Details - Branches / Tags / Releases

![Repository Refs](./docs/screenshots/repo-refs.png)

### Issue List and Detail

![Issue List and Detail](./docs/screenshots/issue-list-and-detail.png)

### Pull Request List and Detail

![Pull Request List and Detail](./docs/screenshots/pr-list-and-detail.png)

### PR Diff

![PR Diff](./docs/screenshots/pr-diff.png)

### Issue / PR Edit Dialog

![Issue PR Edit Dialog](./docs/screenshots/issue-pr-edit-dialog.png)

### PR Worktree

![PR Worktree](./docs/screenshots/pr-worktree.png)

### Settings

![Settings](./docs/screenshots/settings.png)

## Known Limitations

See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) (English) and [KNOWN_ISSUES.zh.md](./KNOWN_ISSUES.zh.md) (Chinese).

Main limitations:

- PR attachments must be fetched from the Issue API.
- The multi-file diff editor does not show M/R badges for modified / renamed files.
- Forgejo's PR files API may omit deleted files (the extension uses the compare API to work around this).

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

## Screenshot Checklist (to be added before release)

Place the following screenshots in the `docs/screenshots/` directory, keeping the filenames consistent with the README references:

1. `dashboard.png` — Dashboard panel showing repository / Issue / PR lists and instance collapse behavior.
2. `repo-overview.png` — Repository "Overview" tab showing README, recent commits, and default branch info.
3. `repo-file-browser.png` — Repository "Files" tab showing directory tree, file search, or file history dialog.
4. `repo-refs.png` — Repository "Refs" tab showing branch / tag / release lists.
5. `issue-list-and-detail.png` — Issue list + Issue detail page.
6. `pr-list-and-detail.png` — PR list + PR detail page.
7. `pr-diff.png` — Changed file list on the PR detail page, or the VS Code diff editor.
8. `issue-pr-edit-dialog.png` — Issue / PR edit dialog showing Markdown editor and attachment area.
9. `pr-worktree.png` — PR detail page "Open in Worktree" flow, or worktree settings panel.
10. `settings.png` — Settings page showing instance list, worktree config, and language switch.

## Project Status

This is a personal side project. Features are tested only lightly, so bugs and edge cases are expected. Please open an issue if you run into any problems.

## Feedback & Contributions

Bug reports, feature requests, pull requests, documentation improvements, and any other feedback are welcome.  
If you have ideas for better interactions, layouts, workflows, or anything else, feel free to open an issue or start a discussion.

## License

[MIT](./LICENSE)
