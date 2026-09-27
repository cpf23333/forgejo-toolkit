# MCP Server Integration

Status: **implemented — Phase 1 shipped and extended (2026-09)**

This document describes how Forgejo Toolkit exposes its configured instances
to AI agents through the [Model Context Protocol](https://modelcontextprotocol.io)
(MCP), and the implementation form in use.

## Goal

Let AI agents — primarily VS Code Copilot agent mode, and optionally external
MCP clients — work with the Forgejo instances the user has already configured
in the extension: "list my open issues", "summarize the review comments on
PR #42", "why did the last CI run fail".

The differentiator over community Gitea/Forgejo MCP servers is **zero
additional configuration**: instances, tokens, and self-hosted URLs already
live in the extension's config and SecretStorage.

## Form: MCP server embedded in the extension

VS Code lets an extension contribute MCP servers declaratively
([MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)):

1. `package.json` contributes `contributes.mcpServerDefinitionProviders` with
   an `id`.
2. `activate()` calls `vscode.lm.registerMcpServerDefinitionProvider(id, …)`
   and returns a `vscode.McpStdioServerDefinition` pointing at a bundled
   Node script. VS Code spawns and supervises the process; agent mode
   discovers its tools.

The extension injects the selected instance's URL and token into the child
process via environment variables (never via tool results or logs).

### Alternatives considered

- **`vscode.lm.registerTool` (LanguageModelTools).** Lightest: no subprocess,
  no MCP SDK. But it only serves VS Code Copilot — external MCP clients
  (Claude Desktop, other agent hosts) cannot use it. Rejected as the only
  form; can be added later if Copilot-only tooling is wanted.
- **Standalone `packages/forgejo-mcp` stdio server.** Would reuse
  `forgejo-api`/`shared` and work outside VS Code, but loses the core
  advantage — it must manage its own URL/token config, duplicating what the
  extension already does. Rejected; remains an option if external (non-VS
  Code) usage becomes a real requirement.

## Architecture

```
VS Code (agent mode)
  │  spawns via McpStdioServerDefinition (one per token-bearing instance)
  ▼
mcp-server process (Node, bundled: out/mcp-server.mjs)
  │  reads FORGEJO_MCP_INSTANCE_URL / FORGEJO_MCP_TOKEN / FORGEJO_MCP_INSTANCE_ID /
  │  FORGEJO_MCP_SYNC_API_URLS / FORGEJO_MCP_PROXY / FORGEJO_MCP_STATE_FILE from env
  ▼
@cpf23333-forgejo-toolkit/api + shared request layer
  │
  ▼
Forgejo instance REST API
```

The same binary can also start with **no environment at all** — see
[Zero-configuration launch](#zero-configuration-launch) below.

- **Entry point:** `packages/forgejo-toolkit/mcp/server.ts`. One esbuild ESM
  build (`splitting: true`) emits both `out/extension.mjs` and
  `out/mcp-server.mjs` plus the shared dependency graph under `out/chunks/` —
  the two entries share almost their whole graph (the broker runs the MCP tool
  logic in the extension host), so separate bundles carried a full copy each.
  A build-time check walks the metafile and rejects the build if any chunk
  reachable from the mcp-server entry imports `vscode`, keeping the MCP
  process headless.
- **SDK:** `@modelcontextprotocol/sdk` (MIT license).
- **Client reuse:** the server constructs the same `ForgejoClient` as the
  extension. Environment-specific behavior (toasts, localization) goes
  through the `ForgejoClientHost` hooks; the MCP process keeps the default
  headless host, where those hooks are no-ops / English passthrough.
- **Instance selection:** one server definition per configured instance that
  has a stored access token, so an agent can reach several instances in the
  same session. Instances without a token are skipped (and logged at debug
  level) so one that is still waiting for its token cannot hide the usable
  ones; when no instance has a token, no server definition is returned. The
  definition provider re-resolves on `onDidChangeMcpServerDefinitions` when
  instances change. Each label is `Forgejo: <instance name>` (falling back to
  the credential-redacted URL), which is how the agent tells the per-instance
  servers apart; when one resolution batch would produce the same label twice
  (two accounts on one host often share a name), the colliding labels — only
  those — get a stable discriminator appended (`Forgejo: <name> (<username or
instance id>)`).
- **Token flow:** `activate()` reads the token from SecretStorage and passes
  it as `env` in `McpStdioServerDefinition`. Tokens never appear in tool
  schemas, results, or log output.
- **Settings flow:** the headless process cannot read the extension's
  settings, so the per-instance `syncApiUrlsToInstanceUrl` flag travels as
  `FORGEJO_MCP_SYNC_API_URLS` in the same launch environment, and the editor's
  `http.proxy` setting travels as `FORGEJO_MCP_PROXY` (the child inherits this
  process's environment, so environment proxies reach it either way; without the
  forwarded setting, MCP requests would connect directly while the extension's
  own requests go through the proxy). There is no
  way to launch this stdio server from an external MCP client: the URL and
  token are injected by VS Code at spawn time.
- **Workspace state flow:** every window also publishes which workspace
  repositories are linked to which configured instance, so the
  `get_workspace_repository` tool can resolve "this repository" without the
  user naming owner/repo. The host reuses `detectLinkedRepositories` (the same
  scan the status bar and the sidebar run, with its shared 10 s cache) and
  atomically writes the result to
  `globalStorage/mcp-workspace-<extension-host-pid>-<per-window-nonce>.json` —
  one file per window, because windows may have different workspaces open;
  the nonce keeps a window that inherits a recycled pid from reading its dead
  predecessor's mapping. The write is triggered by instance-list changes,
  workspace-folder changes, active-editor changes (debounced), and one delayed
  write after registration; all writes are funneled through a module-level
  promise chain, because the atomic write only protects against a crash
  mid-write, not against two triggers racing the same `.part` temporary or an
  older mapping landing after a newer one. Failures are swallowed (the mapping
  is advisory) and surface at info level once per failure streak. The file's
  path travels to the child as `FORGEJO_MCP_STATE_FILE` (shared by all of the
  window's server definitions) and the child re-reads it on every tool call —
  never caches it — so a workspace change is visible within a write cycle. The
  file never carries credentials (instance URLs are userinfo-stripped), and
  `deactivate()` deletes it after waiting out any in-flight write; a
  crash-orphaned file is swept on the next activation (a file whose pid no
  longer exists is deleted; a pid the probe cannot signal counts as alive).
  The `active` flag on an entry is best-effort: the writer only sets it when
  the attribution is unambiguous (a single linked repository, or the active
  editor verifiably inside the attributed one), so it may be false on every
  entry.

## Zero-configuration launch

The server definitions above only exist where VS Code resolves extension
contributions. Sessions that read a **static** MCP configuration instead —
the user-level `<profile>/User/mcp.json`, a workspace `.vscode/mcp.json`,
a root `.mcp.json` read natively by the Agents window's Agent Host — can
carry only `command` + `args`, with no per-instance environment. For those,
the same `out/mcp-server.mjs` starts with no `FORGEJO_MCP_*` variables at
all and discovers the instance itself (`mcp/autoConfig.ts`, wired into
`server.ts`; all of it is skipped the moment `FORGEJO_MCP_INSTANCE_URL` is
set, so the VS Code-spawned path is unchanged).

A static configuration cannot point at `out/mcp-server.mjs` directly: the
install directory is versioned (`cpf23333.forgejo-toolkit-<version>`), so
the path breaks on every upgrade. The extension therefore additionally
publishes a **stable-path shim** in the same globalStorage directory:
`globalStorage/mcp-server.js`, a tiny CommonJS stub that `import()`s the
current installation's ESM bundle (`out/mcp-server.mjs` runs `main()` at
module scope, so the import starts the server; the path inside is written
with forward slashes so a Windows install path needs no backslash
escaping). It is
rewritten on every activation — only when the content changed, so a plain
window load does not bump the file's mtime — which is what makes the fixed
path self-healing across upgrades. `deactivate()` does not remove it, and
it is written regardless of the instance list: it describes the
installation, not the accounts.

The `forgejoToolkit.copyAgentsWindowMcpConfig` command generates the
snippet with this shim path and offers three destinations: the user-level
`mcp.json` (derived from `globalStorageUri` — two levels up is the owning
profile's `User` directory, so a profile install lands in its own
profile's registry, matching VS Code's per-profile MCP configuration), the
workspace's `.vscode/mcp.json`, or the clipboard. Both write targets are
merged (`servers` key merged, a same-named `forgejo` entry overridden, an
unparseable existing file reported and left untouched). A root `.mcp.json`
is deliberately **not** a write target: VS Code does not read it ("Cannot
start unknown MCP server customization"), only the Agent Host does — and
sessions with worktree isolation never see it, because the session
workspace is the isolated worktree, not the user's checkout. VS Code reads
the two targets above and forwards them to Agent Host sessions instead.

To make that possible, the extension host additionally publishes an
**instance registry** next to the per-window state files:
`globalStorage/mcp-instances.json`, a fixed name shared by all windows,
holding `{ updatedAt, instances: [{ id, url, name }] }` — the URL with its
userinfo stripped, and never a token. It is written on activation and on
every instance-list change, through the same atomic write; `deactivate()`
does not remove it (it describes account configuration, not window state),
and an emptied instance list is written as an empty array rather than
deleting the file, so a consumer can tell "no instances" apart from
"extension never ran".

When `FORGEJO_MCP_INSTANCE_URL` is absent, startup resolves the instance in
this order:

1. **Data directory.** `FORGEJO_MCP_DATA_DIR` wins when set (tests and
   unconventional installs point it straight at the directory containing
   `mcp-instances.json`). Otherwise the platform defaults are searched:
   `%APPDATA%\Code\User\globalStorage\cpf23333.forgejo-toolkit` (Windows),
   `~/Library/Application Support/Code/User/globalStorage/...` (macOS),
   `~/.config/Code/User/globalStorage/...` (Linux, honoring
   `XDG_CONFIG_HOME`), each also under `Code - Insiders`, plus one glob level
   of profile variants (`User/profiles/*/globalStorage/...`). The editor's
   `state.vscdb` and the OS keychain are deliberately _not_ read: the
   database schema is an internal that changes between versions, and a
   headless child touching the keychain would trip the OS credential prompt.
   No registry anywhere — or one that does not parse — is a startup error
   whose message lists the directories searched.
2. **Workspace state shortcut.** The newest readable `mcp-workspace-*.json`
   whose entries place the process's working directory in a known checkout
   answers the instance URL directly (paths compared resolved, case-folded
   on Windows only). Only the newest file is consulted; a stale older file
   must not outvote the git fallback.
3. **Git remote matching.** The working directory's `.git/config` is parsed
   as INI (never by spawning git; the gitfile/commondir form of worktrees is
   followed), and each remote — origin first — is matched against the
   registry: http(s) remotes compare host **and** port plus the instance's
   deployment sub-path as a prefix, ssh/scp remotes compare host plus
   sub-path and ignore the transport port. This is a vscode-free simplified
   variant of `remoteMatchesInstance` in `src/worktree/gitOperations.ts`,
   which cannot be reused because that module imports `vscode`. When several
   registry instances match the same remote (two accounts on one host), the
   first wins and a stderr note says so — the registry carries no username,
   so the owner namespace cannot disambiguate; a known limitation.
4. **Last-resort guess from the newest state file.** Some MCP hosts launch
   the server with a working directory that is no checkout at all — VS Code's
   Agents window runs Agent Host servers from the user's home directory — so
   both steps above can miss while the user clearly _has_ a Forgejo workflow.
   The newest state file's `active` entry (the repository the editor context
   is attributed to), or its first entry when nothing is flagged, then
   supplies the instance URL. Because this is a guess that can pick the wrong
   instance for the task at hand, the stderr log line says so explicitly
   ("working directory matched nothing; verify this is the instance you
   intend").
5. **No match** is a startup error listing the registry's (credential-free)
   instance URLs and pointing at `FORGEJO_MCP_INSTANCE_URL`.

The token still comes only from `FORGEJO_MCP_TOKEN`; a zero-configuration
launch without it reads anonymously (public data only) **unless the extension
host's broker is reachable** — see [Broker mode](#broker-mode) below, which is
tried before everything in this section. When the discovery saw a workspace
state file, its path also feeds `get_workspace_repository`
as if `FORGEJO_MCP_STATE_FILE` had been set; an explicit variable always
wins.

## Broker mode

Zero-configuration launch still leaves a statically launched server
_anonymous_: a static `mcp.json` carries no environment, so no token reaches
the child. Broker mode closes that gap without moving the token. When the
extension host is running, one window (the first to bind the endpoint, or a
survivor that took the endpoint over when the owner went away) starts
a local **broker** — `net.createServer` on a named pipe (Windows) or unix
socket — and the statically launched `mcp-server.js` becomes a pure
forwarder that bridges its stdio onto the broker connection. The real tool
logic, token included, executes inside the extension host process; the token
never crosses into the forwarder.

```
static mcp.json host (Agents window / third-party client)
  │  spawns: node mcp-server.js        (no FORGEJO_MCP_* env)
  ▼
forwarder (this process)               mcp/brokerForwarder.ts
  │  reads globalStorage/mcp-broker.json → { endpoint, authToken }
  │  connects, sends { authToken, cwd } as the first NDJSON line
  │  then pipes stdin ↔ socket ↔ stdout verbatim
  ▼  named pipe \\.\pipe\forgejo-toolkit-mcp-<user hash> / unix socket in tmpdir
broker in the extension host           mcp/brokerServer.ts + src/mcpBroker.ts
  │  per connection: own createMcpServer(ForgejoClient(token)) over a
  │  SocketTransport (same NDJSON framing as stdio)
  ▼
Forgejo instance REST API
```

- **Registration.** The broker publishes `globalStorage/mcp-broker.json`
  (`McpBrokerRegistryFile` in `packages/shared/src/mcp/workspaceState.ts`):
  `{ version: 1, pid, endpoint, authToken, startedAt }`, written atomically,
  owner-only (0600 in a 0700 globalStorage directory; the unix socket itself
  is chmod 0600 after listen). The forwarder discovers it through the same
  data-directory scan as the instance registry (`discoverBrokerRegistration`
  in mcp/autoConfig.ts): a candidate whose pid is verifiably dead is skipped
  as crash-orphaned, and among the survivors newest mtime wins across
  flavors/profiles.
- **Handshake.** The forwarder's first line is `{ authToken, cwd }`. The
  broker compares the token in constant time and disconnects immediately on a
  mismatch (the presented value is never logged); on a match it answers
  `{ "ok": true }` and the socket carries the MCP session verbatim — MCP
  stdio framing is NDJSON, so the pipe uses the same framing and neither side
  re-encodes. Line assembly buffers raw bytes and decodes only complete
  lines, so a multi-byte UTF-8 character split across read chunks is not
  corrupted, and one unterminated line may buffer at most 4 MB before the
  connection is dropped (the listener also caps concurrent connections at
  64). A connection that never completes its handshake is dropped after 10 s.
  The `cwd` is what the broker uses to resolve the session's instance.
- **Sessions.** Every connection gets its own `McpServer` instance — the MCP
  SDK binds a server to a single transport — built from a `ForgejoClient`
  carrying the resolved instance's token. The version gate reuses the
  extension host's existing probe cache (activation already probes every
  instance), so the broker never probes again. The workspace state file
  passed to `get_workspace_repository` follows the session's cwd: the
  per-window state file whose checkout contains it (see instance resolution),
  falling back to the owning window's own.
- **Instance resolution** (per session): first the per-window workspace state
  files in globalStorage — if an entry's `localPath` contains the forwarder's
  cwd, that window's state file and (when token-bearing) its instance serve
  the session, because one machine-wide broker can receive sessions for a
  _different_ window's workspace. Otherwise, if the cwd sits inside a
  checkout this window has linked to an instance (via the shared
  `detectLinkedRepositories` scan cache), that instance wins; as a last
  resort the first token-bearing instance answers — the Agents window
  launches servers from the user's home directory, which is no checkout at
  all, and an authenticated instance beats an anonymous one. A detected
  instance without a token loses to the token-bearing fallback.
- **Lifecycle.** Multi-window: the first window to bind the endpoint wins;
  other windows' `listen` fails with EADDRINUSE and they step aside with a
  debug log (and no registration write); EACCES is logged as a real local
  failure instead, and starts no watcher. A stepped-aside window keeps a 5 s
  (unref'd) watcher on the registration: it re-reads
  `globalStorage/mcp-broker.json` and probes the recorded pid with
  `process.kill(pid, 0)` — the same rule as the forwarder's `isPidAlive` —
  and when the file is gone (clean `deactivate()`) or names a dead pid (a
  crash), it tries to bind itself. That attempt runs the ordinary post-bind
  path — its own live pid in the registration, the info line — so a takeover
  is indistinguishable from a first bind for every client. Binding stays the
  arbiter: there is no file lock and no election, and two watching windows
  that tick together simply race, with the loser's EADDRINUSE meaning "keep
  watching". `cleanupMcpBroker()` (deactivation, or
  `forgejoToolkit.mcpEnabled` turned off) clears the watcher along with the
  broker. On unix a leftover socket file from a crashed broker is
  distinguished from a live owner by a connect probe: refused means stale, so
  it is unlinked and the listen retried once. `deactivate()` closes the
  broker and deletes the registration file; a crash-orphaned file is harmless
  because the forwarder's connect simply fails. The unix socket file is
  unlinked on close only when its inode is still the one this broker created,
  so an overlapping shutdown never deletes a successor broker's live socket.
  When the broker closes mid-session the forwarder logs an info line and
  exits 0 (draining buffered output first — no `process.exit` truncation); a
  socket _error_ mid-session (anything but the ECONNRESET of a closing unix
  peer) exits 1 with a stderr message, and the MCP client reports the server
  as stopped.
- **Degradation order.** Startup with no `FORGEJO_MCP_INSTANCE_URL` tries, in
  order: broker forwarding → the zero-configuration discovery above. Any
  pre-handshake failure (no registration file, connect refused, rejected
  handshake, timeout) falls through to the anonymous zero-configuration
  launch. A failure _after_ the handshake does not: silently restarting an
  in-flight session as a different, anonymous server would be worse than a
  clean stop.

### Security model (broker)

The `authToken` in `mcp-broker.json` is a random per-broker-launch secret
(32 bytes, hex), **not** a Forgejo token — the file never carries one. It
gates the pipe so an unrelated local process cannot make the extension host
issue authenticated requests on its behalf. The file is written owner-only
(0600) inside the extension's owner-only globalStorage directory, and the
unix socket is chmod 0600 after listen; on Windows the named pipe's default
DACL already restricts it to the owning user. What a forwarded session proves
is "same local user who can read globalStorage" — exactly the trust level the
VS Code-spawned path already grants its stdio children. The secret is sent
once per connection and never logged by either side (the broker's rejection
log deliberately omits the presented value).

## Minimum VS Code version

`mcpServerDefinitionProviders` / `registerMcpServerDefinitionProvider`
require a recent VS Code, so `engines.vscode` and `@types/vscode` were
raised to `^1.102.0` / `~1.102.0` when the feature shipped. Older VS Code
versions are no longer supported by the extension as a whole.

## Tool surface

All tools are read-only, carry `readOnlyHint` annotations, and reuse the
client's paginated methods with their `MAX_ITEMS` caps so a runaway agent
cannot pull unbounded data. Tool results pass through a per-field size
budget (~10 KB per string field); single-string payloads (job logs, diffs,
file contents) are subject to the same truncation, as their descriptions
state.

### Phase 1 (read-only core)

| Tool                 | Maps to                                                      |
| -------------------- | ------------------------------------------------------------ |
| `list_issues`        | `getRepoIssues` / `getUserIssues`                            |
| `get_issue`          | `getIssueDetail` (+ comments)                                |
| `list_pull_requests` | `getRepoPullRequests` / `getUserPullRequests`                |
| `get_pull_request`   | `getPullRequestDetail` (+ files, commits)                    |
| `get_pr_timeline`    | `getPullRequestCommentsAndTimeline`                          |
| `list_notifications` | `getNotifications`                                           |
| `get_repo`           | `getRepoDetail`                                              |
| `search`             | `searchIssues` / `searchPullRequests` / `searchRepositories` |

### Actions

| Tool                       | Maps to                                               |
| -------------------------- | ----------------------------------------------------- |
| `list_action_runs`         | `listActionRuns`                                      |
| `get_action_run_jobs`      | `getActionRunJobs`                                    |
| `get_action_job_log`       | `getActionJobLog`                                     |
| `get_ci_failure_summary`   | `getActionRunJobs` + `getActionJobLog` per failed job |
| `get_action_run_artifacts` | `getActionRunArtifacts`                               |

The Actions endpoints only exist on Forgejo/Gitea ≥ 1.19. The version gate
lives inside the client methods (`MIN_ACTIONS_VERSION`, fail-open when the
server version is unknown); the resulting error propagates to the tool layer
unchanged, so the tools themselves carry no extra gating. Job logs arrive as
one large string and are truncated to ~10 KB by the result budget.

`get_ci_failure_summary` is the context-budget counterpart to that truncation:
instead of one `get_action_job_log` call per failed job — whose ~10 KB budget
keeps the _start_ of the log, exactly the end where a failing step prints — it
returns, in a single call, the error-looking lines with surrounding context and
the last ~100 lines of each failed job's log. Every slice is pre-sized to a
shared extraction budget so `truncateLargeStrings` never has to cut the tail it
worked to obtain, and each job reports whether its log was cut (`tailTruncated`,
`errorContextTruncated`) or cut before the tool saw it (`truncatedByClient`, the
client's own 10 MB cap, which keeps the head — the real tail is then only
readable in the Forgejo web UI). Passed jobs are listed with name and status only
when `includePassedJobs` is set, and are never read.

### Code reading

| Tool                 | Maps to                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `get_file_content`   | `getFileContent`                                                   |
| `list_repo_contents` | `getRepoContents`                                                  |
| `list_branches`      | `getRepoBranches`                                                  |
| `list_tags`          | `getRepoTags`                                                      |
| `list_commits`       | `getRepoBranchCommits`                                             |
| `get_file_history`   | `getFileHistory`                                                   |
| `search_repo_files`  | `searchRepoFiles` (+ `getRepoDefaultBranch` when `ref` is omitted) |
| `get_pr_diff`        | `getPullRequestDiff`                                               |

`ref`/`branch` parameters are optional and default to the repository default
branch, matching how the underlying endpoints treat an omitted ref. Diffs
arrive as one large string and are truncated to ~10 KB by the result budget.

### Reviews and metadata

| Tool                       | Maps to                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `list_pull_reviews`        | `listPullReviews`                                                                                       |
| `get_pull_review_comments` | `getPullReviewComments`                                                                                 |
| `get_pr_review_brief`      | `getPullRequestDetail` + `getPullRequestFiles` + `listPullReviews` + `getPullReviewComments` per review |
| `whoami`                   | `getCurrentUser`                                                                                        |
| `list_releases`            | `getRepoReleases`                                                                                       |
| `list_labels`              | `getRepoLabels`                                                                                         |
| `list_milestones`          | `getRepoMilestones`                                                                                     |
| `list_my_repos`            | `getUserRepositories`                                                                                   |

Overlap note: `get_pr_timeline` already returns inline review comment
_bodies_ (timeline entries of type `code`, carrying `review_id`), but not
their file path or line position — and the code location is the point of an
inline review comment. `get_pull_review_comments` therefore stays as a
dedicated tool; the extension's own review-comment controller relies on the
same endpoint for exactly this reason.

`get_pr_review_brief` is the review entry point: one call returns the pull
request header (title, state, author, base/head branch, merge blockers), the
diff statistics (changed-file count and totals from the pull request record,
plus a per-file additions/deletions table — never the diff text), each
reviewer's latest conclusion with an aggregate summary, and the unresolved
inline review comments with path, line, author and time. It is the context
budget counterpart to reading the four tools one after another: the diff text,
the description, the commit list and the timeline stay out, and the prompt
tells the agent to reach for `get_pr_diff` / `get_pull_request` /
`get_pr_timeline` when a review actually needs them. Inline comments hang off
one review each upstream (there is no all-comments page), so the tool issues
one comment request per review with a bounded pool (4 in flight), absorbs a
failed per-review read into `unreadableReviewCount` instead of discarding the
other reviews, and treats a conversation as resolved when any of its comments
carries Forgejo's `resolver` (upstream sets it only on the first comment, so a
reply would otherwise look unresolved). Every section is pre-sized to stay
inside `truncateLargeStrings` by construction: the diff table is capped at 100
rows and 16 KB (`diffStats.truncated` / `truncatedBy` = `row-limit`,
`budget`, the client's own 500-row list cap, or `server-partial` — the server
returning fewer files than the pull request record's `fileCount` with no cut
on this side, seen from Forgejo 16 when the head branch is gone after a
merge), comment bodies at 1 KB each
and 50 comments / 24 KB in total (`unresolvedComments.truncatedBy` = `count`
or `budget`, `bodyTruncated` per comment, newest kept), while the
`fileCount`/`additions`/`deletions` totals stay exact.

### Workspace context

| Tool                       | Maps to                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `get_workspace_repository` | the window's workspace state file (`FORGEJO_MCP_STATE_FILE`) |

`get_workspace_repository` answers "which repository is the user working
in?" from the host-published state file: the repositories of _this_ server's
instance (matched by the instance id from `FORGEJO_MCP_INSTANCE_ID` first, so
two accounts on the same host stay apart, and by URL when an older host never
sent the id), with the `active` flag marking the one the editor context is
attributed to (best-effort — it may be false on every entry), or — when the
workspace's repositories belong to other
configured instances — which instance each of them belongs to, so the agent
knows to use that instance's MCP server. A missing, unreadable, or
unconfigured state file is an ordinary answer ("no workspace information" /
"not configured"), not an error, and the tool stays registered either way to
keep the tool surface stable. The child also refuses paths that do not look
like this extension's own state file name and files beyond a 1 MiB sanity
bound: the path arrives through the process environment, which a hand-edited
launch can point anywhere. It is the tool an agent should call first when
the user says "this repo" / "the current project" without naming owner/repo.

## Prompts

Three MCP prompts ship next to the tools: parameterised instruction templates a
user can start from the agent host's prompt picker. A prompt performs no I/O of
its own — it expands into a single user message that names the tools to call, the
order to call them in and the answer shape to produce — so it needs no client,
no result budget and no `readOnlyHint`. The read-only guarantee still comes from
the tools a template names, and each template repeats it in prose so an expansion
cannot be read as permission to write.

| Prompt                | Arguments                   | Purpose                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review-pull-request` | `owner?`, `repo?`, `index?` | `get_pr_review_brief` first (header, diff statistics, review conclusions, unresolved comments), then `get_pr_diff` / `get_pr_timeline` / `get_pull_request` / `list_pull_reviews` for the detail the brief leaves out, then a summary, findings ordered by severity (each with file/line evidence) and suggestions; never submits a review. |
| `analyze-ci-failure`  | `owner?`, `repo?`, `runId?` | `list_action_runs` (find the failing run) → `get_ci_failure_summary` (error lines + log tails) → `get_action_job_log` only for raw context, then the root cause, a suggested fix and a flakiness check.                                                                                                                                     |
| `triage-issue`        | `owner?`, `repo?`, `index?` | `get_issue` → `list_labels` / `get_repo` (plus `search` for duplicates), then suggested labels, a priority and next steps.                                                                                                                                                                                                                  |

All arguments are optional. When `owner`/`repo` are absent, the template tells
the agent to call `get_workspace_repository` first and to use what it returns; a
missing number is resolved with the matching listing tool
(`list_pull_requests`, `list_action_runs`, `list_issues`). Prompt arguments are
strings on the wire, so `index` and `runId` are declared as strings and the
template turns them back into the number the tools expect. The SDK builds and
validates the argument object itself, so a client with no values to pass must
send an empty `arguments` object rather than omitting the field.

Prompts are an entry point onto the tool surface, not a second implementation of
it: a template may only name tools that exist in `tools.ts`, and it describes
their limits (per-field and whole-result truncation, capped lists) instead of
implying a capability the tools do not have. Registration lives in
`packages/forgejo-toolkit/mcp/prompts.ts` and is wired next to `registerTools` in
`createMcpServer`.

## Environment variables

| Variable                    | Content                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FORGEJO_MCP_INSTANCE_URL`  | The instance URL, verbatim (credential userinfo is refused at configuration time; only a value stored by an older extension version can still carry it). Optional: when absent, the server auto-discovers the instance (see Zero-configuration launch) |
| `FORGEJO_MCP_INSTANCE_ID`   | The configured instance's id; matched against state-file entries before the URL                                                                                                                                                                        |
| `FORGEJO_MCP_TOKEN`         | The instance's access token. Optional: without it the tools read anonymously (public data only), which is what an `mcp.json` the Agent Host reads natively should use rather than storing a token at rest                                              |
| `FORGEJO_MCP_SYNC_API_URLS` | `'false'` disables rewriting API URLs to the instance URL                                                                                                                                                                                              |
| `FORGEJO_MCP_PROXY`         | The editor's `http.proxy`, when configured                                                                                                                                                                                                             |
| `FORGEJO_MCP_STATE_FILE`    | This window's workspace → repository state file                                                                                                                                                                                                        |
| `FORGEJO_MCP_DATA_DIR`      | Explicit override for the directory auto-discovery reads `mcp-instances.json` from (tests, unconventional installs); absent: the platform defaults                                                                                                     |
| `FORGEJO_MCP_DEBUG`         | `'true'` enables debug logging on the child's stderr                                                                                                                                                                                                   |

## Security model

- The tool surface is read-only by design; write tools (below) will ship
  disabled by default.
- Tokens are injected via process env only; the server scrubs them from any
  error it returns (`userFacingErrorMessage` never includes headers).
- That injection happens exclusively at spawn time, by the extension host. A
  server started from a static `mcp.json` (the Agents window / Agent Host
  route) is launched by VS Code without the extension — but while the
  extension host runs, its **broker** serves such launches with full
  authenticated tools inside the host process (see [Broker mode](#broker-mode));
  the token still never leaves the host. Only when no broker is reachable
  does the static route degrade to anonymous reads. There is deliberately no
  fallback that would let the child read SecretStorage itself — reaching into
  the OS credential store from an external process is what credential theft
  looks like, and the boundary is what keeps tokens off disk and out of logs.
  A user who needs authenticated calls with the extension _not_ running puts
  `FORGEJO_MCP_TOKEN` into the `env` of their own `mcp.json` entry by hand (a
  plaintext secret at rest; a read-only-scoped token is recommended), or uses
  the main window where the injection exists.
- Tool results truncate large bodies (comments, diffs, logs) to a fixed
  budget (~10 KB per field) and cap the whole serialized result (64 KB), with
  an explicit marker when either cap fires, to protect the agent's context
  window and avoid exfiltrating repository content through unexpected
  channels.
- A list that reached the client's 500-item cap is announced as well (the
  result text ends with `(list truncated at 500 items: <fields>; …)`, naming the
  capped field when the payload wraps one, e.g. `comments` or `files`). The
  result is JSON text, so a consumer that parses it must tolerate that trailing
  prose note — and a result cut by the 64 KB budget is no longer valid JSON at
  all. `tools/ui-review/src/mcpCheck.mjs` strips the note before parsing.
- Inputs that become part of a request path (`owner`, `repo`, file paths) are
  validated against path-segment traversal, so a forged tool argument cannot
  turn a repository-scoped read into an arbitrary same-origin request.
- Read-only tools are annotated `readOnlyHint`, which means VS Code runs them
  **without** a per-call confirmation prompt. The human-in-the-loop guarantee
  therefore rests on the tool surface: every tool maps to a `GET` endpoint —
  the one exception is `get_workspace_repository`, which issues no request at
  all and only reads the local state file the extension publishes.
  Phase 2 write tools will not carry `readOnlyHint`, so each mutating call is
  confirmed in the VS Code UI (also to stay aligned with the Codeberg hosting
  rules: no autonomous agents acting on the user's behalf without per-action
  confirmation).
- The server never requests MCP _sampling_ (server-initiated model calls via
  `createMessage`): it is a plain tool/prompt surface and makes no LLM calls of
  its own. VS Code still shows its generic per-server "Configure Model Access"
  menu entry for it — that setting is a no-op here. If a future feature wants
  server-side model use (e.g. an agent-facing tool that self-summarizes),
  sampling is the MCP-native route and this document must then cover the
  model-access grant; UI-facing AI features (like the planned PR description
  draft) should instead use `vscode.lm` on the host, where the webview is not
  an MCP client at all.

## Testing

- Unit: tool handlers against the MSW mock server (same fixtures as
  `client.test.ts`) — `mcp/__tests__/tools.test.ts`. That file also covers the
  path-segment / repository-path guards (`isSafePathSegment`, `isSafeRepoPath`)
  directly, since the handlers are called without MCP schema validation. The
  workspace state file has its own round-trip tests: the writer in
  `src/__tests__/mcpWorkspaceState.test.ts`, the reader (filtering, instance
  attribution, missing/corrupt file) in `mcp/__tests__/workspaceState.test.ts`,
  and the multi-definition provider in `src/__tests__/mcpServerProvider.test.ts`.
  The zero-configuration discovery (registry reading, state-file shortcut,
  `.git/config` remote matching, failure messages) is covered by
  `mcp/__tests__/autoConfig.test.ts`; `server.ts` is only the wiring.
  The broker is covered end to end over real sockets (named pipes on Windows,
  socket files elsewhere): handshake rejection, an initialize → tools/list
  round trip through the forwarder bridge, parallel sessions, and shutdown
  signalling — `mcp/__tests__/broker.test.ts`; the registration discovery by
  the same autoConfig test file; the host-side wiring (registration file
  lifecycle, endpoint contention, instance resolution) by
  `src/__tests__/mcpBroker.test.ts`.
- Integration: the server connected over the MCP SDK's `InMemoryTransport`,
  asserting the tool listing and a round trip per tool group —
  `mcp/__tests__/server.test.ts`.
- Prompts: the same `InMemoryTransport` harness asserts the prompt listing
  (names, descriptions, all-optional argument schemas) and the text each
  template expands to, both with arguments supplied and with none —
  `mcp/__tests__/prompts.test.ts`.
- Manual: VS Code agent mode smoke test ("list my issues") against a real
  instance — done for Phase 1 before release.

## Future directions

- **Phase 2 write tools (gated, separately approved):** `create_issue`,
  `create_comment`, `create_pull_request`, `submit_pull_review`,
  `merge_pull_request`, `mark_notification_read`. Omitting `readOnlyHint` on
  these makes VS Code ask the user to confirm each tool call; they will
  additionally require individual opt-in in extension settings (default off).
