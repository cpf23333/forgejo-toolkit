import * as vscode from 'vscode';
import type { ConfigManager } from './config';
import type { Logger } from './logger';

/** Contribution id; must match contributes.mcpServerDefinitionProviders in package.json. */
export const MCP_SERVER_DEFINITION_PROVIDER_ID = 'forgejo-toolkit.instances';

export const MCP_ENV_INSTANCE_URL = 'FORGEJO_MCP_INSTANCE_URL';
export const MCP_ENV_TOKEN = 'FORGEJO_MCP_TOKEN';
/** 'false' disables rewriting API-provided URLs to the configured instance URL. */
export const MCP_ENV_SYNC_API_URLS = 'FORGEJO_MCP_SYNC_API_URLS';
/** The editor's `http.proxy`, forwarded so the child uses the same proxy. */
export const MCP_ENV_PROXY = 'FORGEJO_MCP_PROXY';

/**
 * Exposes the first configured Forgejo instance that has a stored access token
 * to VS Code agent mode as a stdio MCP server (out/mcp-server.js). The instance
 * URL and token reach the child process exclusively through environment
 * variables — never through tool schemas, results, or log output. When the
 * instance list changes — or the editor's `http.proxy` changes, since that
 * setting is read here and forwarded to the child — the provider fires
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

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: onDidChange.event,
    provideMcpServerDefinitions: () => {
      // The first instance that can actually be used, not simply the first one:
      // an instance without a stored token would otherwise hide a later,
      // configured one and leave the tools unregistered entirely.
      const instances = config.getInstances();
      const instance = instances.find((candidate) => candidate.token);
      if (!instance) {
        const first = instances[0];
        if (first) {
          logger.debug(`MCP server definitions skipped: instance ${first.name} has no stored token.`);
        }
        return [];
      }
      const serverPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath;
      const env: Record<string, string> = {
        [MCP_ENV_INSTANCE_URL]: instance.url,
        [MCP_ENV_TOKEN]: instance.token,
        // The headless process cannot read the extension's settings, so the
        // per-instance URL-sync flag travels with the launch environment:
        // otherwise a user who disabled syncing (reverse proxy, split
        // hostnames) would get rewritten links from the tools.
        [MCP_ENV_SYNC_API_URLS]: String(instance.syncApiUrlsToInstanceUrl ?? true),
      };
      // The editor's proxy setting is not in the child's environment either;
      // without it, MCP requests would connect directly while the extension's
      // own requests go through the proxy. Environment proxies still work in the
      // child (it inherits this process's environment), so this only carries the
      // setting.
      const configuredProxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
      if (typeof configuredProxy === 'string' && configuredProxy.trim()) {
        env[MCP_ENV_PROXY] = configuredProxy.trim();
      }
      const label = instance.name ? `Forgejo: ${instance.name}` : `Forgejo: ${instance.url}`;
      return [new vscode.McpStdioServerDefinition(label, process.execPath, [serverPath], env)];
    },
  };

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(MCP_SERVER_DEFINITION_PROVIDER_ID, provider),
  );
}
