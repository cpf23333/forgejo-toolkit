import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { McpWorkspaceStateFile } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import type { ConfigManager } from './config';
import type { Logger } from './logger';
import { detectLinkedRepositories, type DetectLinkedRepositoriesResult } from './worktree/gitOperations';
import { stripUrlUserinfo } from './utils/redactUrlUserinfo';
import { writeFileAtomically } from './utils/atomicWrite';

/**
 * Publishes the window's workspace → Forgejo repository mapping to the MCP
 * server processes this window spawns.
 *
 * The headless MCP child cannot ask the extension host which repository the
 * user is working in, so the host writes the answer to a file and hands the
 * path to the child through its launch environment
 * (`FORGEJO_MCP_STATE_FILE`, see mcpServerProvider.ts). The child re-reads the
 * file on every `get_workspace_repository` call, so a stale answer only lives
 * until the next write.
 */

/**
 * One state file per window (keyed by the extension host's pid): windows may
 * have different workspaces open, and a single shared file would have them
 * overwrite each other's mapping.
 */
export function mcpWorkspaceStateFilePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, `mcp-workspace-${process.pid}.json`);
}

/**
 * Builds the file content from the detection result.
 *
 * `instanceUrl` is re-resolved from the instance list (detection only carries
 * the instance id) and written with its userinfo *removed* — the MCP child
 * matches it against its own instance URL, so it needs the usable form, and
 * the file must never carry credentials either way. A repository whose
 * instance disappeared between detection and this mapping is dropped: the
 * child for that instance is gone with it.
 */
export function buildWorkspaceStatePayload(
  instances: ForgejoInstance[],
  detected: DetectLinkedRepositoriesResult,
): McpWorkspaceStateFile {
  const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
  return {
    updatedAt: new Date().toISOString(),
    repositories: detected.all.flatMap((repo) => {
      const instance = instancesById.get(repo.instanceId);
      if (!instance) {
        return [];
      }
      return [
        {
          instanceId: repo.instanceId,
          instanceUrl: stripUrlUserinfo(instance.url),
          owner: repo.owner,
          repo: repo.repo,
          localPath: repo.localPath,
          // Already the display-redacted value detection produced; kept as-is.
          remoteUrl: repo.remoteUrl,
          // `linked` is an element of `all` (attribution picks, never copies),
          // so identity marks the attributed repository.
          active: detected.linked === repo,
        },
      ];
    }),
  };
}

/**
 * Runs detection and rewrites the state file.
 *
 * Detection shares the module-level scan cache with the status bar and the
 * webview, so repeat calls within the TTL cost no extra git runs. A failed
 * write is logged and swallowed: the mapping is advisory (the MCP tools work
 * without it), so it must never take another feature down with it.
 */
export async function writeMcpWorkspaceState(
  stateFilePath: string,
  config: ConfigManager,
  logger: Logger,
): Promise<void> {
  try {
    const instances = config.getInstances();
    const detected = await detectLinkedRepositories(instances);
    const payload = buildWorkspaceStatePayload(instances, detected);
    // globalStorage is not created until something writes into it.
    await fs.promises.mkdir(path.dirname(stateFilePath), { recursive: true });
    // Atomic: the MCP child can read at any moment, and a torn write would
    // look like "no workspace information" (or worse, half a mapping).
    await writeFileAtomically(stateFilePath, JSON.stringify(payload, null, 2));
  } catch (error) {
    logger.debug(`MCP workspace state write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Debounce for the active-editor trigger, mirroring the view provider. */
const STATE_WRITE_DEBOUNCE_MS = 300;
/**
 * Delay of the cold-start write, mirroring the view provider's initial
 * detection: the user may never switch editors, but VS Code may spawn the MCP
 * child right after activation.
 */
const INITIAL_STATE_WRITE_DELAY_MS = 2000;

/**
 * The state file this window publishes, remembered for
 * `cleanupMcpWorkspaceState` — `deactivate()` receives no context, so the path
 * is kept at module scope from registration on.
 */
let activeStateFilePath: string | undefined;

/**
 * Keeps this window's state file current: rewritten when the instance list
 * changes, when workspace folders change, and (debounced) when the active
 * editor changes, plus one delayed write after registration so the file
 * exists before the first MCP child asks for it.
 */
export function registerMcpWorkspaceStateSync(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
): void {
  const stateFilePath = mcpWorkspaceStateFilePath(context);
  activeStateFilePath = stateFilePath;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  // Debounced: rapid tab switches must not spawn repeated writes (detection
  // itself is cheap through the shared scan cache, but the write is not free).
  const scheduleWrite = (): void => {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      void writeMcpWorkspaceState(stateFilePath, config, logger);
    }, STATE_WRITE_DEBOUNCE_MS);
  };
  context.subscriptions.push(
    config.onInstancesChanged(() => scheduleWrite()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void writeMcpWorkspaceState(stateFilePath, config, logger)),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleWrite()),
    {
      dispose: () => {
        clearTimeout(writeTimer);
        clearTimeout(initialTimer);
      },
    },
  );
  // Failures are swallowed inside writeMcpWorkspaceState, so the timer
  // callback never becomes an unhandled rejection. unref'd so tests are not
  // held open by it.
  initialTimer = setTimeout(() => {
    void writeMcpWorkspaceState(stateFilePath, config, logger);
  }, INITIAL_STATE_WRITE_DELAY_MS);
  initialTimer.unref?.();
}

/**
 * Deletes this window's state file on extension shutdown (called from
 * `deactivate()`). Best-effort: a file orphaned by a crash is harmless —
 * its path reaches an MCP child only through the spawn environment of its own
 * window, so nothing ever reads a stale pid's file, and globalStorage is
 * private to this extension.
 */
export async function cleanupMcpWorkspaceState(logger: Logger): Promise<void> {
  const stateFilePath = activeStateFilePath;
  activeStateFilePath = undefined;
  if (!stateFilePath) {
    return;
  }
  try {
    await fs.promises.rm(stateFilePath, { force: true });
  } catch (error) {
    logger.debug(`MCP workspace state cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
