import * as vscode from 'vscode';
import type { ConfigManager } from './config';
import type { Logger } from './logger';

/** Contribution id; must match contributes.mcpServerDefinitionProviders in package.json. */
export const MCP_SERVER_DEFINITION_PROVIDER_ID = 'forgejo-toolkit.instances';

export const MCP_ENV_INSTANCE_URL = 'FORGEJO_MCP_INSTANCE_URL';
export const MCP_ENV_TOKEN = 'FORGEJO_MCP_TOKEN';

/**
 * Exposes the first configured Forgejo instance to VS Code agent mode as a
 * stdio MCP server (out/mcp-server.js). The instance URL and token reach the
 * child process exclusively through environment variables — never through
 * tool schemas, results, or log output. When the instance list changes, the
 * provider fires onDidChangeMcpServerDefinitions so VS Code re-resolves.
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
  );

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: onDidChange.event,
    provideMcpServerDefinitions: () => {
      const instance = config.getInstances()[0];
      if (!instance) {
        return [];
      }
      if (!instance.token) {
        logger.debug(`MCP server definitions skipped: instance ${instance.name} has no stored token.`);
        return [];
      }
      const serverPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath;
      const env: Record<string, string> = {
        [MCP_ENV_INSTANCE_URL]: instance.url,
        [MCP_ENV_TOKEN]: instance.token,
      };
      const label = instance.name ? `Forgejo: ${instance.name}` : `Forgejo: ${instance.url}`;
      return [new vscode.McpStdioServerDefinition(label, process.execPath, [serverPath], env)];
    },
  };

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(MCP_SERVER_DEFINITION_PROVIDER_ID, provider),
  );
}
