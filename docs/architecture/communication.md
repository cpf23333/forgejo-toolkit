# Extension Host — Webview Communication

The webview and the extension host communicate through JSON messages over `acquireVsCodeApi().postMessage`.

## Message direction

- `HostToWebviewMessage` — sent from the extension host to the webview.
- `WebviewToHostMessage` — sent from the webview to the extension host.

## Initial state

When the webview loads, the extension host sends a single `initialState` message containing:

- configured Forgejo instances
- current locale
- debug logging flag
- worktree list
- worktree open mode and cache directory

The webview stores this state in a shared reactive store and renders the UI.

## Request / response pattern

Most webview-to-host messages follow a request/response pattern:

1. The webview posts a message with a unique `id`.
2. The extension host handles the request, calls the Forgejo API or runs a Git command.
3. The extension host posts a response with the same `id` and either a `result` or `error`.

Example message types:

- `getRepositories`
- `getIssues`
- `getPullRequests`
- `getFileHistory`
- `createIssue`
- `openInWorktree`

## Notifications

Some host-to-webview messages are notifications without a corresponding request:

- `initialState`
- `worktreeChanged`
- `log`

## Error handling

Errors are returned as `{ id, error: { message, code? } }`. The webview should display the message and optionally retry transient failures.

## Type safety

Message types are defined in `packages/forgejo-toolkit/src/types/messages.ts` and shared between the extension host and the webview build.
