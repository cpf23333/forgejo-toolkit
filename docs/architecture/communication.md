# Extension Host — Webview Communication

The webview and the extension host exchange JSON messages over the VS Code webview
message API. The webview posts through the wrapper in
`packages/forgejo-toolkit/webview/src/composables/vscode.ts` (`postMessage`, which
JSON-clones into `acquireVsCodeApi()`), and the host posts back through its `_reply`
helper in `viewProvider.ts` (which calls `webview.postMessage`). Every message is
discriminated by a `command` string field.

## Where the message types live

Both directions are typed in one file, shared by the host bundle and the webview
bundle:

- `packages/shared/src/webview/messages.ts`
  - `HostToWebviewMessage` — host to webview
  - `WebviewToHostMessage` — webview to host

Import them as `@cpf23333-forgejo-toolkit/shared/webview/messages` (the shared
package's `exports` map, `packages/shared/package.json`). There is no
`packages/forgejo-toolkit/src/types/messages.ts`.

The host dispatches every incoming message in
`packages/forgejo-toolkit/src/webview/viewProvider.ts` (`_dispatchMessage`, wired
from the webview's `onDidReceiveMessage`); the dashboard webview handles replies in
`packages/forgejo-toolkit/webview/src/composables/useAppState.ts` (`handleMessage`).
The onboarding panel (`packages/forgejo-toolkit/src/webview/onboardingPanel.ts`) and
the PR review comment panel
(`packages/forgejo-toolkit/src/comments/pullReviewCommentPanel.ts`) speak the same
protocol with their own dispatch loops.

## Request / response convention

There is no `{ id, result | error }` envelope, and no generic `getIssues`,
`getPullRequests`, `openInWorktree`, `worktreeChanged` or `log` command. A request
is a typed message carrying a unique **`_requestId`** string that the webview
generates; the reply is the operation-specific typed message that echoes it:

1. The webview registers a pending promise under a generated id
   (e.g. `` `render-${++renderMarkdownRequestId}` ``) and posts the request, e.g.
   `{ command: 'createIssueComment', …, _requestId }`.
2. The host runs the handler — usually a `ForgejoClient` method from
   `packages/forgejo-toolkit/src/api/client.ts`, sometimes a Git command — and
   posts the matching typed reply (`issueCommentCreated`, `renderedMarkdown`,
   `issueCreated`, …).
3. The reply carries its own payload plus `error?: string`. The webview resolves
   the pending promise when that field is absent and rejects it when it is set.

Only requests that need a correlated promise carry `_requestId`: the creations and
attachment calls (`createIssue`, `createIssueComment`, `createPullRequest`,
`createRepoRelease`, `createIssueAttachment`, `deleteIssueAttachment`,
`createIssueCommentAttachment`, `deleteIssueCommentAttachment`,
`createReleaseAttachment`, `deleteReleaseAttachment`) and the on-demand lookups
(`renderMarkdown`, `searchMentions`, `getUserPreview`, `getIssuePreview`).

`showInputBox` and `showConfirm` use their own `id` field instead:
`{ command: 'showConfirm'; id; message; confirmLabel }` → `showConfirmResult`,
`showInputBox` → `showInputBoxResult`.

Every other webview-to-host message is either fire-and-forget (`openNativeSettings`,
`openDashboard`, `setLocale`, `setDebug`, `setActiveView`, `openExternal`, …) or a
loader whose reply is routed by the fields it echoes rather than by an id
(`getRepoIssues` → `repoIssues`, which carries `instanceId`/`owner`/`repo`/`state`).

`setActiveView` is the sidebar's report of the route it is showing: the host stores
it under the context key `forgejoToolkit.activeView`, which gates the view-title
refresh commands (see [README.md](./README.md), the Webview UI section). It is a
plain report, not a setting: it changes nothing on the host side but that key, and
the host ignores a value it does not contribute.

## Error handling

- A handler that returns without replying, or throws, cannot leave the webview
  hanging: `_dispatchMessage` tracks outstanding `_requestId`s and posts the
  generic fallback `{ command: 'requestError', _requestId, error }` (declared in
  `messages.ts`, emitted by the `_dispatchMessage` wrapper in `viewProvider.ts`).
  The webview rejects the matching pending request in `useAppState.ts`
  (`case 'requestError'`).
- The webview additionally times a pending request out
  (`DEFAULT_REQUEST_TIMEOUT_MS = 60_000`, applied by `registerPending` in
  `useAppState.ts`) so a lost reply surfaces as `common.requestTimeout` instead of
  an endless spinner.
- Messages rejected before any handler runs (unknown instance, unsafe
  `owner`/`repo`, …) are answered through the same reply contract by
  `_replyResultShapedError`, not silently dropped.

## Notifications (no request)

The host also pushes messages the webview did not have to request: `initialState`,
`instances`, `setLocale` and `setDebug` (a settings change made in the settings UI or
in another panel), `refreshData`, `openDashboard`,
`openNotifications`, `openCreatePullRequest`, `openNewIssue`,
`openPullRequestDetail`, `linkedRepository`, `worktreesList`, `worktreeOpened`,
`worktreeError`, `worktreeCancelled`, `worktreeRemoved`, `worktreeOpenMode`,
`worktreeCacheDirectory`, `polledNotifications` and `openPullReviewCommentEditor`.
A few of these are replies on their normal path (`linkedRepository`,
`worktreeOpenMode`, `worktreeCacheDirectory`); the complete set of host-to-webview
variants is the `HostToWebviewMessage` union in
`packages/shared/src/webview/messages.ts`.

On load the sidebar and every panel that uses this message posts one `initialState`
message (`_reply('initialState', …)` in
`viewProvider.ts`, `onboardingPanel.ts`, `pullReviewCommentPanel.ts`; the settings
tab reads its own `settingsSurface` instead): public
instances with the token stripped to a `tokenFingerprint` (`toPublicInstance` in
`messages.ts`), the locale, the debug flag, the worktree list, the worktree open
mode, and the worktree cache directory plus its default. The webview stores it in
the shared reactive store (see [state-management.md](./state-management.md)).

## Confirmations are host-enforced

Destructive commands (delete\*, merge, dispatchWorkflow, …) are confirmed by the
host itself: the handler awaits `_confirmDestructive` in `viewProvider.ts` (a modal
`vscode.window.showWarningMessage`) before executing, and reports a declined dialog
as `cancelled?: true` on its typed reply rather than as an error. The webview must
not call `showConfirm()` for those commands — that would double-prompt.
Webview-side `showConfirm()` is only for confirmations that involve no host command.
