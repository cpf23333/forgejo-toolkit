# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Individual developers** managing personal Forgejo repositories and wanting quick access to issues and PRs without leaving VS Code.
- **Small-team collaborators** using Forgejo/Codeberg for daily development, review, and issue tracking.
- **Multi-instance maintainers** who operate across several Forgejo/Codeberg instances and need a single, grouped view of repositories, issues, and pull requests.

## Product Purpose

Forgejo Toolkit is a VS Code extension that brings Forgejo repository management into the editor. It lets users browse multiple Forgejo instances, view repository details, manage issues and pull requests, inspect file trees and diffs, and check out PRs to local worktrees — all from the VS Code sidebar.

## Positioning

Unlike the Forgejo web UI or single-instance browser extensions, Forgejo Toolkit centers on a **unified multi-instance view**. A developer can add several Forgejo/Codeberg accounts or servers and see repositories, issues, and PRs grouped by instance in one panel, reducing context switching and keeping workflow state inside the editor.

## Operating Context

- Runs as a VS Code extension with a webview-based sidebar panel.
- Users open the panel from the activity bar and navigate through instances, repositories, issues, PRs, branches/tags/releases, and file trees.
- Token-based authentication; access tokens are stored in VS Code SecretStorage.
- Interface is localized for Chinese and English.

## Capabilities and Constraints

- **Multi-instance management**: add, edit, and remove multiple Forgejo instances.
- **Dashboard**: grouped repository, issue, and pull-request lists by instance.
- **Repository details**: README preview, recent commits, branch/tag/release lists, file browser with search and history.
- **Issue / PR management**: list, detail, create, edit, close/reopen, comment, and attachment handling.
- **PR diff**: changed-file list and native VS Code diff editor integration.
- **PR worktree**: check out `refs/pull/<index>/head` to a configurable local worktree.
- **Internationalization**: all user-facing strings must support Chinese and English.
- **VS Code native aesthetic**: UI uses VS Code theme CSS variables and `@vscode-elements/elements` components.
- **Light testing scope**: this is a personal side project; features are lightly tested, and edge cases are expected.

## Product Principles

1. **Stay inside VS Code**: prefer native panels, editors, and commands over external browser windows.
2. **Instance-first grouping**: every view starts from the instance so multi-instance users never lose context.
3. **Native VS Code feel**: use theme tokens and standard web components so the extension looks like part of the editor.
4. **Bilingual by default**: every new label, message, and dialog must be added to both language files.
5. **Progressive disclosure**: show the most relevant actions first; advanced options live in menus or secondary screens.
