import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Logger } from '../logger';
import { mcpServerShimFilePath, writeMcpServerShim } from '../mcpWorkspaceState';
import { writeFileAtomically } from '../utils/atomicWrite';

/**
 * The `forgejoToolkit.copyAgentsWindowMcpConfig` command: builds the static
 * MCP configuration snippet that lets the Agents window (or any static MCP
 * host) launch the bundled server through the upgrade-stable shim, and
 * offers to write it to the user-level `mcp.json`, to the workspace's
 * `.vscode/mcp.json`, or copy it to the clipboard.
 *
 * Why these two write targets and not a root `.mcp.json`: VS Code itself
 * reads the user-level `<profile>/User/mcp.json` (its MCP registry, applied
 * to every workspace and forwarded to Agent Host sessions) and the
 * workspace-scoped `.vscode/mcp.json` (forwarded the same way). A `.mcp.json`
 * at the workspace root is read natively by the Agent Host only — VS Code
 * ignores it ("Cannot start unknown MCP server customization"), and sessions
 * running with worktree isolation never see it at all, because the session
 * workspace is the isolated worktree, not the user's checkout.
 */

/**
 * The shape of a static MCP host configuration (`mcp.json`): a `servers`
 * map whose entries name the command to spawn. Only the `forgejo` entry is
 * built here; merging preserves any other servers.
 */
export interface AgentsWindowMcpConfig {
  servers: { forgejo: { command: string; args: string[] } };
}

/**
 * Builds the snippet pointing at the shim (`mcp-server.js` in the
 * extension's globalStorage) rather than the versioned install directory,
 * so the configuration survives extension upgrades. No `env` block: the
 * server discovers the instance registry on its own (mcp/autoConfig.ts) and,
 * while an extension window is running, authenticates by forwarding into that
 * host's broker; with no broker live it reads anonymously (public data only).
 */
export function buildAgentsWindowMcpConfig(shimPath: string): AgentsWindowMcpConfig {
  return { servers: { forgejo: { command: 'node', args: [shimPath] } } };
}

/**
 * The user-level MCP registry of the VS Code profile this extension host
 * belongs to.
 *
 * Derived from `globalStorageUri`, which is `<profile>/User/globalStorage/
 * <publisher>.<name>`: two levels up is the profile's `User` directory,
 * whose `mcp.json` VS Code reads. A profile install resolves to its own
 * profile's `mcp.json` the same way — which is exactly right, because MCP
 * configuration is per-profile in VS Code.
 */
export function userMcpJsonPath(context: vscode.ExtensionContext): string {
  return vscode.Uri.joinPath(context.globalStorageUri, '..', '..', 'mcp.json').fsPath;
}

/**
 * The base a missing file starts from. The user-level registry gets an
 * `inputs` array because that is the shape VS Code writes there itself; the
 * workspace file needs no such scaffold.
 */
const USER_MCP_JSON_EMPTY_BASE: Record<string, unknown> = { servers: {}, inputs: [] };

/**
 * Reads `mcpJsonPath` (missing file: treated as `emptyBase`), overrides its
 * `servers.forgejo` entry with `config`'s while preserving every other
 * server and top-level key, and writes the result back atomically.
 *
 * A file that does not parse — or parses to a non-object — is an error and
 * is left byte-for-byte untouched: overwriting a hand-maintained
 * configuration the user broke mid-edit would destroy it.
 */
export async function mergeMcpConfigIntoFile(
  mcpJsonPath: string,
  config: AgentsWindowMcpConfig,
  emptyBase: Record<string, unknown> = {},
): Promise<void> {
  let existing: Record<string, unknown> = emptyBase;
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
      throw new Error(vscode.l10n.t('The existing mcp.json is not valid JSON'));
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(vscode.l10n.t('The existing mcp.json must contain a JSON object'));
    }
    existing = parsed as Record<string, unknown>;
  }
  const existingServers =
    typeof existing.servers === 'object' && existing.servers !== null && !Array.isArray(existing.servers)
      ? (existing.servers as Record<string, unknown>)
      : {};
  const merged = { ...existing, servers: { ...existingServers, forgejo: config.servers.forgejo } };
  // The workspace target lives in `.vscode/`, which the workspace may not
  // have yet; the user-level target's directory always exists, so this is
  // a no-op there.
  await fs.promises.mkdir(path.dirname(mcpJsonPath), { recursive: true });
  await writeFileAtomically(mcpJsonPath, `${JSON.stringify(merged, null, 2)}\n`);
}

/**
 * Confirms the write with an advisory modal, then merges the snippet into
 * `targetPath`. The advisory is shown before every write — not only the
 * first — because both targets outlive the moment of writing: the user
 * file applies to every workspace of the profile from then on, and the
 * workspace file may get committed and shared later.
 *
 * Returns true when the file was written.
 */
async function confirmAndWrite(
  targetPath: string,
  config: AgentsWindowMcpConfig,
  emptyBase: Record<string, unknown>,
  advisory: string,
): Promise<boolean> {
  const confirmWrite = vscode.l10n.t('Write mcp.json');
  const confirmed = await vscode.window.showWarningMessage(advisory, { modal: true }, confirmWrite);
  if (confirmed !== confirmWrite) {
    return false;
  }
  try {
    await mergeMcpConfigIntoFile(targetPath, config, emptyBase);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Failed to write {0} (the existing file was left unchanged): {1}', targetPath, message),
    );
    return false;
  }
  void vscode.window.showInformationMessage(vscode.l10n.t('MCP configuration written to {0}', targetPath));
  return true;
}

export async function copyAgentsWindowMcpConfig(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  // The snippet references the shim, so make sure it exists and points at
  // the current installation even if the activation write failed (or this
  // runs before it settled). The write is content-compared, so an
  // up-to-date shim costs nothing.
  await writeMcpServerShim(context, logger);
  const shimPath = mcpServerShimFilePath(context);
  const config = buildAgentsWindowMcpConfig(shimPath);

  const writeUserAction = vscode.l10n.t('Write to User mcp.json (Recommended)');
  const writeWorkspaceAction = vscode.l10n.t('Write to Workspace .vscode/mcp.json');
  const copyAction = vscode.l10n.t('Copy to Clipboard');
  // Recommended first: the user-level registry applies everywhere and is
  // what VS Code forwards to Agent Host sessions. The workspace file needs
  // a workspace folder to live in; without one it is not offered.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const actions = workspaceFolder ? [writeUserAction, writeWorkspaceAction, copyAction] : [writeUserAction, copyAction];
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
  if (picked === writeUserAction) {
    // The file carries no credentials, but the absolute shim path inside is
    // machine-specific — and this target applies to every workspace of the
    // profile, which the user should sign off on explicitly.
    await confirmAndWrite(
      userMcpJsonPath(context),
      config,
      USER_MCP_JSON_EMPTY_BASE,
      vscode.l10n.t(
        'This writes to the user mcp.json of this VS Code profile: the server becomes available in every workspace of the profile. The file contains no secrets, but it references a machine-specific path.',
      ),
    );
    return;
  }
  if (picked === writeWorkspaceAction && workspaceFolder) {
    // A workspace file travels with the repository: no secrets inside, but
    // the machine-specific path would break for anyone else the file is
    // shared with, so committing it is not recommended.
    await confirmAndWrite(
      path.join(workspaceFolder.uri.fsPath, '.vscode', 'mcp.json'),
      config,
      {},
      vscode.l10n.t(
        'The workspace mcp.json contains no secrets, but it references a machine-specific path, and a workspace file is easily committed — sharing it via git is not recommended.',
      ),
    );
  }
}
