# Architecture

This document describes the high-level architecture of Forgejo Toolkit.

## Overview

Forgejo Toolkit is a VS Code extension with a Webview-based user interface. It is organized as a pnpm workspace monorepo:

- `packages/forgejo-toolkit` — VS Code extension host.
- `packages/forgejo-api` — Generated Forgejo API client.
- `packages/shared` — Shared HTTP client and common types.

## Extension host

The extension host is written in TypeScript and bundled with esbuild. It is responsible for:

- Registering the tree view, commands, and webview panels.
- Managing VS Code configuration and secrets.
- Running Git worktree commands for PR checkouts.
- Forwarding messages between the webview and the Forgejo API.

## Webview UI

The webview UI is a Vue 3 single-page application built with Vite. It communicates with the extension host through the VS Code webview message API and renders the dashboard, repository details, issues, pull requests, and settings.

## API layer

The `forgejo-api` package is generated from the Forgejo OpenAPI specification using Kubb. It exports typed fetch functions and MSW handlers for testing. The `shared` package provides a thin request client that handles base URLs, authentication headers, and response parsing.

## Communication

See [communication.md](./communication.md) for the message protocol between the extension host and the webview.

## State management

See [state-management.md](./state-management.md) for how application state is shared across the webview.

## API client

See [api-client.md](./api-client.md) for how the generated API client is used and extended.

## MCP server (proposal)

See [mcp-server.md](./mcp-server.md) for the proposal to expose configured instances to AI agents via MCP.
