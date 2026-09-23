import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ForgejoClient, type ClientLogger } from '../src/api/client';
import { userFacingErrorMessage } from '../src/api/errors-core';
import { probeServerVersion } from '../src/api/versionProbe';
import { setDefaultRequestDispatcher } from '../src/api/client';
import { createProxyDispatcher, resolveProxyUrl } from '../src/api/proxy';
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

  const syncApiUrls = process.env.FORGEJO_MCP_SYNC_API_URLS === 'false' ? false : undefined;
  // The MCP process reads the environment only: there is no editor setting here.
  setDefaultRequestDispatcher(createProxyDispatcher(resolveProxyUrl(process.env)));
  const client = new ForgejoClient(url, token, logger, syncApiUrls);
  const server = createMcpServer(client);
  // The extension host probes the server version on activation and caches it per
  // instance URL, but this process has its own module state and never runs
  // activation — without a probe here the Actions version gate
  // (`assertActionsSupported`) would always see "unknown" and pass, making the
  // gate dead code on the MCP side. The probe runs in the background: the server
  // starts serving immediately, and the gate fails open until the version is
  // known, which is exactly how it behaves in the editor.
  void probeServerVersion(url, token, logger, syncApiUrls);
  await server.connect(new StdioServerTransport());
  logger.info(`MCP server ready for ${url}`);
}

main().catch((error: unknown) => {
  console.error(`forgejo-toolkit MCP server failed: ${userFacingErrorMessage(error)}`);
  process.exit(1);
});
