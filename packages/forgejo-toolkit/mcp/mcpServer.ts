import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ForgejoClient } from '../src/api/client';
import { registerTools, type WorkspaceContextOptions } from './tools';
import { registerPrompts } from './prompts';
import packageJson from '../package.json';

/**
 * Builds the MCP server with the tool surface (read-only tools plus the two
 * gated write tools, which refuse unless the session was established by the
 * extension host and the tool's own switch is on) and its prompt templates.
 * Kept separate from server.ts so tests can connect it over InMemoryTransport
 * instead of stdio.
 *
 * `workspaceContext` carries the workspace state file the extension host
 * publishes (see src/mcpWorkspaceState.ts) and, where the host supplies them,
 * the write-tool gates and the audit sink; it defaults to "not configured, no
 * writes" so tests and external launches keep the full tool surface without
 * gaining a write capability.
 */
export function createMcpServer(client: ForgejoClient, workspaceContext: WorkspaceContextOptions = {}): McpServer {
  const server = new McpServer({ name: 'forgejo-toolkit', version: packageJson.version });
  registerTools(server, client, workspaceContext);
  registerPrompts(server);
  return server;
}
