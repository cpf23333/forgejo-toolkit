# Architecture

This document describes the high-level architecture of Forgejo Toolkit.

## Overview

Forgejo Toolkit is a VS Code extension with a Webview-based user interface. It is organized as a pnpm workspace monorepo:

- `packages/forgejo-toolkit` — VS Code extension host.
- `packages/forgejo-api` — Generated Forgejo API client.
- `packages/shared` — Shared HTTP client and common types, plus the wire schemas both sides of a boundary have to agree on: the webview message union (`src/webview/messages.ts`), the MCP on-disk records (`src/mcp/workspaceState.ts` — `McpWorkspaceStateFile`, `McpInstanceRegistryFile`, `McpBrokerRegistryFile`), `src/git/url.ts` and `src/limits.ts`.

## Extension host

The extension host is written in TypeScript and bundled with esbuild. It is responsible for:

- Registering the webview view (`forgejoToolkitView`, a `webview`-type view in the `forgejoToolkit` activity-bar container, registered with `registerWebviewViewProvider`), commands, and the standalone webview panels.
- Managing VS Code configuration and secrets.
- Running Git worktree commands for PR checkouts.
- Forwarding messages between the webview and the Forgejo API.

## Webview UI

The webview UI is a Vue 3 single-page application built with Vite. It communicates with the extension host through the VS Code webview message API and renders the dashboard, repository details, issues, pull requests, and settings.

## API layer

The `forgejo-api` package is generated from the Forgejo OpenAPI specification using Kubb. It exports typed fetch functions and MSW handlers for testing. The `shared` package provides a thin transport client that builds URLs, sets the default headers (`Accept`, plus `Content-Type` on a JSON body) and parses responses. Authentication is not part of it: the extension host's `ForgejoClient` adds `Authorization: token <token>` (see [api-client.md](./api-client.md)).

## Communication

See [communication.md](./communication.md) for the message protocol between the extension host and the webview.

## State management

See [state-management.md](./state-management.md) for how application state is shared across the webview.

## API client

See [api-client.md](./api-client.md) for how the generated API client is used and extended.

## MCP server

See [mcp-server.md](./mcp-server.md) for the implemented MCP server (embedded in the extension, `packages/forgejo-toolkit/mcp/`) that exposes configured instances to AI agents.

## Window coordination

See [window-coordination.md](./window-coordination.md) for the two mechanisms that coordinate several windows on one machine: the notification-polling lease that lets exactly one window poll and alert (`forgejoToolkit.multiWindowLease`, on by default), and the shared server-version probe cache.

## Design documents

Documents under [`docs/design/`](../design/) record decisions **at the moment they are made** — the problem, the chosen approach, the rejected alternatives and the evidence that would change the decision. A design document is a decision record, not a status field: some of those decisions have since shipped, and the architecture pages above are where the shipped behaviour is described. A shipped design is not reduced to a pointer: the matching architecture page describes the mechanism the code now implements, while the design document stays the decision record and the home of its own measurements — the soak numbers and symbol-level assertions in [multi-window-polling-lease.md](../design/multi-window-polling-lease.md), for example, are cited by [window-coordination.md](./window-coordination.md) rather than repeated there.

- [MCP Phase 2 write tools: the confirmation model](../design/mcp-write-tools-confirmation.md) — per-tool settings defaulting to off, no `readOnlyHint` (VS Code's own tool approval becomes the first gate), refusal instead of anonymous fallback when no extension host is running, idempotency, dry-run, audit trail. Decided but not implemented.
- [Multi-window "one window leads" polling lease](../design/multi-window-polling-lease.md) — **implemented**, see [window-coordination.md](./window-coordination.md): a `globalStorage` lease file claimed with an atomic `fs.open(…, 'wx')` instead of a `globalState` timestamp, heartbeat/expiry versus the poll interval, handover on `deactivate()`, and the rule that every failure degrades towards polling rather than towards silently not notifying.
