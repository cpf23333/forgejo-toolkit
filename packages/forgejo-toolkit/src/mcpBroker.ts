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
 *
 * The endpoint belongs to the user, not to a window, so exactly one window
 * owns the broker at a time; the others step aside and watch for the owner to
 * disappear, then take the endpoint over themselves (see
 * startMcpBrokerIfFirst and startMcpBrokerTakeoverWatcher).
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
 * How long a stepped-aside window waits between takeover checks.
 *
 * One tick reads the registration file (a few hundred bytes) and checks the
 * recorded pid with `process.kill(pid, 0)`, which delivers no signal; only a
 * verdict of "the owner is gone" goes on to a listen attempt. 5 s is chosen
 * against both ends of the range. Faster would buy nothing user-visible: a
 * forwarder that finds no live broker reads anonymously for that one session,
 * and the *next* launch re-reads the registration, so the recovery
 * granularity that matters is "the next MCP session", not sub-second. Much
 * slower (30 s, say) would leave a user who closes the owning window and
 * immediately starts an Agents-window session on anonymous reads for no good
 * reason. Exported so the unit tests advance the interval the extension
 * actually uses instead of a second copy of the value.
 */
export const BROKER_TAKEOVER_POLL_MS = 5_000;

/**
 * The stepped-aside window's takeover timer, and the attempt it may have in
 * flight. Module scope next to `activeBroker` for the same reason: the window
 * that stepped aside is exactly the one `deactivate()` must not leave a timer
 * behind in. One timer per window (the start function below early-returns
 * while it exists), unref'd — see startMcpBrokerTakeoverWatcher.
 */
let brokerTakeoverWatcher: NodeJS.Timeout | undefined;
let brokerTakeoverAttempt: Promise<void> | undefined;

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
 * Starts the broker unless another window already owns it; a window that finds
 * the endpoint taken steps aside *and keeps watching it*, so the broker is
 * handed over automatically when the owner goes away.
 *
 * Multi-window: exactly one broker per user/endpoint. Binding is the arbiter —
 * the first window to bind wins, and a window whose listen fails with
 * EADDRINUSE logs the step-aside at debug level and writes no registration of
 * its own (the owner's file already points at the owner), then starts the
 * takeover watcher below. EACCES is *not* that case: it means this machine
 * refuses the endpoint for a real reason, so it is logged at info level like
 * any other failure — and no watcher is started for it, because retrying a
 * local permission problem every few seconds cannot fix it. Any other failure
 * is logged once and swallowed: the broker upgrades an anonymous fallback into
 * an authenticated one, but the fallback still works, so a broker failure must
 * never break activation.
 *
 * The watcher is only ever created here, which is what keeps it out of a
 * disabled surface: `forgejoToolkit.mcpEnabled` being off means this function
 * is never called at all, and turning the setting off calls
 * `cleanupMcpBroker()`, which clears the watcher (see that function).
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
  // Resolved once and reused by every takeover attempt: the endpoint belongs
  // to this user, not to this window, so it must not move.
  const endpoint =
    options?.endpoint ??
    defaultBrokerEndpoint({
      platform: process.platform,
      username: os.userInfo().username,
      homeDir: os.homedir(),
    });
  const outcome = await attemptMcpBrokerStart(context, config, logger, endpoint, generation);
  if (outcome === 'contended') {
    startMcpBrokerTakeoverWatcher(context, config, logger, endpoint, generation);
  }
}

/** How one broker start attempt ended; see attemptMcpBrokerStart. */
type BrokerStartOutcome =
  /** This window bound the endpoint and wrote the registration: it is the owner. */
  | 'owned'
  /** Another window owns the endpoint (EADDRINUSE), so waiting it out is worthwhile. */
  | 'contended'
  /** A local failure (EACCES, an unwritable registration, …): not worth retrying. */
  | 'failed';

/**
 * One attempt at becoming the broker: listen, then publish the registration.
 * The post-bind path below is the same one a takeover runs — a window that
 * takes the endpoint over is an owner like any other, so it writes its own
 * live pid and logs the same info line.
 */
async function attemptMcpBrokerStart(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
  endpoint: string,
  generation: number,
): Promise<BrokerStartOutcome> {
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
      return 'contended';
    }
    logger.info(`MCP broker failed to start (static mcp.json launches stay anonymous): ${error}`);
    return 'failed';
  }
  if (generation !== brokerGeneration) {
    // A cleanup ran while the listen was in flight; it saw no activeBroker,
    // so this handle is ours to close.
    await handle.close().catch(() => undefined);
    return 'failed';
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
    return 'failed';
  }
  logger.info(`MCP broker listening at ${endpoint}`);
  return 'owned';
}

/**
 * Keeps a stepped-aside window watching for the endpoint to become free, and
 * binds it itself when it does.
 *
 * Why a poll rather than an event: an owner can die in ways that notify nobody
 * — a crash, a `kill`, an extension host that exits without `deactivate()` —
 * and the only cross-process trace that survives is the registration file.
 * Reading it and checking the recorded pid is the cheap, honest liveness test:
 * the file is gone (a clean `deactivate()` removes it) or its pid is
 * verifiably dead (a crash left the file behind) both mean the owner is gone,
 * while a live pid means it is still there and this window stays stepped
 * aside. An unreadable or unparseable file also counts as "no owner
 * recorded", matching the forwarder's own reader
 * (`discoverBrokerRegistration` in mcp/autoConfig.ts skips such a file too).
 *
 * Binding stays the arbiter; there is deliberately **no file lock and no
 * election protocol**. Two stepped-aside windows whose tick lands together
 * both call listen, exactly one wins, and the loser's EADDRINUSE only means
 * "someone else got there first" — it keeps watching instead of treating the
 * loss as a failure. That is also why a false "the owner is gone" verdict can
 * never produce two brokers: the worst case is one failed listen.
 *
 * Corner cases, all covered by the unit tests:
 *  - the owner closed cleanly → its registration file is gone → bind;
 *  - the owner was killed → the file is left with a dead pid → bind;
 *  - the owner is alive → stay stepped aside, tick after tick, silently;
 *  - two stepped-aside windows race → exactly one binds, the other gets
 *    EADDRINUSE and keeps its watcher;
 *  - this window wins → the ordinary post-bind path runs unchanged (the
 *    registration carries this window's live pid, the info line is logged)
 *    and the watcher stops because this window is the owner now;
 *  - `forgejoToolkit.mcpEnabled` turned off, or `deactivate()` → both call
 *    `cleanupMcpBroker()`, which clears the watcher;
 *  - a takeover that cannot publish its registration (a failing write) → the
 *    endpoint is free again but retrying would repeat a failing write and its
 *    log line every tick, so that non-EADDRINUSE outcome stops the watcher.
 *
 * Residual: a pid the OS recycled onto an unrelated process reads as alive,
 * so this window waits until that process exits. The forwarder's own probe has
 * the same blind spot, and the dangerous direction (a false "gone") is still
 * arbitrated by the listen.
 */
function startMcpBrokerTakeoverWatcher(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
  endpoint: string,
  generation: number,
): void {
  if (brokerTakeoverWatcher) {
    return;
  }
  const timer = setInterval(() => {
    void checkBrokerTakeover(context, config, logger, endpoint, generation).catch((error: unknown) => {
      // A tick must never surface as an unhandled rejection in the host; the
      // next tick tries again anyway.
      logger.debug(`MCP broker takeover check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, BROKER_TAKEOVER_POLL_MS);
  // Never keep a window — or any other process that loads this module — alive
  // for a recovery that only matters while a window is there to recover.
  timer.unref();
  brokerTakeoverWatcher = timer;
}

/** One watcher tick: become the owner if the current one is gone. */
async function checkBrokerTakeover(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  logger: Logger,
  endpoint: string,
  generation: number,
): Promise<void> {
  if (generation !== brokerGeneration) {
    // cleanupMcpBroker ran (the setting was turned off, or the window is
    // deactivating); it already cleared the timer. This half of the guard
    // covers the tick that was already in flight when it did.
    stopMcpBrokerTakeoverWatcher();
    return;
  }
  if (brokerTakeoverAttempt) {
    // The previous tick's listen plus registration write is still running; a
    // concurrent second attempt would only duplicate it. Dropping this tick
    // costs nothing — the next one is BROKER_TAKEOVER_POLL_MS away.
    return;
  }
  const attempt = (async (): Promise<void> => {
    if (await brokerRegistrationOwnerIsAlive(mcpBrokerFilePath(context))) {
      return; // Owner alive: stay stepped aside, silently, and keep watching.
    }
    const outcome = await attemptMcpBrokerStart(context, config, logger, endpoint, generation);
    if (outcome === 'contended') {
      return; // Another window won the race; keep watching.
    }
    // 'owned': this window is the owner now and the registration points at
    // it. 'failed': the endpoint is free but this window cannot take it, and
    // repeating a failing attempt every tick would only repeat its log line.
    stopMcpBrokerTakeoverWatcher();
  })();
  brokerTakeoverAttempt = attempt;
  try {
    await attempt;
  } finally {
    if (brokerTakeoverAttempt === attempt) {
      brokerTakeoverAttempt = undefined;
    }
  }
}

/** Stops the watcher, if any. Idempotent, so cleanup can call it freely. */
function stopMcpBrokerTakeoverWatcher(): void {
  if (!brokerTakeoverWatcher) {
    return;
  }
  clearInterval(brokerTakeoverWatcher);
  brokerTakeoverWatcher = undefined;
}

/**
 * Cheap liveness probe for a pid: signal 0 performs the existence and
 * permission checks without delivering anything, and EPERM still means "the
 * process exists". The same rule mcp/autoConfig.ts's `isPidAlive` applies to
 * the same file on the forwarder side; the two must agree. It is duplicated
 * here on purpose: this side is the extension host, and the host has no
 * business pulling the headless bundle's multi-directory discovery into its
 * module graph for three lines.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True when this window's registration file names a pid that is still alive.
 *
 * This window's own file is the whole answer, and it is the cheap one: a clean
 * `deactivate()` removes it ("gone"), while a crash leaves it behind with a
 * pid the OS reports as dead. Both mean the endpoint can be taken over, and
 * the listen that follows is what actually decides it.
 */
async function brokerRegistrationOwnerIsAlive(filePath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const pid = (parsed as { pid?: unknown } | null)?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return isProcessAlive(pid);
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
 * Stops this window's broker, removes its registration file, and stops the
 * takeover watcher (called from `deactivate()`, and from the MCP surface's
 * dispose when `forgejoToolkit.mcpEnabled` is turned off). Only the file this
 * window wrote is removed: a window that stepped aside must not delete the
 * owning window's registration.
 */
export async function cleanupMcpBroker(logger: Logger): Promise<void> {
  brokerGeneration += 1;
  // Stop watching first: a tick after the generation bump would be refused
  // anyway (see checkBrokerTakeover), but clearing up front means no takeover
  // listen can even begin behind this cleanup — and an unref'd timer that is
  // never cleared would outlive the surface that owns it.
  stopMcpBrokerTakeoverWatcher();
  // A startup still in flight would otherwise register a broker after this
  // cleanup ran; it notices the generation bump and closes its own handle,
  // but only once it gets that far — wait for it so deactivate really leaves
  // nothing behind.
  await brokerStartup?.catch(() => undefined);
  // A takeover attempt is not `brokerStartup`: it is awaited through its own
  // promise, so a late winner cannot write a registration file after this
  // cleanup removed one.
  await brokerTakeoverAttempt?.catch(() => undefined);
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
