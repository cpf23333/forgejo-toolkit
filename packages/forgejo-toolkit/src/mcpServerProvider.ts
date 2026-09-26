import * as vscode from 'vscode';
import type { ConfigManager, ForgejoInstance } from './config';
import { redactUrlUserinfo } from './utils/redactUrlUserinfo';
import {
  cleanupMcpWorkspaceState,
  mcpWorkspaceStateFilePath,
  registerMcpWorkspaceStateSync,
} from './mcpWorkspaceState';
import { cleanupMcpBroker, startMcpBrokerIfFirst } from './mcpBroker';
import type { Logger } from './logger';

/** Contribution id; must match contributes.mcpServerDefinitionProviders in package.json. */
export const MCP_SERVER_DEFINITION_PROVIDER_ID = 'forgejo-toolkit.instances';

/** The settings section every key of this extension lives under. */
const MCP_SETTINGS_SECTION = 'forgejoToolkit';

/** The key without its section, for the `getConfiguration` read. */
const MCP_ENABLED_KEY = 'mcpEnabled';

/**
 * The setting that owns this whole surface, fully qualified for
 * `affectsConfiguration`. Default on; off means "do not expose the MCP server
 * to clients" (see isMcpServerEnabled).
 */
export const MCP_ENABLED_SETTING = `${MCP_SETTINGS_SECTION}.mcpEnabled`;

export const MCP_ENV_INSTANCE_URL = 'FORGEJO_MCP_INSTANCE_URL';
export const MCP_ENV_TOKEN = 'FORGEJO_MCP_TOKEN';
/**
 * The configured instance's id. The child matches state-file entries against
 * it before falling back to the URL, so two accounts on the same host (two
 * instances, one URL) do not both claim the same workspace repositories.
 */
export const MCP_ENV_INSTANCE_ID = 'FORGEJO_MCP_INSTANCE_ID';
/** 'false' disables rewriting API-provided URLs to the configured instance URL. */
export const MCP_ENV_SYNC_API_URLS = 'FORGEJO_MCP_SYNC_API_URLS';
/** The editor's `http.proxy`, forwarded so the child uses the same proxy. */
export const MCP_ENV_PROXY = 'FORGEJO_MCP_PROXY';
/**
 * This window's workspace → repository state file (see mcpWorkspaceState.ts),
 * shared by every server definition of the window: the mapping describes the
 * workspace, not the instance.
 */
export const MCP_ENV_STATE_FILE = 'FORGEJO_MCP_STATE_FILE';

/**
 * Whether the MCP surface may be exposed at all.
 *
 * Read as `unknown` rather than `get<boolean>`: a hand-edited settings.json can
 * hold any JSON type under the key, and anything but an explicit `false` keeps
 * the default (on) instead of throwing inside activation (same contract as the
 * `http.proxy` read below).
 */
export function isMcpServerEnabled(): boolean {
  const raw: unknown = vscode.workspace.getConfiguration(MCP_SETTINGS_SECTION).get(MCP_ENABLED_KEY);
  return raw !== false;
}

/**
 * Exposes every configured Forgejo instance that has a stored access token to
 * VS Code agent mode as a stdio MCP server (out/mcp-server.mjs) — one
 * definition per instance, so an agent can reach several instances in the
 * same session. Each instance's URL and token reach its child process
 * exclusively through environment variables — never through tool schemas,
 * results, or log output. Every child also receives this window's workspace
 * state file (see mcpWorkspaceState.ts), which lets the
 * `get_workspace_repository` tool resolve "this repository" against the
 * window's actual workspace.
 *
 * When the instance list changes — or the editor's `http.proxy` changes, since
 * that setting is read here and forwarded to the child — the provider fires
 * onDidChangeMcpServerDefinitions so VS Code re-resolves.
 *
 * The whole surface follows `forgejoToolkit.mcpEnabled`, and follows it live:
 * the setting is re-read on every configuration change, so turning it off in a
 * running window withdraws the registration instead of leaving a stale one
 * behind. What "off" covers, and why:
 *
 * - No definition provider is registered, so VS Code has no server to hand to a
 *   client. New agent sessions see no Forgejo MCP server.
 * - The workspace-state sync, the instance registry and the stable-path shim
 *   are not started (and are stopped again when the setting goes off while
 *   running). The registry and the shim are exactly what a *statically*
 *   configured client — a third-party agent's `.mcp.json` pointed at the shim —
 *   launches and discovers instances through, so keeping them fresh while the
 *   user asked for no MCP surface would leave the back door open. Skipping the
 *   work also avoids a git scan per editor switch for a feature that is off.
 * - The local broker is stopped (it is what forwards a statically launched
 *   process into this host to run the tools *with the token*), and this
 *   window's own state file is removed.
 * - The registry and shim files themselves are the one thing deliberately left
 *   on disk: they are per-installation/per-extension and shared with every
 *   other window, one of which may still have the setting on, so deleting them
 *   here would break that window. They are simply no longer maintained.
 *
 * An MCP client that is *already connected* keeps the server process it spawned
 * until the window is reloaded: the extension never owned that process (VS Code
 * spawned it), so no window reload is needed for the setting to take effect,
 * but an existing session is not torn down either. The setting's description
 * and the README say so.
 */
export function registerMcpServerProvider(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
): void {
  const onDidChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(onDidChange);

  /**
   * Everything the enabled state owns, or undefined while the setting is off.
   * Kept in one handle so a toggle disposes exactly what the previous enable
   * started — including the subscriptions another module pushed into the
   * context it was given.
   */
  let surface: vscode.Disposable | undefined;

  const applySetting = (): void => {
    if (isMcpServerEnabled()) {
      if (!surface) {
        surface = startMcpSurface(context, config, logger, onDidChange);
      }
      return;
    }
    if (!surface) {
      // Deliberately debug level: a user who turned the setting off does not
      // need a line about it on every window start, but the "why is there no
      // Forgejo MCP server?" question is answerable from the log.
      logger.debug('forgejoToolkit.mcpEnabled is off; the MCP server surface is not started.');
      return;
    }
    surface.dispose();
    surface = undefined;
    logger.info('forgejoToolkit.mcpEnabled was turned off; the MCP server definitions were withdrawn.');
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Re-read, not cached: turning the surface off (or back on) in a running
      // window must not need a reload.
      if (event.affectsConfiguration(MCP_ENABLED_SETTING)) {
        applySetting();
        // Nothing left to re-resolve either way: disabling withdrew the
        // definitions, and enabling resolved them from scratch.
        return;
      }
      // The proxy is read in provideMcpServerDefinitions, i.e. once per
      // resolution, so the value captured when the child was spawned would
      // otherwise stay stale for the session. The extension host re-installs
      // its dispatcher on this change; re-resolving the definition is what
      // gives the MCP child the same treatment.
      if (event.affectsConfiguration('http.proxy')) {
        onDidChange.fire();
      }
    }),
    // Disposing the subscriptions above does not dispose the surface they
    // started; this is what stops the broker and the state file when the
    // window goes away while the setting is on.
    { dispose: () => surface?.dispose() },
  );

  applySetting();
}

/**
 * Starts everything the MCP surface consists of and returns the one handle
 * that takes it down again.
 *
 * The workspace-state sync registers four listeners on the context it is given
 * and keeps them for the process lifetime, which is right for activation and
 * wrong for a runtime toggle. It therefore runs against a per-surface child
 * context whose `subscriptions` array belongs to this call (everything else —
 * the storage and install URIs — is inherited), so disposing the returned
 * handle unregisters them along with the provider.
 */
function startMcpSurface(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
  onDidChange: vscode.EventEmitter<void>,
): vscode.Disposable {
  const owned: vscode.Disposable[] = [config.onInstancesChanged(() => onDidChange.fire())];
  const surfaceContext: vscode.ExtensionContext = Object.create(context);
  // `subscriptions` is readonly in the API declaration, and in the REAL context
  // it is a getter-only accessor, so a plain assignment through the prototype
  // chain throws in strict mode (ESM always is) — that failure took the whole
  // activation down, because it happens before the state sync and the broker are
  // registered. `defineProperty` installs an own, writable data property that
  // shadows the inherited accessor instead of going through it.
  Object.defineProperty(surfaceContext, 'subscriptions', {
    value: owned,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  // The state file's own listeners and its cold-start write; registered here
  // because the MCP feature is its only consumer. Deliberately before the
  // capability check below: the static-config path (a third-party agent's
  // .mcp.json pointed at the shim) consumes the state files too and works on
  // editors that have no MCP definition API at all.
  registerMcpWorkspaceStateSync(surfaceContext, config, logger);
  // The local broker that lets a statically launched (tokenless) MCP server
  // forward into this host. Started with the surface, stopped with it: while
  // it runs, a static client gets authenticated tools out of this process.
  // Never throws — a broker failure only means the anonymous
  // zero-configuration fallback stays in effect.
  void startMcpBrokerIfFirst(context, config, logger);

  // VS Code forks are not required to implement every API: an editor without
  // `vscode.lm.registerMcpServerDefinitionProvider` must not lose the whole
  // extension to a failed activation over this one optional surface. Only the
  // registration is skipped; everything above still runs.
  const register = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof register === 'function') {
    owned.push(
      register.call(
        vscode.lm,
        MCP_SERVER_DEFINITION_PROVIDER_ID,
        createInstanceDefinitionProvider(context, config, logger, onDidChange),
      ),
    );
  } else {
    logger.info(
      'This editor provides no MCP server definition API; skipping MCP server registration (the static-config MCP path still works).',
    );
  }

  return {
    dispose: () => {
      for (const subscription of owned.splice(0)) {
        subscription.dispose();
      }
      // Best-effort and swallowed inside both: leaving a stale state file or
      // broker registration behind would only mislead a statically launched
      // client, never break the extension.
      void cleanupMcpWorkspaceState(logger);
      void cleanupMcpBroker(logger);
    },
  };
}

/** The provider VS Code asks for server definitions; one `provide` per resolution. */
function createInstanceDefinitionProvider(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
  onDidChange: vscode.EventEmitter<void>,
): vscode.McpServerDefinitionProvider {
  return {
    onDidChangeMcpServerDefinitions: onDidChange.event,
    provideMcpServerDefinitions: () => {
      const instances = config.getInstances();
      const serverPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.mjs').fsPath;
      const stateFilePath = mcpWorkspaceStateFilePath(context);
      // The editor's proxy setting is not in the child's environment either;
      // without it, MCP requests would connect directly while the extension's
      // own requests go through the proxy. Environment proxies still work in the
      // child (it inherits this process's environment), so this only carries the
      // setting. Read once per resolution and shared by every definition.
      // Read as unknown: a hand-edited settings.json can hold any JSON type for
      // `http.proxy`, and a non-string must be ignored rather than throw here —
      // a throw would fail the whole resolution and take every server
      // definition down with it (same contract as src/api/proxy.ts).
      const rawProxy: unknown = vscode.workspace.getConfiguration('http').get('proxy');
      const configuredProxy = typeof rawProxy === 'string' && rawProxy.trim() ? rawProxy.trim() : undefined;
      const prepared: { instance: ForgejoInstance; env: Record<string, string>; baseLabel: string }[] = [];
      for (const instance of instances) {
        // An instance without a stored token cannot authenticate its child;
        // it is skipped (and reported) rather than hiding the usable ones.
        if (!instance.token) {
          logger.debug(
            `MCP server definition skipped: instance ${instance.name || redactUrlUserinfo(instance.url)} has no stored token.`,
          );
          continue;
        }
        const env: Record<string, string> = {
          [MCP_ENV_INSTANCE_URL]: instance.url,
          [MCP_ENV_TOKEN]: instance.token,
          [MCP_ENV_INSTANCE_ID]: instance.id,
          // The headless process cannot read the extension's settings, so the
          // per-instance URL-sync flag travels with the launch environment:
          // otherwise a user who disabled syncing (reverse proxy, split
          // hostnames) would get rewritten links from the tools.
          [MCP_ENV_SYNC_API_URLS]: String(instance.syncApiUrlsToInstanceUrl ?? true),
          [MCP_ENV_STATE_FILE]: stateFilePath,
        };
        if (configuredProxy) {
          env[MCP_ENV_PROXY] = configuredProxy;
        }
        // The label is user-visible (the MCP server list), so the stored URL's
        // userinfo never reaches it. The launch environment above keeps the real
        // value, which the headless server needs to authenticate.
        const baseLabel = instance.name ? `Forgejo: ${instance.name}` : `Forgejo: ${redactUrlUserinfo(instance.url)}`;
        prepared.push({ instance, env, baseLabel });
      }
      // Two instances can legitimately produce the same base label (same name,
      // or two accounts on one host). Identical labels would be
      // indistinguishable in the MCP server list, so the colliding ones — only
      // those — get a stable discriminator appended.
      const labelCounts = new Map<string, number>();
      for (const entry of prepared) {
        labelCounts.set(entry.baseLabel, (labelCounts.get(entry.baseLabel) ?? 0) + 1);
      }
      const definitions: vscode.McpServerDefinition[] = [];
      for (const entry of prepared) {
        const label =
          (labelCounts.get(entry.baseLabel) ?? 0) > 1
            ? `${entry.baseLabel} (${entry.instance.username || entry.instance.id})`
            : entry.baseLabel;
        definitions.push(new vscode.McpStdioServerDefinition(label, process.execPath, [serverPath], entry.env));
      }
      return definitions;
    },
  };
}
