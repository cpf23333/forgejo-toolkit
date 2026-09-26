import * as vscode from 'vscode';
import type { ConfigManager, ForgejoInstance } from './config';
import { redactUrlUserinfo } from './utils/redactUrlUserinfo';
import { mcpWorkspaceStateFilePath, registerMcpWorkspaceStateSync } from './mcpWorkspaceState';
import type { Logger } from './logger';

/** Contribution id; must match contributes.mcpServerDefinitionProviders in package.json. */
export const MCP_SERVER_DEFINITION_PROVIDER_ID = 'forgejo-toolkit.instances';

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
 */
export function registerMcpServerProvider(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
): void {
  const onDidChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    onDidChange,
    config.onInstancesChanged(() => onDidChange.fire()),
    // The proxy is read in provideMcpServerDefinitions, i.e. once per
    // resolution, so the value captured when the child was spawned would
    // otherwise stay stale for the session. The extension host re-installs its
    // dispatcher on this change; re-resolving the definition is what gives the
    // MCP child the same treatment.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('http.proxy')) {
        onDidChange.fire();
      }
    }),
  );

  // The state file's own listeners and its cold-start write; registered here
  // because the MCP feature is its only consumer.
  registerMcpWorkspaceStateSync(context, config, logger);

  const provider: vscode.McpServerDefinitionProvider = {
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

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(MCP_SERVER_DEFINITION_PROVIDER_ID, provider),
  );
}
