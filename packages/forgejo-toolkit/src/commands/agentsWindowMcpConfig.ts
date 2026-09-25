import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Logger } from '../logger';
import { mcpServerShimFilePath, writeMcpServerShim } from '../mcpWorkspaceState';
import { writeFileAtomically } from '../utils/atomicWrite';

/**
 * The `forgejoToolkit.copyAgentsWindowMcpConfig` command: builds the static
 * `.mcp.json` snippet that lets the Agents window (or any static MCP host)
 * launch the bundled server through the upgrade-stable shim, and offers to
 * copy it to the clipboard or merge it into the workspace's `.mcp.json`.
 */

/**
 * The shape of a static MCP host configuration (`mcp.json` / `.mcp.json`):
 * a `servers` map whose entries name the command to spawn. Only the
 * `forgejo` entry is built here; merging preserves any other servers.
 */
export interface AgentsWindowMcpConfig {
  servers: { forgejo: { command: string; args: string[] } };
}

/**
 * Builds the snippet pointing at the shim (`mcp-server.js` in the
 * extension's globalStorage) rather than the versioned install directory,
 * so the configuration survives extension upgrades. No `env` block: the
 * server discovers the instance registry on its own (mcp/autoConfig.ts) and
 * reads anonymously without a `FORGEJO_MCP_TOKEN`.
 */
export function buildAgentsWindowMcpConfig(shimPath: string): AgentsWindowMcpConfig {
  return { servers: { forgejo: { command: 'node', args: [shimPath] } } };
}

/**
 * Reads `mcpJsonPath` (missing file: treated as empty), overrides its
 * `servers.forgejo` entry with `config`'s while preserving every other
 * server and top-level key, and writes the result back atomically.
 *
 * A file that does not parse — or parses to a non-object — is an error and
 * is left byte-for-byte untouched: overwriting a hand-maintained
 * configuration the user broke mid-edit would destroy it.
 */
export async function mergeMcpConfigIntoFile(mcpJsonPath: string, config: AgentsWindowMcpConfig): Promise<void> {
  let existing: Record<string, unknown> = {};
  const raw = await fs.promises.readFile(mcpJsonPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(vscode.l10n.t('The existing .mcp.json is not valid JSON'));
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(vscode.l10n.t('The existing .mcp.json must contain a JSON object'));
    }
    existing = parsed as Record<string, unknown>;
  }
  const existingServers =
    typeof existing.servers === 'object' && existing.servers !== null && !Array.isArray(existing.servers)
      ? (existing.servers as Record<string, unknown>)
      : {};
  const merged = { ...existing, servers: { ...existingServers, forgejo: config.servers.forgejo } };
  await writeFileAtomically(mcpJsonPath, `${JSON.stringify(merged, null, 2)}\n`);
}

export async function copyAgentsWindowMcpConfig(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  // The snippet references the shim, so make sure it exists and points at
  // the current installation even if the activation write failed (or this
  // runs before it settled). The write is content-compared, so an
  // up-to-date shim costs nothing.
  await writeMcpServerShim(context, logger);
  const shimPath = mcpServerShimFilePath(context);
  const config = buildAgentsWindowMcpConfig(shimPath);

  const copyAction = vscode.l10n.t('Copy to Clipboard');
  const writeAction = vscode.l10n.t('Write to Workspace .mcp.json');
  // Writing needs a workspace folder to put the file in; without one the
  // clipboard is the only destination, so the write action is not offered.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const actions = workspaceFolder ? [copyAction, writeAction] : [copyAction];
  const picked = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'MCP server configuration for the Agents window is ready. It references the stable shim the extension rewrites on every activation, so it survives extension upgrades.',
    ),
    ...actions,
  );

  if (picked === copyAction) {
    await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
    void vscode.window.showInformationMessage(vscode.l10n.t('MCP configuration copied to clipboard'));
    return;
  }
  if (picked !== writeAction || !workspaceFolder) {
    return;
  }

  // The file carries no credentials, but the absolute shim path inside is
  // machine-specific — the same reason the README advises against committing
  // a hand-written `.mcp.json`. The user confirms with that trade-off known.
  const confirmWrite = vscode.l10n.t('Write .mcp.json');
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'The generated .mcp.json contains no secrets, but it references a machine-specific path, so committing it to git is not recommended.',
    ),
    { modal: true },
    confirmWrite,
  );
  if (confirmed !== confirmWrite) {
    return;
  }

  const mcpJsonPath = path.join(workspaceFolder.uri.fsPath, '.mcp.json');
  try {
    await mergeMcpConfigIntoFile(mcpJsonPath, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Failed to write .mcp.json (the existing file was left unchanged): {0}', message),
    );
    return;
  }
  void vscode.window.showInformationMessage(vscode.l10n.t('MCP configuration written to {0}', mcpJsonPath));
}
