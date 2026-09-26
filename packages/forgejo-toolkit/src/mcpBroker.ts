import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { McpBrokerRegistryFile } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { ForgejoClient } from './api/client';
import type { ConfigManager } from './config';
import type { Logger } from './logger';
import { detectLinkedRepositories, isPathInsideFolder } from './worktree/gitOperations';
import { writeFileAtomically } from './utils/atomicWrite';
import { defaultBrokerEndpoint, startMcpBroker, type McpBrokerHandle } from '../mcp/brokerServer';
import { createMcpServer } from '../mcp/mcpServer';
import { mcpWorkspaceStateFilePath } from './mcpWorkspaceState';

/**
 * The extension-host side of the MCP broker (listener: mcp/brokerServer.ts;
 * forwarder: mcp/brokerForwarder.ts).
 *
 * Why this exists: an MCP server launched from a static `mcp.json` — the
 * Agents window's Agent Host, or any third-party MCP client — receives no
 * environment from the extension, so it cannot carry a token and reads
 * anonymously. The extension host has every instance and its token. The
 * broker closes that gap without moving the token: the statically launched
 * process becomes a pure stdio forwarder onto a local named pipe / unix
 * socket, and the authenticated tool logic runs here, in the process that
 * already holds the tokens.
 *
 * The forwarder finds this broker through the fixed-name `mcp-broker.json`
 * registration in globalStorage (see McpBrokerRegistryFile in
 * packages/shared/src/mcp/workspaceState.ts for the shape and the security
 * argument for the handshake secret it carries).
 */

/**
 * The registration file's fixed name, next to the instance registry in the
 * same globalStorage directory. Fixed and per-extension rather than
 * per-window for the same reason as `mcp-instances.json`: a headless
 * forwarder discovers it by scanning well-known locations.
 */
export function mcpBrokerFilePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'mcp-broker.json');
}

/**
 * This window's broker, kept at module scope because `deactivate()` receives
 * no context — same pattern as mcpWorkspaceState.ts's `activeStateFilePath`.
 */
let activeBroker: { handle: McpBrokerHandle; filePath: string } | undefined;

/**
 * The in-flight startup, so cleanup can wait for it: deactivate during the
 * `await startMcpBroker` window would otherwise no-op (activeBroker is not
 * set yet) and let the startup finish into a broker nobody will ever stop.
 */
let brokerStartup: Promise<void> | undefined;

/**
 * Bumped by every cleanup. A startup captures the generation on entry; if it
 * no longer matches when the listen resolves, a cleanup ran in between and
 * the late handle is closed again instead of registered. A counter rather
 * than a boolean so a fresh start after a cleanup is not poisoned forever
 * (and tests can start/cleanup repeatedly against the same module).
 */
let brokerGeneration = 0;

/**
 * Resolves which configured instance a forwarded session should serve.
 *
 * The session's working directory comes from the MCP host that spawned the
 * forwarder. When it sits inside a checkout this window has linked to an
 * instance, that instance wins — detection reuses the shared scan cache, so
 * this costs no extra git runs. Otherwise (the Agents window launches servers
 * from the user's home directory, which is no checkout at all) the first
 * token-bearing instance answers: the session asked for *the* Forgejo server,
 * any authenticated instance beats an anonymous one, and the tools that need
 * a repository take owner/repo explicitly or resolve them through the
 * workspace state file. A detected instance without a token cannot
 * authenticate, so it loses to the token-bearing fallback.
 *
 * Exported for the unit tests in src/__tests__/mcpBroker.test.ts.
 */
export async function resolveBrokerInstance(
  cwd: string,
  instances: ForgejoInstance[],
  logger: Logger,
): Promise<ForgejoInstance | undefined> {
  try {
    const detected = await detectLinkedRepositories(instances);
    const containing = detected.all
      .filter((repo) => repo.localPath === cwd || isPathInsideFolder(repo.localPath, cwd))
      // Longest path first, so a nested checkout beats its enclosing one
      // (same rule as the detection's own attribution).
      .sort((a, b) => b.localPath.length - a.localPath.length);
    const linked = containing
      .map((repo) => instances.find((instance) => instance.id === repo.instanceId))
      .find((instance) => instance?.token);
    if (linked) {
      logger.debug(`MCP broker: session cwd ${cwd} resolved to instance ${linked.name || linked.url}`);
      return linked;
    }
  } catch (error) {
    // Detection is best-effort (it spawns git); its failure must not cost the
    // session the token-bearing fallback.
    logger.debug(`MCP broker: repository detection failed, using the fallback instance: ${error}`);
  }
  return instances.find((instance) => instance.token);
}

/**
 * Starts the broker unless another window already owns it.
 *
 * Multi-window: exactly one broker per user/endpoint. The first window to
 * bind wins; a window whose listen fails with EADDRINUSE/EACCES steps aside
 * with a debug log and no registration write — the forwarder only needs *a*
 * broker, and the owning window's file already points at it. Any other
 * failure is logged once at info level and swallowed: the broker upgrades an
 * anonymous fallback into an authenticated one, but the fallback still works,
 * so a broker failure must never break activation.
 */
export function startMcpBrokerIfFirst(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
  options?: { endpoint?: string },
): Promise<void> {
  const generation = brokerGeneration;
  brokerStartup = startMcpBrokerIfFirstInner(context, config, logger, options, generation);
  return brokerStartup;
}

async function startMcpBrokerIfFirstInner(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
  options: { endpoint?: string } | undefined,
  generation: number,
): Promise<void> {
  // Tests override the endpoint: the default is a hash of the user profile,
  // which is the same value the production extension computes — a test running
  // on a machine whose VS Code already hosts a broker would collide with it.
  const endpoint =
    options?.endpoint ??
    defaultBrokerEndpoint({
      platform: process.platform,
      username: os.userInfo().username,
      homeDir: os.homedir(),
    });
  // Random per broker launch, not per session: the registration file is what
  // authorizes a forwarder, and it is rewritten every time the broker starts
  // (see McpBrokerRegistryFile for why this secret — and never a Forgejo
  // token — is the right thing to publish).
  const authToken = crypto.randomBytes(32).toString('hex');
  let handle: McpBrokerHandle;
  try {
    handle = await startMcpBroker({
      endpoint,
      authToken,
      createServer: (cwd) => createBrokerMcpServer(cwd, context, config, logger),
      log: (message) => logger.debug(message),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only EADDRINUSE means "another window owns the endpoint" and steps
    // aside silently. EACCES is a real local problem (an unwritable temp
    // dir, another user's leftover socket file) and must stay visible.
    if (code === 'EADDRINUSE') {
      logger.debug(`MCP broker not started: another window already owns ${endpoint}.`);
      return;
    }
    logger.info(`MCP broker failed to start (static mcp.json launches stay anonymous): ${error}`);
    return;
  }
  if (generation !== brokerGeneration) {
    // A cleanup ran while the listen was in flight; it saw no activeBroker,
    // so this handle is ours to close.
    await handle.close().catch(() => undefined);
    return;
  }
  const filePath = mcpBrokerFilePath(context);
  activeBroker = { handle, filePath };
  const payload: McpBrokerRegistryFile = {
    version: 1,
    pid: process.pid,
    endpoint,
    authToken,
    startedAt: new Date().toISOString(),
  };
  try {
    // globalStorage is not created until something writes into it; atomic,
    // because a forwarder can read at any moment. The registration carries
    // the handshake secret, so it is created owner-only (0600) inside an
    // owner-only directory instead of inheriting the process umask — the
    // "readable only by your own user" claim the docs make must be enforced,
    // not assumed.
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.promises.chmod(path.dirname(filePath), 0o700).catch(() => undefined);
    await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch (error) {
    // Without the registration no forwarder can find the broker, so a live
    // but undiscoverable listener is shut down again rather than left
    // holding the endpoint for nothing.
    logger.info(`MCP broker registration write failed, stopping the broker: ${error}`);
    activeBroker = undefined;
    await handle.close().catch(() => undefined);
    return;
  }
  logger.info(`MCP broker listening at ${endpoint}`);
}

/**
 * The comparison form for local checkout paths. Case is folded on Windows
 * only (its filesystems are case-insensitive; Linux is sensitive and macOS
 * can be either) — the same rule mcp/autoConfig.ts's normalizeLocalPath
 * applies when it reads the same state files, and the two must agree.
 */
function normalizeCheckoutPath(checkoutPath: string): string {
  const resolved = path.resolve(checkoutPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface BrokerStateMatch {
  /** The per-window state file whose repository entry contains the session cwd. */
  stateFile: string;
  /** The matched entry's instance id, when the entry carries a usable one. */
  instanceId?: string;
}

/**
 * The state file (and instance) of the window whose workspace actually
 * contains the session's working directory.
 *
 * One broker serves the whole machine (first window to bind wins), so a
 * forwarded session can belong to a *different* window's workspace. Always
 * answering from the owning window's own state file would hand that session
 * the wrong repository mapping — and, through the instance it implies,
 * account details of a workspace the session is not about. Instead every
 * per-window state file in globalStorage is consulted and the one whose
 * `localPath` contains the cwd wins; a nested checkout beats its enclosing
 * one (longest path first), the same attribution rule the detection uses.
 *
 * Returns undefined when no file matches: the caller falls back to this
 * window's own state file and the git-scan-based instance resolution, which
 * is the right answer for a session about the owning window's workspace or
 * no workspace at all.
 *
 * Exported for the unit tests in src/__tests__/mcpBroker.test.ts.
 */
export async function findBrokerStateMatch(
  context: vscode.ExtensionContext,
  cwd: string,
): Promise<BrokerStateMatch | undefined> {
  const stateDir = context.globalStorageUri.fsPath;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(stateDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const normalizedCwd = normalizeCheckoutPath(cwd);
  let best: (BrokerStateMatch & { localPathLength: number }) | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !/^mcp-workspace-.+\.json$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(stateDir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch {
      continue; // Another window's file mid-rewrite or already gone — skip.
    }
    const repositories = (parsed as { repositories?: unknown } | null)?.repositories;
    if (!Array.isArray(repositories)) {
      continue;
    }
    for (const repository of repositories) {
      const localPath = (repository as { localPath?: unknown }).localPath;
      if (typeof localPath !== 'string' || !localPath) {
        continue;
      }
      const normalizedLocal = normalizeCheckoutPath(localPath);
      if (normalizedLocal !== normalizedCwd && !isPathInsideFolder(normalizedLocal, normalizedCwd)) {
        continue;
      }
      const instanceId = (repository as { instanceId?: unknown }).instanceId;
      if (!best || normalizedLocal.length > best.localPathLength) {
        best = {
          stateFile: filePath,
          instanceId: typeof instanceId === 'string' && instanceId ? instanceId : undefined,
          localPathLength: normalizedLocal.length,
        };
      }
    }
  }
  return best;
}

/**
 * One MCP server per broker session. The client carries the resolved
 * instance's token — this is the whole point of the broker — and the version
 * gate reuses the extension host's probe cache (activation already probed
 * every instance), so no extra probe runs here.
 *
 * Instance and state file follow the session's working directory, not the
 * owning window: a session whose cwd sits inside a checkout another window
 * published gets that window's state file and (when it carries a token) that
 * window's instance, so `get_workspace_repository` answers for the workspace
 * the session is actually about (see findBrokerStateMatch). Sessions that
 * match no published checkout behave as before: git-scan resolution against
 * this window's links, then the first token-bearing instance, with this
 * window's own state file.
 */
async function createBrokerMcpServer(
  cwd: string,
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
) {
  const instances = config.getInstances();
  const stateMatch = await findBrokerStateMatch(context, cwd).catch(() => undefined);
  let instance = stateMatch?.instanceId
    ? instances.find((candidate) => candidate.id === stateMatch.instanceId && candidate.token)
    : undefined;
  if (instance) {
    logger.debug(
      `MCP broker: session cwd ${cwd} matched a published workspace on instance ${instance.name || instance.url}`,
    );
  } else {
    instance = await resolveBrokerInstance(cwd, instances, logger);
  }
  if (!instance) {
    throw new Error('no configured instance with a token');
  }
  const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
  return createMcpServer(client, {
    instanceUrl: instance.url,
    instanceId: instance.id,
    stateFile: stateMatch?.stateFile ?? mcpWorkspaceStateFilePath(context),
  });
}

/**
 * Stops this window's broker and removes its registration file (called from
 * `deactivate()`). Only the file this window wrote is removed: a window that
 * stepped aside must not delete the owning window's registration.
 */
export async function cleanupMcpBroker(logger: Logger): Promise<void> {
  brokerGeneration += 1;
  // A startup still in flight would otherwise register a broker after this
  // cleanup ran; it notices the generation bump and closes its own handle,
  // but only once it gets that far — wait for it so deactivate really leaves
  // nothing behind.
  await brokerStartup?.catch(() => undefined);
  const broker = activeBroker;
  activeBroker = undefined;
  if (!broker) {
    return;
  }
  await broker.handle.close().catch((error: unknown) => {
    logger.debug(`MCP broker close failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    await fs.promises.rm(broker.filePath, { force: true });
  } catch (error) {
    logger.debug(`MCP broker registration cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
