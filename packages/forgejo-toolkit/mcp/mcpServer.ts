import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ForgejoClient } from '../src/api/client';
import { registerTools, type WorkspaceContextOptions } from './tools';
import packageJson from '../package.json';

/**
 * Builds the MCP server with the read-only tool surface. Kept
 * separate from server.ts so tests can connect it over InMemoryTransport
 * instead of stdio.
 *
 * `workspaceContext` carries the workspace state file the extension host
 * publishes (see src/mcpWorkspaceState.ts); it defaults to "not configured"
 * so tests and external launches keep the full tool surface.
 */
export function createMcpServer(client: ForgejoClient, workspaceContext: WorkspaceContextOptions = {}): McpServer {
  const server = new McpServer({ name: 'forgejo-toolkit', version: packageJson.version });
  registerTools(server, client, workspaceContext);
  return server;
}
