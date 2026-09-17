# MCP Server Integration (Proposal)

Status: **proposal, not implemented** (2026-09-15)

This document proposes exposing Forgejo Toolkit's configured instances to AI
agents through the [Model Context Protocol](https://modelcontextprotocol.io)
(MCP), and recommends an implementation form.

## Goal

Let AI agents — primarily VS Code Copilot agent mode, and optionally external
MCP clients — work with the Forgejo instances the user has already configured
in the extension: "list my open issues", "summarize the review comments on
PR #42", "create a PR from the current branch".

The differentiator over community Gitea/Forgejo MCP servers is **zero
additional configuration**: instances, tokens, and self-hosted URLs already
live in the extension's config and SecretStorage.

## Chosen form: MCP server embedded in the extension

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
- **Standalone `packages/forgejo-mcp` stdio server.** Reuses
  `forgejo-api`/`shared` and works outside VS Code, but loses the core
  advantage — it must manage its own URL/token config, duplicating what the
  extension already does. Rejected as the first step; remains an option if
  external (non-VS Code) usage becomes a real requirement.

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

- **New entry point:** `packages/forgejo-toolkit/mcp/server.ts`, bundled by
  esbuild to `out/mcp-server.js` as a third build artifact (next to
  `extension.js` and the webview bundle). The extension package.json's
  `.vscodeignore` already ships `out/**`.
- **SDK:** `@modelcontextprotocol/sdk` (MIT license — compatible; verify with
  `pnpm licenses list --prod` when adding).
- **Client reuse:** the server constructs the same `ForgejoClient` (or a
  slimmed variant without `vscode` imports — the client currently imports
  `vscode` for toasts/timeouts, so the MCP bundle either stubs it or the
  client gains a headless mode; decide during implementation).
- **Instance selection (MVP):** exactly one instance is exposed per server
  process — the one marked default / first configured. The definition
  provider re-resolves on `onDidChangeMcpServerDefinitions` when instances
  change. Multi-instance fan-out (one server per instance, or an
  `instance` tool parameter) is a later refinement.
- **Token flow:** `activate()` reads the token from SecretStorage and passes
  it as `env` in `McpStdioServerDefinition`. Tokens never appear in tool
  schemas, results, or log output.

## Minimum VS Code version

`mcpServerDefinitionProviders` / `registerMcpServerDefinitionProvider` landed
well after our current `engines.vscode: ^1.85.0`. Implementing this feature
requires raising `engines.vscode` and `@types/vscode` (currently pinned
`~1.85.0`) to the first stable release carrying the API (~1.102), dropping
older VS Code versions. This is the primary compatibility cost — confirm it
is acceptable before starting.

## Tool surface

### Phase 1 (read-only MVP)

| Tool | Maps to |
|---|---|
| `list_issues` | `getRepoIssues` / `getUserIssues` |
| `get_issue` | `getIssue` (+ comments) |
| `list_pull_requests` | `getRepoPullRequests` / `getUserPullRequests` |
| `get_pull_request` | `getPullRequest` (+ files, commits) |
| `get_pr_timeline` | `getPullRequestCommentsAndTimeline` |
| `list_notifications` | `getNotifications` |
| `get_repo` | `getRepo` |
| `search` | `getSearch` (issues/PRs/repos) |

All read-only; all reuse existing paginated client methods with their
`MAX_ITEMS` caps so a runaway agent cannot pull unbounded data.

### Phase 2 (write tools, gated)

`create_issue`, `create_comment`, `create_pull_request`,
`create_pr_from_current_branch` (workspace-aware, reusing the linked-repo
detection). VS Code agent mode already asks the user to confirm each tool
call; the proposal additionally requires write tools to be individually
enabled in extension settings (default off).

## Security model

- Phase 1 is read-only by design; write tools ship disabled by default.
- Tokens are injected via process env only; the server scrubs them from any
  error it returns (reuse `userFacingErrorMessage`, which never includes
  headers).
- Tool results truncate large bodies (comments, diffs) to a fixed budget
  (~10 KB per item) to protect the agent's context window and avoid
  exfiltrating repository content through unexpected channels.
- The human-in-the-loop story stays explicit: every mutating call is
  initiated by the user's own agent and confirmed in VS Code UI. Docs must
  state this plainly (also to stay aligned with the Codeberg hosting rules:
  no autonomous agents acting on the user's behalf without per-action
  confirmation).

## Testing

- Unit: tool handlers against the existing MSW mock server (same fixtures as
  `client.test.ts`).
- Integration: spawn the bundled server over stdio with the MCP SDK's test
  client; assert tool listing and a round trip for each phase-1 tool.
- Manual: VS Code agent mode smoke test ("list my issues") against a real
  instance before release.

## Rollout

1. Raise `engines.vscode` / `@types/vscode`; verify no >pinned API usage
   sneaks in elsewhere (the pin exists precisely to catch that).
2. Headless-client refactor + `mcp/server.ts` + third esbuild entry.
3. `mcpServerDefinitionProviders` contribution + env injection + instance
   change re-resolution.
4. Phase-1 tools + tests.
5. Docs: README/FAQ feature entries (en/zh), ROADMAP, this document updated
   from proposal to spec.
6. Phase 2 (write tools) as a separate, explicitly-approved step.
