import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ForgejoClient, type ClientLogger } from '../src/api/client';
import { userFacingErrorMessage } from '../src/api/errors-core';
import { probeServerVersion, redactInstanceUrl } from '../src/api/versionProbe';
import { versionCacheKey } from '../src/api/serverVersionCache';
import { setDefaultRequestDispatcher } from '../src/api/client';
import { createProxyDispatcher, getProxyFetch, resolveProxyUrl } from '../src/api/proxy';
import { createMcpServer } from './mcpServer';
import { discoverBrokerRegistration, registerDeclaredServerVersions, resolveAutoConfiguration } from './autoConfig';
import { BrokerSessionError, BrokerUnavailableError, forwardToBroker } from './brokerForwarder';
import { MCP_ENV_WRITE_TOOLS, sessionWriteToolsFromEnvironment } from './writeTools';

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
  // `true` for a launch the extension itself provided (see
  // src/mcpServerProvider.ts): the definition carries no token — the token
  // stays in the extension host's SecretStorage — so this process may only
  // serve by forwarding to the host's broker. Falling back to a direct server
  // would answer anonymously while the MCP client believes it reached the
  // configured instance, which is the one outcome this flag forbids.
  const brokerOnly = process.env.FORGEJO_MCP_BROKER_ONLY === 'true';
  const syncApiUrls = process.env.FORGEJO_MCP_SYNC_API_URLS === 'false' ? false : undefined;
  // The write tools the extension host switched on for this definition, parsed
  // from the launch environment. This process never acts on them: the tool
  // logic that could write runs in the extension host's broker, which computes
  // its own answer from the host's settings and deliberately does not trust
  // this variable (see mcp/writeTools.ts). Parsing it here is still worth the
  // three lines — it is the one place a malformed name would be visible, and
  // the tool set stays empty below, which is what makes every session this
  // process ever serves a read-only one.
  const advertisedWriteTools = sessionWriteToolsFromEnvironment(process.env.FORGEJO_MCP_WRITE_TOOLS);
  if (process.env.FORGEJO_MCP_WRITE_TOOLS && advertisedWriteTools.length === 0) {
    logger.info(`${MCP_ENV_WRITE_TOOLS} carries no write tool this build knows; this session serves read-only.`);
  }
  // Forwarding is not tied to *how* the launch was configured, because the
  // reason to prefer the broker is the same in both: the extension host holds
  // the token, and the broker runs the real tool logic with it. A static
  // `.mcp.json` launch reaches this without the flag (the extension did not
  // provide its definition) and keeps the documented degradation below.
  const registration = await discoverBrokerRegistration();
  if (registration) {
    try {
      logger.info(
        brokerOnly
          ? `Forwarding to the extension-host broker at ${registration.endpoint} (this launch carries no token of its own).`
          : `No instance credentials in the launch environment (expected for a static mcp.json); forwarding to the extension-host broker at ${registration.endpoint}.`,
      );
      const result = await forwardToBroker({
        endpoint: registration.endpoint,
        authToken: registration.authToken,
        cwd: process.cwd(),
        // The forwarded session belongs to the instance *this* definition was
        // created for; without it the broker would re-derive the instance from
        // the session's working directory and a client with several Forgejo
        // servers could reach another one's account.
        instanceId: process.env.FORGEJO_MCP_INSTANCE_ID,
        // The workspace mapping the extension host computed for its own window;
        // the broker cannot see it, and `get_workspace_repository` would
        // otherwise answer from whichever window owns the broker.
        stateFile,
        syncApiUrls,
      });
      logger.info(
        result.reason === 'input-ended'
          ? 'The MCP client closed its stdin; forwarding session over.'
          : 'The extension-host broker closed the connection (the window was closed or the extension deactivated); MCP session over.',
      );
      // No process.exit(): it would truncate stdout writes still buffered
      // in Node (the broker's last frames can be in flight when the socket
      // closes). Setting the exit code and releasing stdin lets the event
      // loop drain — pending pipe writes keep it alive until flushed — and
      // the process then exits on its own.
      process.stdin.destroy();
      return;
    } catch (error) {
      if (error instanceof BrokerSessionError) {
        // The session was already established when it broke; restarting as
        // a different (anonymous) server mid-session would be worse than a
        // clean stop the MCP client can report.
        console.error(`forgejo-toolkit MCP forwarder: ${error.message}`);
        process.exitCode = 1;
        process.stdin.destroy();
        return;
      }
      if (!(error instanceof BrokerUnavailableError)) {
        throw error;
      }
      // No broker after all (stale registration file, rejected handshake) — or
      // a broker that refused the session: the instance this definition names
      // is no longer configured or has lost its token, and silently serving a
      // different instance's account is not an option.
      if (process.env.FORGEJO_MCP_INSTANCE_ID) {
        console.error(
          `forgejo-toolkit MCP server: the extension host did not accept the session for instance ` +
            `"${process.env.FORGEJO_MCP_INSTANCE_ID}" (${error.message}); it is no longer configured with a usable token. ` +
            `Pick it again in the extension, or use the static mcp.json route, which reads anonymously when no window is running.`,
        );
        process.exitCode = 1;
        process.stdin.destroy();
        return;
      }
      logger.info(`Extension-host broker unavailable (${error.message}); falling back to local auto-matching.`);
    }
  }
  if (brokerOnly) {
    // Only reachable without a registration at all: the broker disappeared
    // between this process starting and its discovery.
    console.error(
      'forgejo-toolkit MCP server: this MCP server was provided by the Forgejo Toolkit extension, which keeps the access token in VS Code SecretStorage, ' +
        'so it can only serve through the extension host — and no extension-host broker is running. ' +
        'Reload a VS Code window with the extension enabled, or use the static mcp.json route (the shim), which reads anonymously when no window is running.',
    );
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  if (!url) {
    // Zero-configuration launch: a static workspace `.mcp.json` can carry only
    // command + args, so a server started that way has no instance URL in its
    // environment and discovers it instead — from the extension's published
    // instance registry plus this working directory's workspace state or git
    // remotes (see mcp/autoConfig.ts).
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
      `No instance credentials in the launch environment; auto-matched instance ${redactInstanceUrl(url)} ${viaMessage}`,
    );
    if (auto.note) {
      logger.info(auto.note);
    }
  }
  // The no-broker route's declaration channel, installed before the client is
  // built: this process has no instance record, so the declared server version
  // the user set for the instance can only reach it through the registry the
  // extension host publishes (`registerDeclaredServerVersions` reads it). It is
  // the same hook `ConfigManager` installs in the extension host, so the
  // resolution here is that one order — **declared → probed → unknown**, with
  // the same source reporting — rather than a second implementation of it, and
  // the Actions gate below follows it. A registry with no declaration for this
  // instance (or none at all) leaves every lookup `undefined`: the probe
  // answers exactly as it did before the declaration existed.
  const declaredServerVersions = await registerDeclaredServerVersions();
  const declaredForThisInstance = declaredServerVersions.get(versionCacheKey(url));
  if (declaredForThisInstance !== undefined) {
    logger.info(
      `Server version for ${redactInstanceUrl(url)}: ${declaredForThisInstance} (declared for this instance; using it and not probing).`,
    );
  }
  // The token is optional: without it the tools read anonymously, which is
  // enough for public repositories. This matters for configs the Agent Host
  // reads natively (workspace `.mcp.json`, `~/.copilot/mcp-config.json`),
  // where a plaintext token would be at rest in a shareable file. The
  // extension-provided route never reaches this point with a token at all —
  // it is the broker's job to authenticate (see the flag above), and a
  // credential in a definition VS Code persists would be a token on disk.
  const token = process.env.FORGEJO_MCP_TOKEN || '';
  if (!token) {
    logger.info('FORGEJO_MCP_TOKEN is not set; reading anonymously (only public data is visible).');
  }

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
    // Deliberately empty, whatever the launch environment advertised (see
    // `advertisedWriteTools` above): this process has no route to a write —
    // it either forwards to the host's broker, which decides for itself, or it
    // is a direct server with either no token or a token from someone's own
    // configuration file. Both of those may read and never write, so no write
    // tool it serves is ever allowed, and the refusal names the setting.
    writeTools: [],
  });
  // The extension host probes the server version on activation and caches it per
  // instance URL, but this process has its own module state and never runs
  // activation — without a probe here the Actions version gate
  // (`assertActionsSupported`) would always see "unknown" and pass, making the
  // gate dead code on the MCP side. The probe runs in the background: the server
  // starts serving immediately, and the gate fails open until the version is
  // known, which is exactly how it behaves in the editor. An instance the
  // registry declares (above) short-circuits it — the same "a declared instance
  // is not probed" rule the host follows, which is the whole point when the
  // endpoint is blocked.
  void probeServerVersion(url, token, logger, syncApiUrls);
  await server.connect(new StdioServerTransport());
  // The configured URL may embed credentials; only the redacted form is logged.
  logger.info(`MCP server ready for ${redactInstanceUrl(url)}`);
}

main().catch((error: unknown) => {
  console.error(`forgejo-toolkit MCP server failed: ${userFacingErrorMessage(error)}`);
  process.exit(1);
});
