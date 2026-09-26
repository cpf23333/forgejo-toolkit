import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * The extension-host MCP broker: a local listener that runs the real tool
 * logic (with the instance token) inside the extension host process, so an
 * MCP server launched from a static `mcp.json` can be a pure stdio forwarder
 * and the token never crosses the extension boundary (consumer of this side:
 * src/mcpBroker.ts; the forwarder half lives in mcp/brokerForwarder.ts).
 *
 * Wire protocol per connection:
 *
 *   1. The forwarder's first line must be the JSON handshake
 *      `{ "authToken": string, "cwd": string }`. A mismatch — or anything
 *      that is not that shape — disconnects the socket immediately; the
 *      rejection is logged without the presented token (a wrong guess is
 *      still a secret-shaped value, and logs are a leak channel).
 *   2. On success the broker answers one line `{ "ok": true }` and the
 *      socket then carries the MCP session verbatim: MCP's stdio framing is
 *      NDJSON (one JSON-RPC message per line), so the pipe uses the same
 *      framing and no re-encoding is needed on either side.
 *
 * Every connection gets its own MCP server instance from `createServer(cwd)`:
 * the SDK's `McpServer` binds to a single transport at connect time, so one
 * server cannot be shared across sessions.
 *
 * This module is bundled into the headless MCP server (the forwarder shares
 * the line-framing helpers), so it must stay free of `vscode` imports, and
 * its messages are English literals on purpose.
 */

/**
 * The acknowledgement line the broker sends after a successful handshake.
 * The forwarder treats anything else — or a close before it — as "broker
 * rejected us" and falls back to the zero-configuration launch.
 */
export const BROKER_HANDSHAKE_OK_LINE = JSON.stringify({ ok: true });

/**
 * Upper bound for the handshake wait: a client that connects but never sends
 * its first line would otherwise pin a session slot (and its socket) forever.
 * Generous, because the forwarder writes the line immediately after connect.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The minimal slice of the SDK's McpServer this module drives. */
export interface BrokerMcpServerLike {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface StartMcpBrokerOptions {
  /** Where to listen: a `\\.\pipe\…` name on Windows, a unix socket path elsewhere. */
  endpoint: string;
  /** The per-launch handshake secret the forwarder must present. Never logged. */
  authToken: string;
  /** Builds one MCP server per accepted session, bound to the client's cwd. */
  createServer(cwd: string): Promise<BrokerMcpServerLike> | BrokerMcpServerLike;
  /**
   * Debug sink for lifecycle messages (rejections, session close). Optional:
   * the headless forwarder side has no logger worth wiring here.
   */
  log?: (message: string) => void;
}

export interface McpBrokerHandle {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * Splits a socket's incoming byte stream into NDJSON lines. One pump per
 * connection; the handshake consumes the first line through `nextLine()`,
 * then `setHandler` streams every following line to the transport. Lines
 * received before a consumer is attached are queued, so no message is lost
 * between the handshake read and the transport's `start()`.
 */
class LinePump {
  private pending = '';
  private queue: string[] = [];
  private waiter: ((line: string) => void) | undefined;
  private handler: ((line: string) => void) | undefined;

  constructor(socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.push(chunk.toString('utf8')));
  }

  private push(text: string): void {
    this.pending += text;
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      this.dispatch(line);
      newline = this.pending.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    if (this.handler) {
      this.handler(line);
    } else if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(line);
    } else {
      this.queue.push(line);
    }
  }

  /** The next line, once: used for the handshake before the transport starts. */
  nextLine(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
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
 * two users on one machine (named pipes are machine-global) can never collide
 * — or squat on each other's broker.
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
  /** The extension's globalStorage directory; only used off-Windows. */
  socketDir: string;
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

  const server = net.createServer((socket) => {
    void handleConnection(socket, options, sessions, log);
  });
  // Listen errors surface as an 'error' event, not through the callback;
  // route them into the startup promise so EADDRINUSE reaches the caller.
  await listenOrProbeStaleSocket(server, options.endpoint);

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
      if (!options.endpoint.startsWith('\\\\.\\pipe\\')) {
        // The socket file is ours alone (created by listen, per-platform in
        // globalStorage); remove it so the next broker does not take the
        // stale-file probe path.
        await fs.promises.rm(options.endpoint, { force: true }).catch(() => undefined);
      }
    },
  };
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
  const pump = new LinePump(socket);
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
  }, HANDSHAKE_TIMEOUT_MS);
  let handshakeLine: string;
  try {
    handshakeLine = await pump.nextLine();
  } finally {
    clearTimeout(handshakeTimeout);
  }
  if (socket.destroyed) {
    return;
  }

  let handshake: { authToken?: unknown; cwd?: unknown };
  try {
    handshake = JSON.parse(handshakeLine) as { authToken?: unknown; cwd?: unknown };
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

  let mcpServer: BrokerMcpServerLike;
  try {
    mcpServer = await options.createServer(cwd);
  } catch (error) {
    // Instance resolution failed (e.g. no token-bearing instance). The
    // forwarder then falls back to its anonymous zero-configuration launch,
    // which is the same surface it would have had without the broker.
    log(`MCP broker: could not create a session server: ${error instanceof Error ? error.message : String(error)}`);
    socket.destroy();
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
