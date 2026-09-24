# Architecture

This document describes the high-level architecture of Forgejo Toolkit.

## Overview

Forgejo Toolkit is a VS Code extension with a Webview-based user interface. It is organized as a pnpm workspace monorepo:

- `packages/forgejo-toolkit` — VS Code extension host.
- `packages/forgejo-api` — Generated Forgejo API client.
- `packages/shared` — Shared HTTP client and common types.

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
