import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type {
  McpInstanceRegistryFile,
  McpWorkspaceStateFile,
} from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import type { ConfigManager } from './config';
import type { Logger } from './logger';
import {
  detectLinkedRepositories,
  isPathInsideFolder,
  type DetectLinkedRepositoriesResult,
} from './worktree/gitOperations';
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
 *
 * The same module also maintains the instance registry
 * (`mcp-instances.json`, see mcpInstanceRegistryFilePath): the list of
 * configured instances — id, userinfo-stripped URL, name, never a token —
 * that lets an MCP server launched without any environment (a static
 * workspace `.mcp.json`) discover the instances on its own — and the
 * stable-path shim (`mcp-server.js`, see mcpServerShimFilePath) that such a
 * static configuration points at instead of the versioned install directory.
 */

/**
 * Per-window random component of the state file name. The pid alone is not
 * enough: pids are recycled, and a window that inherits its dead
 * predecessor's pid would otherwise read (and a stale MCP child of the dead
 * window would keep reading) the old window's mapping. Generated once at
 * module load — one extension host process is one window.
 */
const stateFileNonce = crypto.randomUUID().slice(0, 8);

/**
 * One state file per window (keyed by the extension host's pid plus a
 * per-window nonce): windows may have different workspaces open, and a single
 * shared file would have them overwrite each other's mapping.
 */
export function mcpWorkspaceStateFilePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, `mcp-workspace-${process.pid}-${stateFileNonce}.json`);
}

/**
 * The instance registry's fixed file name, in the same globalStorage directory
 * as the per-window state files.
 *
 * Fixed and per-extension rather than per-window on purpose: the registry
 * describes the account configuration, which every window shares, so one file
 * serves them all — and, more importantly, an MCP server launched outside VS
 * Code's spawn path (a static workspace `.mcp.json`, see mcp/autoConfig.ts)
 * finds it by scanning well-known globalStorage locations, which a pid/nonce
 * name would defeat. `deactivate()` must not delete it: it stays valid across
 * restarts, and an emptied instance list is written as an empty array instead
 * of removing the file, so a consumer can tell "no instances configured" apart
 * from "extension never ran".
 */
export function mcpInstanceRegistryFilePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'mcp-instances.json');
}

/**
 * The shim's fixed file name, next to the instance registry in the same
 * globalStorage directory.
 *
 * A static workspace `.mcp.json` (the Agents window's Agent Host) launches
 * the server by path, and the real bundle lives under the extension's
 * versioned install directory (`cpf23333.forgejo-toolkit-<version>`), which
 * every upgrade replaces. The shim is the stable path to point at instead:
 * it only `require`s the current installation's bundle, and every activation
 * rewrites it, so an upgrade heals the reference the first time the new
 * version runs. Fixed and per-extension rather than per-window, and
 * `deactivate()` must not delete it — exactly like the registry.
 */
export function mcpServerShimFilePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'mcp-server.js');
}

/**
 * The shim's content: a CommonJS stub that loads the real server bundle of the
 * *current* installation (`out/mcp-server.mjs` is ESM and runs `main()` at
 * * module scope, so a dynamic `import()` starts the server; the shim itself
 * stays `.js`/CommonJS because dynamic import reaches ESM from either module
 * system and the path must remain stable across upgrades).
 *
 * The install path is written as a `file://` URL, not as a path: a dynamic
 * `import()` specifier is resolved as a URL, so on Windows `D:/…` is read as the
 * scheme `d:` and the ESM loader refuses it with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME — the shim then dies before the server starts,
 * which is exactly what a foreign launcher sees as "server failed to start".
 * `pathToFileURL` also handles the percent-encoding and quoting a raw path
 * would otherwise need inside the string literal.
 */
export function buildMcpServerShimContent(context: vscode.ExtensionContext): string {
  const serverUrl = pathToFileURL(path.join(context.extensionUri.fsPath, 'out', 'mcp-server.mjs')).href;
  return [
    '// Regenerated by the Forgejo Toolkit extension on every activation.',
    '// It only points at the current installation, so `.mcp.json` files can',
    '// reference this stable path and survive extension upgrades.',
    `import(${JSON.stringify(serverUrl)}).catch((error) => {`,
    '  console.error(`forgejo-toolkit MCP server failed to start: ${error && error.message ? error.message : error}`);',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
}

/**
 * The visible-once flag for shim write failures, mirroring
 * registryWriteFailureReported for the instance registry.
 */
let shimWriteFailureReported = false;

/**
 * Serializes shim writes the same way the state file and the registry are
 * serialized: two activations (or an activation and a registration) writing the
 * same fixed `<target>.part` temporary would race inside writeFileAtomically.
 */
let pendingShimWrite: Promise<void> = Promise.resolve();

/**
 * Writes the stable-path shim next to the instance registry.
 *
 * Independent of the instance list — the shim describes the installation,
 * not the accounts — so it is written on every activation, including windows
 * with no configured (or no token-bearing) instance. A failed write is
 * logged and swallowed like the registry's: a missing shim only breaks the
 * hand-written `.mcp.json` launch path, never the extension itself.
 */
export async function writeMcpServerShim(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  const run = pendingShimWrite.then(() => writeMcpServerShimNow(context, logger));
  // writeMcpServerShimNow already swallows its own failures; the catch keeps
  // the chain alive even if that ever changes.
  pendingShimWrite = run.catch(() => undefined);
  await run;
}

async function writeMcpServerShimNow(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  try {
    const shimFilePath = mcpServerShimFilePath(context);
    const content = buildMcpServerShimContent(context);
    // globalStorage is not created until something writes into it.
    await fs.promises.mkdir(path.dirname(shimFilePath), { recursive: true });
    // Skip the write when nothing changed: activation happens on every
    // window load, and an unconditional write would bump the file's mtime
    // (and any watcher following it) for no reason. A read failure (ENOENT
    // on first run, or an unreadable file) falls through to the write.
    const existing = await fs.promises.readFile(shimFilePath, 'utf8').catch(() => undefined);
    if (existing === content) {
      return;
    }
    // Atomic like the neighboring files: an Agent Host session can launch
    // the shim at any moment, and a torn write would be a syntax error at
    // startup.
    await writeFileAtomically(shimFilePath, content);
    shimWriteFailureReported = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!shimWriteFailureReported) {
      logger.info(`MCP server shim write failed (further failures are debug-only until a write succeeds): ${message}`);
      shimWriteFailureReported = true;
    }
    logger.debug(`MCP server shim write failed: ${message}`);
  }
}

/**
 * Builds the registry content from the configured instances.
 *
 * The URL is written with its userinfo *removed* — the file must never carry
 * credentials, and the token field never reaches the payload at all: a
 * zero-configuration MCP child reads this file to learn which instances exist
 * and either forwards into the extension host's broker (the normal case) or,
 * with no broker running, authenticates anonymously or through its own
 * FORGEJO_MCP_TOKEN.
 */
export function buildInstanceRegistryPayload(instances: ForgejoInstance[]): McpInstanceRegistryFile {
  return {
    updatedAt: new Date().toISOString(),
    instances: instances.map((instance) => ({
      id: instance.id,
      url: stripUrlUserinfo(instance.url),
      name: instance.name,
    })),
  };
}

/**
 * Serializes the registry writes of this window, separately from the state
 * file's `pendingWrite` chain: the two files have different payloads and
 * triggers, and sharing one chain would let a slow detection-backed state
 * write delay a trivial registry write (and vice versa) for no correctness
 * gain — each chain only has to order writes to *its own* `.part` temporary.
 *
 * No cross-window chain exists: every window derives the same content from the
 * same shared configuration and writes it atomically, so a fixed-name file
 * shared between windows only ever shows one complete snapshot, and which
 * window's identical write landed last is unobservable.
 */
let pendingRegistryWrite: Promise<void> = Promise.resolve();

function enqueueRegistryWrite(registryFilePath: string, config: ConfigManager, logger: Logger): Promise<void> {
  const run = pendingRegistryWrite.then(() => writeMcpInstanceRegistry(registryFilePath, config, logger));
  // writeMcpInstanceRegistry already swallows its own failures; the catch
  // keeps the chain alive even if that ever changes.
  pendingRegistryWrite = run.catch(() => undefined);
  return run;
}

/**
 * Resolves when every write this window enqueued — state file, instance
 * registry and the stable-path shim alike — has settled. `deactivate()` uses it
 * so a shutdown cannot leave a `.part` temporary behind, and tests use it to
 * observe the files (or remove their directory) without racing an in-flight
 * atomic write: its still-open `.part` handle makes a directory removal fail
 * with EPERM on Windows, and retrying the removal only narrows the race
 * instead of closing it.
 */
export async function whenMcpStateWritesSettled(): Promise<void> {
  await pendingWrite;
  await pendingRegistryWrite;
  await pendingShimWrite;
}

/**
 * The visible-once flag for registry write failures, mirroring
 * writeFailureReported for the state file.
 */
let registryWriteFailureReported = false;

/**
 * Rewrites the instance registry from the current configuration.
 *
 * Runs without detection (unlike the state file, this needs no git scan), so
 * it is cheap enough to fire eagerly on registration. A failed write is logged
 * and swallowed, exactly like the state file's: the registry enables
 * zero-configuration launches, but the VS Code-spawned children never read it,
 * so a failure must not surface as an extension error.
 */
export async function writeMcpInstanceRegistry(
  registryFilePath: string,
  config: ConfigManager,
  logger: Logger,
): Promise<void> {
  try {
    const payload = buildInstanceRegistryPayload(config.getInstances());
    // globalStorage is not created until something writes into it.
    await fs.promises.mkdir(path.dirname(registryFilePath), { recursive: true });
    // Atomic: the zero-config MCP child can read at any moment, and a torn
    // write would look like "extension never ran".
    await writeFileAtomically(registryFilePath, JSON.stringify(payload, null, 2));
    registryWriteFailureReported = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!registryWriteFailureReported) {
      logger.info(
        `MCP instance registry write failed (further failures are debug-only until a write succeeds): ${message}`,
      );
      registryWriteFailureReported = true;
    }
    logger.debug(`MCP instance registry write failed: ${message}`);
  }
}

/**
 * Both the current (`<pid>-<nonce>.json`) and the pre-nonce (`<pid>.json`)
 * state file names, plus the `.part` temporary of an interrupted atomic
 * write. Everything this extension ever leaves in globalStorage under the
 * `mcp-workspace-` prefix matches this.
 */
const STATE_FILE_NAME_PATTERN = /^mcp-workspace-(\d+)(?:-[0-9a-f]{8})?\.json(?:\.part)?$/;

/**
 * True while the process exists. `process.kill(pid, 0)` is the probe: it
 * sends no signal, throws ESRCH for a dead pid, and throws EPERM for a live
 * process owned by another user — which counts as alive, because deleting
 * that window's file is worse than keeping a stale one.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Deletes orphaned state files from globalStorage: `deactivate()` removes the
 * window's own file, but a crash (or a killed extension host) skips that, and
 * nothing else would ever remove the orphans. A file is orphaned when the pid
 * in its name is dead; files of live windows (and of pids the probe cannot
 * see, EPERM) are left alone. Best-effort and silent beyond debug logging —
 * a failed sweep only means the next activation tries again.
 */
async function sweepStaleStateFiles(globalStorageDir: string, logger: Logger): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(globalStorageDir, { withFileTypes: true });
  } catch {
    // globalStorage does not exist until something writes into it.
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = STATE_FILE_NAME_PATTERN.exec(entry.name);
    if (!match) {
      continue;
    }
    if (isPidAlive(Number(match[1]))) {
      continue;
    }
    try {
      await fs.promises.rm(path.join(globalStorageDir, entry.name), { force: true });
      logger.debug(`MCP workspace state sweep removed orphaned file: ${entry.name}`);
    } catch (error) {
      logger.debug(
        `MCP workspace state sweep failed for ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * The attribution the `active` flag may follow, or undefined when no
 * repository may be flagged. Detection attributes the active repository
 * itself, but its fallback (`linked = matches[0]` when the active editor is
 * nowhere or outside every match) is weaker than what the flag promises to
 * the agent — "the repository the user is looking at" — so the writer only
 * trusts attribution that is unambiguous on its own: a single linked
 * repository, or the active editor verifiably inside the attributed one.
 */
function confirmedActiveRepository(detected: DetectLinkedRepositoriesResult): LinkedRepository | undefined {
  if (!detected.linked) {
    return undefined;
  }
  if (detected.all.length === 1) {
    return detected.linked;
  }
  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (
    activePath &&
    (activePath === detected.linked.localPath || isPathInsideFolder(detected.linked.localPath, activePath))
  ) {
    return detected.linked;
  }
  return undefined;
}

/**
 * Builds the file content from the detection result.
 *
 * `instanceUrl` is re-resolved from the instance list (detection only carries
 * the instance id) and written with its userinfo *removed* — the MCP child of
 * an older host matches it against its own instance URL, so it needs the
 * usable form, and the file must never carry credentials either way. A
 * repository whose instance disappeared between detection and this mapping is
 * dropped: the child for that instance is gone with it.
 */
export function buildWorkspaceStatePayload(
  instances: ForgejoInstance[],
  detected: DetectLinkedRepositoriesResult,
): McpWorkspaceStateFile {
  const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
  const activeRepository = confirmedActiveRepository(detected);
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
          // `linked` is an element of `all` (attribution picks, never copies),
          // so identity marks the attributed repository.
          active: activeRepository === repo,
        },
      ];
    }),
  };
}

/**
 * Set once `cleanupMcpWorkspaceState` runs (extension shutdown) and cleared by
 * `registerMcpWorkspaceStateSync`. A detection that was in flight across the
 * boundary must not write afterwards: it would recreate the file cleanup just
 * removed.
 */
let disposed = false;

/**
 * The visible-once flag for write failures (see writeMcpWorkspaceState);
 * reset by the next successful write so a persistent failure surfaces once
 * per failure streak, not once ever.
 */
let writeFailureReported = false;

/**
 * Serializes all state-file writes of this window. The three triggers
 * (debounced editor change, workspace-folder change, the cold-start write)
 * fire independently, and an unchained pair of writes races on the same fixed
 * `<target>.part` temporary inside writeFileAtomically — one of them loses
 * its temporary from under itself, or the older mapping lands *after* the
 * newer one. The atomic write protects against a crash mid-write, not against
 * concurrent writers; the chain is what provides that.
 */
let pendingWrite: Promise<void> = Promise.resolve();

function enqueueStateWrite(stateFilePath: string, config: ConfigManager, logger: Logger): Promise<void> {
  const run = pendingWrite.then(() => writeMcpWorkspaceState(stateFilePath, config, logger));
  // writeMcpWorkspaceState already swallows its own failures; the catch keeps
  // the chain alive even if that ever changes.
  pendingWrite = run.catch(() => undefined);
  return run;
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
    if (disposed) {
      // deactivate() ran while detection was in flight; writing now would
      // recreate the file cleanupMcpWorkspaceState just removed.
      return;
    }
    const payload = buildWorkspaceStatePayload(instances, detected);
    // globalStorage is not created until something writes into it.
    await fs.promises.mkdir(path.dirname(stateFilePath), { recursive: true });
    // Atomic: the MCP child can read at any moment, and a torn write would
    // look like "no workspace information" (or worse, half a mapping).
    await writeFileAtomically(stateFilePath, JSON.stringify(payload, null, 2));
    writeFailureReported = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The logger has no warn level, so info is the visible channel. Reported
    // once per failure streak: the mapping is advisory, but a window where
    // every write fails leaves get_workspace_repository permanently blind,
    // and that should surface without opting into debug logging.
    if (!writeFailureReported) {
      logger.info(
        `MCP workspace state write failed (further failures are debug-only until a write succeeds): ${message}`,
      );
      writeFailureReported = true;
    }
    logger.debug(`MCP workspace state write failed: ${message}`);
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
 * exists before the first MCP child asks for it. Registration also sweeps
 * globalStorage for state files orphaned by crashed windows.
 *
 * Registration additionally maintains the instance registry
 * (mcpInstanceRegistryFilePath): written immediately at registration — no
 * debounce and no detection wait, because the payload is just the configured
 * instance list — and re-written from the same onInstancesChanged listener
 * that schedules the state write, so the two files never disagree about the
 * instance list for longer than the state debounce.
 *
 * Registration also rewrites the stable-path shim (mcpServerShimFilePath) on
 * every activation: the shim points at the versioned install directory, so
 * the write is what heals static `.mcp.json` references after an upgrade.
 * It depends on neither the instance list nor detection.
 */
export function registerMcpWorkspaceStateSync(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
): void {
  const stateFilePath = mcpWorkspaceStateFilePath(context);
  const registryFilePath = mcpInstanceRegistryFilePath(context);
  activeStateFilePath = stateFilePath;
  disposed = false;
  void sweepStaleStateFiles(context.globalStorageUri.fsPath, logger);
  // Eager: a zero-configuration MCP child can start at any moment and needs
  // the registry to exist, while the state file's own cold-start write is
  // delayed to share the view provider's detection settle time.
  void enqueueRegistryWrite(registryFilePath, config, logger);
  // Equally eager and instance-independent: the shim is what a static
  // `.mcp.json` points at, so every activation re-points it at the current
  // installation (writeMcpServerShim skips the write when nothing changed).
  void writeMcpServerShim(context, logger);
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  // Debounced: rapid tab switches must not spawn repeated writes (detection
  // itself is cheap through the shared scan cache, but the write is not free).
  const scheduleWrite = (): void => {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      void enqueueStateWrite(stateFilePath, config, logger);
    }, STATE_WRITE_DEBOUNCE_MS);
  };
  context.subscriptions.push(
    config.onInstancesChanged(() => {
      scheduleWrite();
      void enqueueRegistryWrite(registryFilePath, config, logger);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void enqueueStateWrite(stateFilePath, config, logger)),
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
    void enqueueStateWrite(stateFilePath, config, logger);
  }, INITIAL_STATE_WRITE_DELAY_MS);
  initialTimer.unref?.();
}

/**
 * Deletes this window's state file on extension shutdown (called from
 * `deactivate()`). Sets `disposed` first so a detection still in flight skips
 * its write instead of recreating the file, then waits out every write chain
 * (state file, registry and shim — every triggered write goes through one of
 * them, so after they settle nothing can still land, and no `.part` temporary
 * is left half-written), and only then removes the file. Best-effort beyond
 * that: a file orphaned by a crash is swept by the next activation
 * (sweepStaleStateFiles), and globalStorage is private to this extension.
 */
export async function cleanupMcpWorkspaceState(logger: Logger): Promise<void> {
  const stateFilePath = activeStateFilePath;
  activeStateFilePath = undefined;
  disposed = true;
  await whenMcpStateWritesSettled();
  if (!stateFilePath) {
    return;
  }
  try {
    await fs.promises.rm(stateFilePath, { force: true });
  } catch (error) {
    logger.debug(`MCP workspace state cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
