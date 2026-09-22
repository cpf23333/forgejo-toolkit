import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ForgejoClient, type ClientLogger } from '../src/api/client';
import { userFacingErrorMessage } from '../src/api/errors-core';
import { createMcpServer } from './mcpServer';

// A stdio MCP server must keep stdout clean for the protocol framing, so all
// diagnostics go to stderr. The token is never logged: request logs carry
// method + URL only, and errors are rendered via userFacingErrorMessage,
// which never includes request headers.
const logger: ClientLogger = {
  isDebugEnabled: () => process.env.FORGEJO_MCP_DEBUG === 'true',
  debug(message: string) {
    if (this.isDebugEnabled()) {
      console.error(`[DEBUG] ${message}`);
    }
  },
  info: (message: string) => console.error(`[INFO] ${message}`),
  error: (message: string) => console.error(`[ERROR] ${message}`),
};

async function main(): Promise<void> {
  const url = process.env.FORGEJO_MCP_INSTANCE_URL;
  const token = process.env.FORGEJO_MCP_TOKEN;
  if (!url || !token) {
    console.error('forgejo-toolkit MCP server: FORGEJO_MCP_INSTANCE_URL and FORGEJO_MCP_TOKEN must both be set.');
    process.exit(1);
  }

  const client = new ForgejoClient(
    url,
    token,
    logger,
    // The headless process cannot read the extension's settings, so the
    // per-instance URL-sync flag arrives through the launch environment.
    // Anything other than 'false' (including unset) keeps the client default,
    // which is syncing enabled.
    process.env.FORGEJO_MCP_SYNC_API_URLS === 'false' ? false : undefined,
  );
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
  logger.info(`MCP server ready for ${url}`);
}

main().catch((error: unknown) => {
  console.error(`forgejo-toolkit MCP server failed: ${userFacingErrorMessage(error)}`);
  process.exit(1);
});
