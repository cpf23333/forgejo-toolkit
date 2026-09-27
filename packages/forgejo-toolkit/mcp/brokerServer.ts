import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * The extension-host MCP broker: a local listener that runs the real tool
 * logic (with the instance token) inside the extension host process, so both
 * MCP servers launched from a static `mcp.json` and servers the extension
 * itself provides can be pure stdio forwarders and the token never crosses the
 * extension boundary (consumer of this side: src/mcpBroker.ts; the forwarder
 * half lives in mcp/brokerForwarder.ts).
 *
 * Wire protocol per connection:
 *
 *   1. The forwarder's first line must be the JSON handshake
 *      `{ "authToken": string, "cwd": string, "instanceId"?, "stateFile"?,
 *      "syncApiUrls"? }` (see BrokerHandshake). A mismatch — or anything
 *      that is not that shape — disconnects the socket immediately; the
 *      rejection is logged without the presented token (a wrong guess is
 *      still a secret-shaped value, and logs are a leak channel).
 *   2. On success the broker answers one line `{ "ok": true }` and the
 *      socket then carries the MCP session verbatim: MCP's stdio framing is
 *      NDJSON (one JSON-RPC message per line), so the pipe uses the same
 *      framing and no re-encoding is needed on either side.
 *
 * Every connection gets its own MCP server instance from `createServer`, which
 * receives the whole handshake: the SDK's `McpServer` binds to a single
 * transport at connect time, so one server cannot be shared across sessions,
 * and a session for a named instance must be built for that instance.
 *
 * This module is bundled into the headless MCP server (the forwarder shares
 * the line-framing helpers), so it must stay free of `vscode` imports, and
 * its messages are English literals on purpose.
 */

/**
 * The acknowledgement line the broker sends after a successful handshake. The
 * forwarder treats anything else — or a close before it — as "broker rejected
 * us" and either falls back to the zero-configuration launch (a static launch)
 * or reports the failure and stops (a launch that named an instance, which has
 * no credentials of its own to fall back to serving with).
 */
export const BROKER_HANDSHAKE_OK_LINE = JSON.stringify({ ok: true });

/**
 * Upper bound for the handshake wait: a client that connects but never sends
 * its first line would otherwise pin a session slot (and its socket) forever.
 * Generous, because the forwarder writes the line immediately after connect.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Upper bound for one NDJSON line the pump buffers before giving up on the
 * connection. Without it a local process could connect — no handshake token
 * needed for the buffer to grow — and stream bytes without a newline until
 * the extension host runs out of memory. Legitimate client→host frames
 * (tool call arguments) are kilobytes at most, so 4 MB is far above the real
 * ceiling and far below anything that could hurt the host.
 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Concurrent connection cap for the broker listener. The only legitimate
 * clients are this user's forwarders — a handful at once, one per MCP client
 * session — so 64 leaves ample headroom while keeping a flood of
 * never-handshaking connections from exhausting the host's file descriptors.
 */
const MAX_BROKER_CONNECTIONS = 64;

/** The minimal slice of the SDK's McpServer this module drives. */
export interface BrokerMcpServerLike {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/**
 * What a forwarder's first line must be. `authToken` and `cwd` are required
 * (the token is the gate, the cwd decides which workspace the session is
 * about); the rest is what a launch that knows more than its working directory
 * can add:
 *
 * - `instanceId` — the instance the session was configured for. A definition
 *   the extension provided names exactly one instance, and with several Forgejo
 *   servers in one MCP client, resolving by working directory could hand a
 *   session another instance's account. The broker matches the id against its
 *   own token-bearing instances and refuses the session when there is no match
 *   (the caller reports it; nothing is served under the wrong identity).
 * - `stateFile` — the workspace → repository mapping of the window that
 *   provided the definition, so `get_workspace_repository` answers for *that*
 *   workspace even when a different window owns the broker.
 * - `syncApiUrls` — the per-instance URL-rewriting flag, which exists only in
 *   the editor's settings and would otherwise be lost on this route.
 */
export interface BrokerHandshake {
  authToken: string;
  cwd: string;
  instanceId?: string;
  stateFile?: string;
  syncApiUrls?: boolean;
}

/** One accepted session, as the server factory needs it. */
export interface BrokerSessionRequest {
  /** The MCP client's working directory, already defaulted to the host's own. */
  cwd: string;
  /** The instance the launch named, when it named one (see BrokerHandshake). */
  instanceId?: string | undefined;
  /** The workspace state file the launch wants the session to answer from. */
  stateFile?: string | undefined;
  /** The launch's per-instance URL-sync flag; unset means "use your default". */
  syncApiUrls?: boolean | undefined;
}

export interface StartMcpBrokerOptions {
  /** Where to listen: a `\\.\pipe\…` name on Windows, a unix socket path elsewhere. */
  endpoint: string;
  /** The per-launch handshake secret the forwarder must present. Never logged. */
  authToken: string;
  /** Builds one MCP server per accepted session, from what the handshake carried. */
  createServer(request: BrokerSessionRequest): Promise<BrokerMcpServerLike> | BrokerMcpServerLike;
  /**
   * Debug sink for lifecycle messages (rejections, session close). Optional:
   * the headless forwarder side has no logger worth wiring here.
   */
  log?: (message: string) => void;
  /** Handshake wait budget per connection; defaults to 10 s. Injectable for tests. */
  handshakeTimeoutMs?: number;
}

export interface McpBrokerHandle {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * Rejection used when the socket closes (or errors) while a consumer is still
 * waiting for a line. Distinct from a parse or handshake failure: it simply
 * means the peer went away first, which is the normal shape of a stale-socket
 * probe (connect + immediate destroy) or a client that exits early.
 */
export class LinePumpClosedError extends Error {}

/**
 * The slice of net.Socket the pump drives, kept structural so tests can feed
 * it a plain EventEmitter with a destroy stub.
 */
interface LinePumpSocket {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  destroy(): void;
}

/**
 * Splits a socket's incoming byte stream into NDJSON lines. One pump per
 * connection; the handshake consumes the first line through `nextLine()`,
 * then `setHandler` streams every following line to the transport. Lines
 * received before a consumer is attached are queued, so no message is lost
 * between the handshake read and the transport's `start()`.
 *
 * Bytes are accumulated as a Buffer and only complete lines are decoded:
 * Node's read boundaries are arbitrary byte offsets, so decoding each chunk
 * on arrival would turn a multi-byte UTF-8 character split across two chunks
 * into two replacement characters (U+FFFD) — silent content corruption that
 * JSON.parse would still accept. Splitting happens on the 0x0A byte, which
 * in UTF-8 can only ever be a newline, never part of a multi-byte sequence.
 */
export class LinePump {
  private pending: Buffer = Buffer.alloc(0);
  private queue: string[] = [];
  private waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  private handler: ((line: string) => void) | undefined;
  private failure: Error | undefined;

  constructor(
    private readonly socket: LinePumpSocket,
    private readonly options: {
      /** Bytes one unterminated line may accumulate before the connection is dropped. */
      maxLineBytes?: number;
      /** Reports the oversize drop without any of the buffered data (log channel). */
      log?: (message: string) => void;
    } = {},
  ) {
    socket.on('data', (chunk: Buffer) => this.push(chunk));
    socket.once('close', () => this.fail(new LinePumpClosedError('the socket closed')));
    socket.once('error', (error) => this.fail(error));
  }

  private push(chunk: Buffer): void {
    if (this.failure) {
      return;
    }
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let newline = this.pending.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.pending.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      this.pending = this.pending.subarray(newline + 1);
      this.dispatch(line);
      newline = this.pending.indexOf(0x0a);
    }
    const maxLineBytes = this.options.maxLineBytes ?? MAX_LINE_BYTES;
    if (this.pending.length > maxLineBytes) {
      // No newline after maxLineBytes: either an attack or a broken peer.
      // Destroying without an error surfaces as an ordinary close downstream.
      this.options.log?.('MCP broker: closing a connection whose line exceeded the buffer limit');
      this.socket.destroy();
      this.fail(new LinePumpClosedError('the line buffer limit was exceeded'));
    }
  }

  private dispatch(line: string): void {
    if (this.handler) {
      this.handler(line);
    } else if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(line);
    } else {
      this.queue.push(line);
    }
  }

  /** Settles every pending and future `nextLine()` with the terminal failure. */
  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.reject(error);
    }
  }

  /** The next line, once: used for the handshake before the transport starts. */
  nextLine(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** Streams every line from now on — including anything already queued. */
  setHandler(handler: (line: string) => void): void {
    this.handler = handler;
    for (const line of this.queue.splice(0)) {
      handler(line);
    }
  }
}

/**
 * An MCP `Transport` over a connected socket, one JSON-RPC message per line —
 * the same framing MCP stdio uses, so the forwarder can pass bytes through
 * unchanged. The connection is already open (and the handshake already read)
 * when this is constructed, so `start()` only begins streaming lines to
 * `onmessage`.
 */
export class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly pump: LinePump,
  ) {
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.onclose?.();
      }
    });
    socket.on('error', (error) => this.onerror?.(error));
  }

  start(): Promise<void> {
    this.pump.setHandler((line) => {
      if (!line) {
        return;
      }
      try {
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      } catch (error) {
        // A malformed frame is reported, not fatal: the session stays alive
        // for the messages that do parse (same policy as the SDK's own
        // stdio transport).
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('MCP broker session is closed'));
        return;
      }
      this.socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      // 'close' fires once the socket is fully gone and flips `closed` (and
      // onclose) through the listener installed in the constructor.
      this.socket.on('close', resolve);
      this.socket.destroy();
    });
  }
}

interface BrokerSession {
  socket: net.Socket;
  transport: SocketTransport;
  server?: BrokerMcpServerLike;
}

/**
 * The endpoint a broker of this user should listen on. Windows uses a named
 * pipe whose name carries a short hash of the username and profile path, so
 * two users on one machine (named pipes are machine-global) do not collide
 * with each other by accident. The hash inputs are public information on a
 * shared machine, so this is a collision avoidance, not a squatting defense:
 * a malicious local process that wins the race can occupy the name first and
 * keep the real broker from listening (broker mode then silently degrades to
 * the anonymous launch). It cannot intercept sessions that way, because a
 * window that fails to bind never writes a registration file, and the
 * forwarder only trusts registrations.
 *
 * Other platforms use a unix socket in the temp directory, hashed the same
 * way. It is deliberately NOT inside the extension's globalStorage directory:
 * unix socket paths are limited to roughly 104 characters (sun_path), and the
 * macOS globalStorage path alone (`~/Library/Application Support/…`) comes
 * within a few characters of that limit for any moderately long username —
 * listening there fails with ENAMETOOLONG. The temp dir is short, per-user,
 * and equally discoverable: the forwarder learns the endpoint from the broker
 * registration file, never by guessing its location.
 */
export function defaultBrokerEndpoint(options: {
  platform: NodeJS.Platform;
  username: string;
  homeDir: string;
}): string {
  const userHash = crypto
    .createHash('sha256')
    .update(`${options.username}\n${options.homeDir}`)
    .digest('hex')
    .slice(0, 12);
  if (options.platform === 'win32') {
    return `\\\\.\\pipe\\forgejo-toolkit-mcp-${userHash}`;
  }
  return `${os.tmpdir()}/forgejo-toolkit-mcp-${userHash}.sock`;
}

/**
 * Starts the broker. Rejects with the listen error (EADDRINUSE/EACCES when
 * another window owns the endpoint) so the caller can decide to step aside —
 * see src/mcpBroker.ts, which treats that case as "another window runs the
 * broker" and stays silent.
 *
 * On unix a leftover socket file from a crashed broker also fails the listen
 * with EADDRINUSE, so before giving up the function probes the endpoint: a
 * refused connect means the file is stale and it is unlinked and the listen
 * retried once; a *successful* probe means a live broker owns it and the
 * original error is rethrown. Windows named pipes need no such dance — the
 * kernel object dies with its owning process.
 */
export async function startMcpBroker(options: StartMcpBrokerOptions): Promise<McpBrokerHandle> {
  const sessions = new Set<BrokerSession>();
  const log = options.log ?? (() => undefined);
  const isPipe = options.endpoint.startsWith('\\\\.\\pipe\\');

  const server = net.createServer((socket) => {
    void handleConnection(socket, options, sessions, log);
  });
  server.maxConnections = MAX_BROKER_CONNECTIONS;
  // Listen errors surface as an 'error' event, not through the callback;
  // route them into the startup promise so EADDRINUSE reaches the caller.
  await listenOrProbeStaleSocket(server, options.endpoint);
  // …but the listener must outlive the startup: a server-level error after
  // listen (accept failing on fd exhaustion, say) has no other handler and
  // would otherwise crash the extension host as an uncaught exception.
  server.on('error', (error) => {
    log(`MCP broker: listener error after startup: ${error.message}`);
  });

  // Identity of the socket file this broker created, so close() only unlinks
  // its own file. Without the check a shutdown that overlaps a new broker's
  // stale-file takeover would delete the *new* broker's live socket from
  // under it, leaving it listening on an unlinked inode no client can reach.
  let socketFileId: { dev: number; ino: number } | undefined;
  if (!isPipe) {
    socketFileId = await fs.promises
      .stat(options.endpoint)
      .then((stats) => ({ dev: stats.dev, ino: stats.ino }))
      .catch(() => undefined);
    // The socket file is created with the process umask (often world-accessible
    // on unix). Tighten it to the owner: connect requires write access, and
    // the handshake secret alone should not be enough for another local user.
    await fs.promises.chmod(options.endpoint, 0o600).catch(() => undefined);
  }

  return {
    endpoint: options.endpoint,
    async close(): Promise<void> {
      // Close every session first: server.close() below only stops *new*
      // connections and would otherwise wait for the existing ones forever.
      for (const session of sessions) {
        session.socket.destroy();
      }
      await Promise.all([...sessions].map((session) => session.server?.close().catch(() => undefined)));
      await new Promise<void>((resolve) => {
        // Every existing connection was destroyed above, so the callback
        // fires as soon as their teardown settles. The extra resolve guards
        // the pathological case where close() reports "not running" through
        // the callback on a server whose listen never completed.
        server.close(() => resolve());
        resolve();
      });
      if (!isPipe && socketFileId) {
        await unlinkIfSameFile(options.endpoint, socketFileId);
      }
    },
  };
}

/**
 * Removes a unix socket path only when it is still the file the caller
 * created (same device + inode). A path that vanished or now belongs to a
 * newer broker is left alone. Exported for the unit tests.
 */
export async function unlinkIfSameFile(filePath: string, expected: { dev: number; ino: number }): Promise<void> {
  const stats = await fs.promises.stat(filePath).catch(() => undefined);
  if (!stats || stats.dev !== expected.dev || stats.ino !== expected.ino) {
    return;
  }
  await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
}

/**
 * Listens, and on unix EADDRINUSE distinguishes a live broker (rethrow) from
 * a stale socket file (unlink + retry once).
 */
async function listenOrProbeStaleSocket(server: net.Server, endpoint: string): Promise<void> {
  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  try {
    await listen();
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const isPipe = endpoint.startsWith('\\\\.\\pipe\\');
    if (code !== 'EADDRINUSE' || isPipe) {
      throw error;
    }
  }
  // EADDRINUSE on a unix socket path: live owner or stale file? A connect
  // answers it — a live broker accepts, a stale file refuses.
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (alive) {
    throw Object.assign(new Error(`MCP broker endpoint already in use: ${endpoint}`), { code: 'EADDRINUSE' });
  }
  await fs.promises.rm(endpoint, { force: true }).catch(() => undefined);
  await listen();
}

/**
 * Runs one connection: handshake first, then a dedicated MCP server bound to
 * a SocketTransport. The session is dropped from the tracking set — and its
 * server closed — when the socket goes away, so a dead forwarder never pins
 * its server instance.
 */
async function handleConnection(
  socket: net.Socket,
  options: StartMcpBrokerOptions,
  sessions: Set<BrokerSession>,
  log: (message: string) => void,
): Promise<void> {
  socket.setNoDelay(true);
  const pump = new LinePump(socket, { log });
  const transport = new SocketTransport(socket, pump);
  const session: BrokerSession = { socket, transport };
  sessions.add(session);
  socket.on('close', () => {
    sessions.delete(session);
    // The SDK's server.close() closes its transport; the socket is already
    // gone, so this only releases the protocol state.
    void session.server?.close().catch(() => undefined);
  });

  const handshakeTimeout = setTimeout(() => {
    log('MCP broker: closing a connection that never completed its handshake');
    socket.destroy();
  }, options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  let handshakeLine: string;
  try {
    handshakeLine = await pump.nextLine();
  } catch (error) {
    // The socket closed or errored before the first line — the normal shape
    // of a stale-socket probe or a client that exited early, not an attack
    // worth a louder log.
    if (!(error instanceof LinePumpClosedError)) {
      log(
        `MCP broker: connection failed before its handshake: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  } finally {
    clearTimeout(handshakeTimeout);
  }
  if (socket.destroyed) {
    return;
  }

  let handshake: {
    authToken?: unknown;
    cwd?: unknown;
    instanceId?: unknown;
    stateFile?: unknown;
    syncApiUrls?: unknown;
  };
  try {
    handshake = JSON.parse(handshakeLine) as typeof handshake;
  } catch {
    log('MCP broker: rejected a connection whose first line was not JSON');
    socket.destroy();
    return;
  }
  // Constant-time compare, and only after the length check: the token is the
  // gate that keeps a random local process from driving authenticated
  // requests through the extension host. The presented value is never logged.
  const presented = typeof handshake.authToken === 'string' ? handshake.authToken : '';
  const expected = Buffer.from(options.authToken, 'utf8');
  const given = Buffer.from(presented, 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    log('MCP broker: rejected a connection with a mismatched handshake token');
    socket.destroy();
    return;
  }
  const cwd = typeof handshake.cwd === 'string' && handshake.cwd ? handshake.cwd : process.cwd();
  // Identity fields are read structurally and only when they are the right
  // type: this file is not a trust boundary in the same sense as the
  // registration (the handshake already proved the peer), but a malformed
  // field must mean "not provided", never a crash inside the host.
  const instanceId =
    typeof handshake.instanceId === 'string' && handshake.instanceId ? handshake.instanceId : undefined;
  const stateFile = typeof handshake.stateFile === 'string' && handshake.stateFile ? handshake.stateFile : undefined;
  const syncApiUrls = typeof handshake.syncApiUrls === 'boolean' ? handshake.syncApiUrls : undefined;

  let mcpServer: BrokerMcpServerLike;
  try {
    mcpServer = await options.createServer({ cwd, instanceId, stateFile, syncApiUrls });
  } catch (error) {
    // Instance resolution failed (e.g. no token-bearing instance). The
    // forwarder then falls back to its anonymous zero-configuration launch,
    // which is the same surface it would have had without the broker.
    log(`MCP broker: could not create a session server: ${error instanceof Error ? error.message : String(error)}`);
    socket.destroy();
    return;
  }
  if (socket.destroyed) {
    // The client left while createServer ran (it can spawn a git scan). The
    // 'close' handler already dropped the session and closed nothing — the
    // server was not assigned yet — so close it here or it leaks, pinned by
    // an SDK that will never see a transport close.
    await mcpServer.close().catch(() => undefined);
    return;
  }
  session.server = mcpServer;
  // Acknowledge before the session starts, so the forwarder can tell
  // "handshake rejected" (close) from "authenticated" (this line) and only
  // fall back in the former case.
  socket.write(`${BROKER_HANDSHAKE_OK_LINE}\n`);
  try {
    await mcpServer.connect(transport);
  } catch (error) {
    log(`MCP broker: session connect failed: ${error instanceof Error ? error.message : String(error)}`);
    socket.destroy();
  }
}
