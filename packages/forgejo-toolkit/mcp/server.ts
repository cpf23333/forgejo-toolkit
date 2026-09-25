import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ForgejoClient, type ClientLogger } from '../src/api/client';
import { userFacingErrorMessage } from '../src/api/errors-core';
import { probeServerVersion, redactInstanceUrl } from '../src/api/versionProbe';
import { setDefaultRequestDispatcher } from '../src/api/client';
import { createProxyDispatcher, getProxyFetch, resolveProxyUrl } from '../src/api/proxy';
import { createMcpServer } from './mcpServer';
import { resolveAutoConfiguration } from './autoConfig';

// A stdio MCP server must keep stdout clean for the protocol framing, so all
// diagnostics go to stderr. The token is never logged: request logs carry
// method + URL only, and errors are rendered via userFacingErrorMessage,
// which never includes request headers. The instance URL is passed through
// `redactInstanceUrl` wherever it is logged, because the configured value may
// itself embed credentials (`https://user:token@host`).
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
  let url = process.env.FORGEJO_MCP_INSTANCE_URL;
  let stateFile = process.env.FORGEJO_MCP_STATE_FILE;
  // Zero-configuration launch: a static workspace `.mcp.json` can carry only
  // command + args, so a server started that way has no instance URL in its
  // environment and discovers it instead — from the extension's published
  // instance registry plus this working directory's workspace state or git
  // remotes (see mcp/autoConfig.ts). When FORGEJO_MCP_INSTANCE_URL *is* set
  // the launch behaves exactly as before; auto-discovery never overrides it.
  if (!url) {
    const auto = await resolveAutoConfiguration();
    if (auto.status === 'failed') {
      console.error(`forgejo-toolkit MCP server: ${auto.message}`);
      process.exit(1);
    }
    url = auto.url;
    // The discovered state file feeds get_workspace_repository when the
    // launch environment never provided one; an explicit one always wins.
    stateFile ??= auto.stateFile;
    // The fallback phrasing says "guess" on purpose: the working directory
    // matched nothing, so the instance came from the most recent workspace
    // the extension saw — which may not be the one this session is about.
    const viaMessage =
      auto.via === 'state-file'
        ? 'via the workspace state file.'
        : auto.via === 'git-remote'
          ? 'via the git remotes of the working directory.'
          : 'via the most recent workspace state file (working directory matched nothing; verify this is the instance you intend).';
    logger.info(
      `No FORGEJO_MCP_INSTANCE_URL configured; auto-matched instance ${redactInstanceUrl(url)} ${viaMessage}`,
    );
    if (auto.note) {
      logger.info(auto.note);
    }
  }
  // The token is optional: without it the tools read anonymously, which is
  // enough for public repositories. This matters for configs the Agent Host
  // reads natively (workspace `.mcp.json`, `~/.copilot/mcp-config.json`),
  // where a plaintext token would be at rest in a shareable file.
  const token = process.env.FORGEJO_MCP_TOKEN || '';
  if (!token) {
    logger.info('FORGEJO_MCP_TOKEN is not set; reading anonymously (only public data is visible).');
  }

  const syncApiUrls = process.env.FORGEJO_MCP_SYNC_API_URLS === 'false' ? false : undefined;
  // The MCP process reads the environment only: there is no editor setting here,
  // except for the proxy, which the extension forwards as FORGEJO_MCP_PROXY
  // because a proxy configured only in settings would otherwise be ignored by
  // the tools while the extension's own requests use it.
  const proxyDispatcher = createProxyDispatcher(resolveProxyUrl(process.env, process.env.FORGEJO_MCP_PROXY));
  setDefaultRequestDispatcher(proxyDispatcher, proxyDispatcher ? getProxyFetch() : undefined);
  const client = new ForgejoClient(url, token, logger, syncApiUrls);
  const server = createMcpServer(client, {
    instanceUrl: url,
    // The configured instance's id, matched against state-file entries before
    // the URL so two accounts on the same host stay apart. Absent when the
    // host that spawned this process predates the variable; the resolver then
    // falls back to the URL comparison.
    instanceId: process.env.FORGEJO_MCP_INSTANCE_ID,
    // The extension host's workspace → repository mapping, for the
    // get_workspace_repository tool. Optional: absent when the server is
    // launched without it, the tool stays registered and answers
    // "not configured" instead of failing. A zero-configuration launch fills
    // this with the newest discovered state file (see the auto-match above).
    stateFile,
  });
  // The extension host probes the server version on activation and caches it per
  // instance URL, but this process has its own module state and never runs
  // activation — without a probe here the Actions version gate
  // (`assertActionsSupported`) would always see "unknown" and pass, making the
  // gate dead code on the MCP side. The probe runs in the background: the server
  // starts serving immediately, and the gate fails open until the version is
  // known, which is exactly how it behaves in the editor.
  void probeServerVersion(url, token, logger, syncApiUrls);
  await server.connect(new StdioServerTransport());
  // The configured URL may embed credentials; only the redacted form is logged.
  logger.info(`MCP server ready for ${redactInstanceUrl(url)}`);
}

main().catch((error: unknown) => {
  console.error(`forgejo-toolkit MCP server failed: ${userFacingErrorMessage(error)}`);
  process.exit(1);
});
