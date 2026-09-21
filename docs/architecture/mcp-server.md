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
  │  spawns via McpStdioServerDefinition
  ▼
mcp-server process (Node, bundled: out/mcp-server.js)
  │  reads FORGEJO_MCP_INSTANCE_URL / FORGEJO_MCP_TOKEN from env
  ▼
@cpf23333-forgejo-toolkit/api + shared request layer
  │
  ▼
Forgejo instance REST API
```

- **Entry point:** `packages/forgejo-toolkit/mcp/server.ts`, bundled by
  esbuild to `out/mcp-server.js` as a third build artifact (next to
  `extension.js` and the webview bundle). An esbuild plugin rejects any
  `vscode` import in this bundle, keeping the MCP process headless.
- **SDK:** `@modelcontextprotocol/sdk` (MIT license).
- **Client reuse:** the server constructs the same `ForgejoClient` as the
  extension. Environment-specific behavior (toasts, localization) goes
  through the `ForgejoClientHost` hooks; the MCP process keeps the default
  headless host, where those hooks are no-ops / English passthrough.
- **Instance selection:** exactly one instance is exposed per server
  process — the one marked default / first configured. The definition
  provider re-resolves on `onDidChangeMcpServerDefinitions` when instances
  change. Multi-instance fan-out remains a future direction (see below).
- **Token flow:** `activate()` reads the token from SecretStorage and passes
  it as `env` in `McpStdioServerDefinition`. Tokens never appear in tool
  schemas, results, or log output.

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

| Tool                       | Maps to                 |
| -------------------------- | ----------------------- |
| `list_action_runs`         | `listActionRuns`        |
| `get_action_run_jobs`      | `getActionRunJobs`      |
| `get_action_job_log`       | `getActionJobLog`       |
| `get_action_run_artifacts` | `getActionRunArtifacts` |

The Actions endpoints only exist on Forgejo/Gitea ≥ 1.19. The version gate
lives inside the client methods (`MIN_ACTIONS_VERSION`, fail-open when the
server version is unknown); the resulting error propagates to the tool layer
unchanged, so the tools themselves carry no extra gating. Job logs arrive as
one large string and are truncated to ~10 KB by the result budget.

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

| Tool                       | Maps to                 |
| -------------------------- | ----------------------- |
| `list_pull_reviews`        | `listPullReviews`       |
| `get_pull_review_comments` | `getPullReviewComments` |
| `whoami`                   | `getCurrentUser`        |
| `list_releases`            | `getRepoReleases`       |
| `list_labels`              | `getRepoLabels`         |
| `list_milestones`          | `getRepoMilestones`     |
| `list_my_repos`            | `getUserRepositories`   |

Overlap note: `get_pr_timeline` already returns inline review comment
_bodies_ (timeline entries of type `code`, carrying `review_id`), but not
their file path or line position — and the code location is the point of an
inline review comment. `get_pull_review_comments` therefore stays as a
dedicated tool; the extension's own review-comment controller relies on the
same endpoint for exactly this reason.

## Security model

- The tool surface is read-only by design; write tools (below) will ship
  disabled by default.
- Tokens are injected via process env only; the server scrubs them from any
  error it returns (`userFacingErrorMessage` never includes headers).
- Tool results truncate large bodies (comments, diffs, logs) to a fixed
  budget (~10 KB per field) to protect the agent's context window and avoid
  exfiltrating repository content through unexpected channels.
- The human-in-the-loop story stays explicit: every mutating call will be
  initiated by the user's own agent and confirmed in VS Code UI (also to
  stay aligned with the Codeberg hosting rules: no autonomous agents acting
  on the user's behalf without per-action confirmation).

## Testing

- Unit: tool handlers against the MSW mock server (same fixtures as
  `client.test.ts`) — `mcp/__tests__/tools.test.ts`.
- Integration: the server connected over the MCP SDK's `InMemoryTransport`,
  asserting the tool listing and a round trip per tool group —
  `mcp/__tests__/server.test.ts`.
- Manual: VS Code agent mode smoke test ("list my issues") against a real
  instance — done for Phase 1 before release.

## Future directions

- **Phase 2 write tools (gated, separately approved):** `create_issue`,
  `create_comment`, `create_pull_request`, `submit_pull_review`,
  `merge_pull_request`, `mark_notification_read`. VS Code agent mode already
  asks the user to confirm each tool call; write tools will additionally
  require individual opt-in in extension settings (default off).
- **Multi-instance fan-out:** one server per configured instance, or an
  `instance` tool parameter, instead of the single default instance.
- **MCP prompts:** preset prompt templates (e.g. "review this PR") on top of
  the tool surface.
