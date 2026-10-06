# Webview State Management

The webview does not use a store library (no Pinia, no Vuex, no `store/index.ts`).
A single shared store object is created by `createAppState()` and exposed through
the `useAppState()` singleton in
`packages/forgejo-toolkit/webview/src/composables/useAppState.ts`. That composable
is the entry point for reading state, triggering commands, and — through its
`handleMessage` reply handler — writing every piece of state the host sends.

## Creating the store

`useAppState()` creates the store on its first call and caches it in a
module-level `sharedState`, so every component, view and composable in one
webview instance shares the same reactive object and the same host message
listener. There is no `provide`/`inject` key to use instead.

The store is built with two injected dependencies, so the host app installs both
plugins before any component calls the composable (see `webview/src/main.ts`):

- `useI18n()` from `vue-i18n` — supplies `t` and the `locale` ref.
- `useRouter()` from `vue-router` — used for navigation (see [Routing](#routing)).
  `useRouter()` injects rather than throws, and the two standalone panels
  (onboarding, pull request review comment) mount without a router, so the
  router usage inside the composable is optional-chained.

## Store shape

State lives in Vue `ref`s and `reactive(new Map())` objects. Route state is
**not** part of it: there is no `currentView` or `viewParams` key (routing
belongs to vue-router, see below).

Root state:

- `instances` — the configured Forgejo instances (`ForgejoInstance[]`). Token
  values never reach the webview: the host strips them to a `tokenFingerprint`,
  so this is all a view can read.
- `locale` — the `vue-i18n` ref (`zh` or `en`).
- `debug` — whether API request logging is enabled.
- `worktrees`, `worktreeOpenMode`, `worktreeCacheDirectory` (plus
  `worktreeCacheDirectoryDefault`) — local worktree state and settings.
- `linkedRepository`, `linkedRepositories`, `selectedLinkedRepoPath` — the
  workspace repositories linked to a configured instance.
- View-owned UI state such as `dashboardActiveTab`, `globalSearchQuery` and
  `globalSearchActiveScope`.

Payload state is a set of reactive `Map`s keyed by instance id or by
`${instanceId}:${owner}/${repo}` (see the key helpers at the bottom of the
module, e.g. `repoDetailKey`): `repositories`, `myIssues`, `myPullRequests`,
`repoDetails`, `issueDetails`, `pullRequestDetails`, `repoIssues`,
`repoPullRequests`, `actionRuns`, `actionRunDetails`, `actionRunJobs`,
`actionRunArtifacts`, `actionJobLogs`, `repoBranchCommits`, `pullRequestFiles`,
`pullRequestComments`, `pullRequestCommits`, `repoContents`, `repoRefs`,
`fileHistories`, `repoFileSearchResults`, `globalSearchResults`,
`notifications`, `repoLabels`, `repoAssignees`, `repoMilestones`, and the "fresh"
marks that guard list TTLs (`repoIssuesFetchedAt`,
`repoPullRequestsFetchedAt`).

Those maps are bounded because the store outlives navigation
(`retainContextWhenHidden` keeps it alive):

- `MAX_PAYLOAD_ENTRIES` (64) — every payload write goes through
  `setPayloadEntry`, which evicts the oldest key rather than growing past the cap.
- `MAX_SEARCH_ENTRIES` (50) and `MAX_JOB_LOG_ENTRIES` (10) cap the file-search /
  global-search result maps and the per-run CI job logs, which would otherwise
  retain every query and every log of a session.
- The `loading` / `errors` tracking maps are module-level and capped by
  `MAX_TRACKING_ENTRIES` (500).
- Leaving a repository (`router.afterEach` → `clearRepoPayloads`) or changing an
  instance's identity (`clearInstancePayloads`) releases that scope's entries
  immediately.

Alongside the refs, the composable returns computed values such as
`unreadNotificationCount` and `unreadViewNotificationCount`.

## Mutations

There are no generic setters named `setInstances`, `setLocale`, `setDebug`,
`setWorktrees` or `setCurrentView`; code written against them does not compile.
State changes through three routes:

1. **UI-level helpers in the composable**, called from views and returned by
   `useAppState()`: `changeLocale`, `changeDebug`, `setDashboardActiveTab`,
   `setGlobalSearchQuery`, `setGlobalSearchScope`, `selectLinkedRepository`,
   `setWorktreeCacheDirectory`, `changeWorktreeOpenMode`, …
2. **Loaders and commands in the composable** — they write the local slot (a
   loading mark, a pending request) and post a typed message to the host:
   `loadRepoDetail`, `loadRepoIssues`, `loadNotifications`, `createIssueComment`,
   `openPrWorktree`, `renderMarkdown`, … The host answers with a reply message.
3. **`handleMessage()`** — the single reply entry point, installed by
   `window.addEventListener('message', handleMessage)` from the composable's
   `onMounted`. It owns every host-driven write and is the place to look when
   state changes "by itself".

`handleMessage` switches on `message.command`:

- `initialState` — seeds `instances`, `locale`, `debug`, `worktrees`,
  `worktreeOpenMode`, `worktreeCacheDirectory`/`Default` and the linked
  repository on panel load.
- `instances` — replaces the list; an instance whose identity changed also has
  its payloads dropped (`clearInstancePayloads`) and its dashboard lists
  re-requested.
- `setLocale` / `setDebug` — the host pushing a settings change (made in the
  settings UI or in another panel), which is why `<html lang>` is kept in sync by
  a `watch` rather than only in `changeLocale`.
- `refreshData` — re-fetches the visible instance data.
- Route pushes (`openDashboard`, `openNotifications`,
  `openCreatePullRequest`, `openNewIssue`, `openPullRequestDetail`) — carry any
  pending payload as their own ref (`pendingCreatePr`, `pendingNewIssue`) and
  navigate through the router instead of writing a "current view" field.
- Per-request replies — `handleRepositories`, `handleRepoIssues`,
  `handleRepoDetail`, `handleRenderedMarkdown`, …, each writing the payload slot
  its request asked for. Correlated replies carry the `_requestId` the webview
  generated (`registerPending`) and resolve or reject the waiting promise;
  `requestError` rejects it when the host's handler produced no reply, and the
  webview's own timeout rejects after 60 s — 5 min for the requests the host
  may block on a human decision: the host-confirmed attachment deletes and the
  `showInputBox`/`showConfirm` native dialogs.

**A save's outcome is reported, not inferred** (`handleIssueSaved` /
`handlePullRequestSaved`, 2026-10-06). The host answers `issueUpdated` /
`pullRequestUpdated` with **no error exactly when the edit was accepted**, and that is
what the edit dialogs act on: `IssueDetail.vue` and `PullRequestDetail.vue` each watch
their own `lastSavedIssue` / `lastSavedPullRequest` signal, and the view that owns the
saved target closes its dialog (and, when it has marked attachments, deletes them). The
parsed `item` the reply may also carry is **not** the outcome: it is what the
repository's issue/pull-request lists refresh from, so it only decides the list
invalidation. The two used to be the same condition, which made a success reply without
that payload close nothing and say nothing — the dialog stayed open with no error, which
is what the isolated dev host showed on the plain manual-edit path. A reply **with** an
error is the other half of the rule: it writes that sentence onto the form's own key and
leaves the save signal alone, so the dialog stays open with everything the reader typed
and the form shows the reason — never silently.

The request/reply protocol itself is documented in
[communication.md](./communication.md).

## Routing

Routing is vue-router; the store holds no route state. `createAppRouter()` in
`packages/forgejo-toolkit/webview/src/router/index.ts` builds the router (with
`createMemoryHistory()`, since a webview has no address bar) from the exported
`routes`, each view lazy-loaded:

| route name          | path                                                 |
| ------------------- | ---------------------------------------------------- |
| `dashboard`         | `/`                                                  |
| `globalSearch`      | `/search`                                            |
| `notifications`     | `/notifications`                                     |
| `repoDetail`        | `/repo/:instanceId/:owner/:repo`                     |
| `repoIssues`        | `/repo/:instanceId/:owner/:repo/issues/:state?`      |
| `repoPullRequests`  | `/repo/:instanceId/:owner/:repo/pulls/:state?`       |
| `issueDetail`       | `/issue/:instanceId/:owner/:repo/:index`             |
| `pullRequestDetail` | `/pull/:instanceId/:owner/:repo/:index`              |
| `actionRunDetail`   | `/repo/:instanceId/:owner/:repo/actions/runs/:runId` |

Two routes left this table when the settings page moved into an editor-area tab
(`docs/design/settings-page.md` §9.3, §10.6): `settings` and `importPreview`. Both
views are rendered by that tab's own surface now, so the sidebar neither carries
them nor downloads them.

- Navigation is `router.push({ name, params })`. The composable does it in its
  own helpers (`openRepoDetail`, `openPullRequestDetail`, …) and in the route
  pushes listed above; among the views `Dashboard.vue` alone navigates through its
  own `useRouter()` — `Settings.vue`, `ImportPreview.vue` and `Onboarding.vue` no
  longer import `vue-router` at all, and `Notifications.vue` reads `useRoute()`
  without navigating.
- The data a view needs comes from `useRoute().params` (`RepoDetail.vue`,
  `RepoIssues.vue`, `RepoPullRequests.vue`, `IssueDetail.vue`,
  `PullRequestDetail.vue`, `ActionRunDetail.vue`). Route params are the real
  replacement for a `viewParams` store key.
- `router.afterEach` releases the payloads of the repository a navigation left
  behind; the views stay alive in the keep-alive cache, so nothing else would
  free them.

## Reactivity

Read state through the composable (`const { instances, locale } = useAppState()`
or `useAppState().instances`) and derive from it with `computed` / `watch`. The
returned refs and reactive `Map`s are what keep rendering live; copying a map
entry into a plain local variable takes it out of the reactive graph, so read the
map again (or compute from it) instead of caching the value.

## Testing

`packages/forgejo-toolkit/webview/src/__tests__/helpers/test-utils.ts` provides
`createTestRouter()`, `createTestI18n()`, `mockVSCodeApi()`,
`stubVSCodeElements()` and `mountWithPlugins()`; `src/__tests__/setup.ts`
installs the global `acquireVsCodeApi` mock and the `<vscode-*>` stubs for the
whole suite.

The store is a module-level singleton and the host message listener is installed
in `onMounted`, so a test that needs a fresh store calls `vi.resetModules()`,
dynamically imports `composables/useAppState`, and mounts a component whose
`setup()` calls `useAppState()` (see `composables/__tests__/useAppState.test.ts`,
which then feeds host replies through the captured `message` listener). Tests that
cover navigation use `createTestRouter()`; the no-router case is covered by
`composables/__tests__/useAppState.withoutRouter.test.ts`.
