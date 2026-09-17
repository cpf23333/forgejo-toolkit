import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ForgejoClient } from '../src/api/client';
import { registerTools } from './tools';
import packageJson from '../package.json';

/**
 * Builds the MCP server with the phase-1 (read-only) tool surface. Kept
 * separate from server.ts so tests can connect it over InMemoryTransport
 * instead of stdio.
 */
export function createMcpServer(client: ForgejoClient): McpServer {
  const server = new McpServer({ name: 'forgejo-toolkit', version: packageJson.version });
  registerTools(server, client);
  return server;
}
