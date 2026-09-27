import * as net from 'net';
import type { Readable, Writable } from 'stream';
import { BROKER_HANDSHAKE_OK_LINE } from './brokerServer';

/**
 * The forwarder half of the broker mode (the broker half is
 * mcp/brokerServer.ts, driven by src/mcpBroker.ts inside the extension host).
 *
 * An MCP server launched from a static `mcp.json` has no token; the broker in
 * the extension host does. The same is true of a definition the extension
 * itself provided: since stage 2 it deliberately carries no token either (the
 * editor persists definitions in cleartext workspace storage), so it forwards
 * for the same reason. This module connects to the broker's local
 * endpoint, proves "same local user" with the per-launch handshake secret
 * from `mcp-broker.json`, states which instance and workspace the session is
 * for when the launch knows, and then bridges byte streams: stdin → socket →
 * stdout. Because MCP's stdio framing is NDJSON and the broker uses the same
 * framing on the socket, the bridge is a verbatim pipe — no JSON is parsed or
 * re-encoded here after the handshake, so the forwarder stays a dumb relay
 * and every protocol concern (tools, errors, truncation) lives in exactly one
 * place: the extension host.
 *
 * Failure split, consumed by server.ts:
 *
 * - `BrokerUnavailableError` — anything before the handshake acknowledgement:
 *   no listener, connect refused, malformed/ignored handshake, timeout. The
 *   caller falls back to the zero-configuration launch, so a missing broker
 *   degrades to the anonymous read-only server instead of breaking startup.
 * - `BrokerSessionError` — the socket errored *after* the session started.
 *   Falling back then would silently restart an in-flight session as a
 *   different (anonymous) server, so this is fatal: the caller exits with a
 *   clear message and the MCP client reports the server as stopped.
 *
 * The authToken is sent once and never logged.
 */

export class BrokerUnavailableError extends Error {}

export class BrokerSessionError extends Error {}

export interface ForwardToBrokerOptions {
  endpoint: string;
  authToken: string;
  cwd: string;
  /**
   * The instance this session is for, when the launch knows it. A launch the
   * extension provided always does (its definition names one instance); a
   * static `mcp.json` launch does not, and the broker then resolves the
   * instance from the session's working directory as before. Not a secret:
   * the broker has the instance list and the token, the forwarder merely says
   * which entry it was asked for.
   */
  instanceId?: string | undefined;
  /**
   * The workspace → repository state file the extension host computed for the
   * window that provided this definition. Forwarded so `get_workspace_repository`
   * answers for that window even when a different window owns the broker.
   * Absent for a static launch, where the broker's own window file is right.
   */
  stateFile?: string | undefined;
  /**
   * The per-instance "rewrite API URLs to the instance URL" flag. The broker
   * cannot read the extension's settings, so a definition's flag has to travel
   * with the session; a static launch leaves it unset and the broker's default
   * applies.
   */
  syncApiUrls?: boolean | undefined;
  /** Defaults to process.stdin / process.stdout; injectable for tests. */
  input?: Readable;
  output?: Writable;
  /** Handshake acknowledgement wait; defaults to 10 s. */
  handshakeTimeoutMs?: number;
  /**
   * Socket factory; injectable so tests can drive socket-level errors that a
   * real local connection never produces on demand (the error-layer split
   * between BrokerUnavailableError and BrokerSessionError).
   */
  connect?: (endpoint: string) => net.Socket;
}

export interface ForwardResult {
  /** 'input-ended': the MCP client closed stdin; 'broker-closed': the host went away. */
  reason: 'input-ended' | 'broker-closed';
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Bytes the broker's acknowledgement line may occupy before the attempt is
 * failed. The real line is 11 bytes; a peer that streams without a newline is
 * not our broker, and an unbounded buffer would let it grow the process's
 * memory at will.
 */
const MAX_HANDSHAKE_BYTES = 64 * 1024;

export function forwardToBroker(options: ForwardToBrokerOptions): Promise<ForwardResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const socket = (options.connect ?? ((endpoint: string) => net.connect(endpoint)))(options.endpoint);
    // The session phase starts on the acknowledgement line; before it, every
    // failure is a BrokerUnavailableError, after it a BrokerSessionError.
    let acknowledged = false;
    let settled = false;
    let inputEnded = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      // The acknowledgement timer must not outlive the attempt: a pending
      // timer would keep the process alive after the caller already fell
      // back to the zero-configuration launch.
      clearTimeout(handshakeTimeout);
      socket.destroy();
      reject(error);
    };
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.unpipe(socket);
      resolve({ reason: inputEnded ? 'input-ended' : 'broker-closed' });
    };

    const handshakeTimeout = setTimeout(() => {
      fail(new BrokerUnavailableError('the extension-host broker did not answer the handshake in time'));
    }, timeoutMs);

    // The broker's first line is the handshake acknowledgement; only after
    // it does the socket carry MCP traffic. Bytes of the first session frame
    // can share a chunk with that line, so the remainder of the chunk is
    // forwarded manually before the plain pipe takes over. Bytes accumulate
    // undecoded — Node's read boundaries can split a multi-byte UTF-8
    // character, and decoding per chunk would corrupt it into U+FFFD pairs.
    let handshakeBuffer: Buffer = Buffer.alloc(0);
    const onHandshakeData = (chunk: Buffer): void => {
      handshakeBuffer = handshakeBuffer.length === 0 ? chunk : Buffer.concat([handshakeBuffer, chunk]);
      const newline = handshakeBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (handshakeBuffer.length > MAX_HANDSHAKE_BYTES) {
          fail(new BrokerUnavailableError('the extension-host broker sent an oversized handshake response'));
        }
        return;
      }
      clearTimeout(handshakeTimeout);
      socket.removeListener('data', onHandshakeData);
      const line = handshakeBuffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      if (line !== BROKER_HANDSHAKE_OK_LINE) {
        fail(new BrokerUnavailableError('the extension-host broker rejected the handshake'));
        return;
      }
      acknowledged = true;
      const remainder = handshakeBuffer.subarray(newline + 1);
      if (remainder.length > 0) {
        output.write(remainder);
      }
      // stdin EOF half-closes the socket: the broker ends that session while
      // its pending responses can still flush back before its own close.
      input.on('end', () => {
        inputEnded = true;
      });
      input.pipe(socket);
      socket.pipe(output);
    };

    socket.on('data', onHandshakeData);
    socket.once('connect', () => {
      // Identity fields are omitted rather than sent as undefined: the broker
      // treats "absent" and "empty" the same way, but a payload that only ever
      // carries real values is easier to reason about on the wire, and the
      // handshake line is logged nowhere.
      socket.write(
        `${JSON.stringify({
          authToken: options.authToken,
          cwd: options.cwd,
          ...(options.instanceId ? { instanceId: options.instanceId } : {}),
          ...(options.stateFile ? { stateFile: options.stateFile } : {}),
          ...(options.syncApiUrls === undefined ? {} : { syncApiUrls: options.syncApiUrls }),
        })}\n`,
      );
    });
    socket.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (acknowledged && code === 'ECONNRESET') {
        // A broker that closes its end of a unix socket surfaces as
        // ECONNRESET here when unread data was still in flight (Windows named
        // pipes report an orderly close instead). Mid-session this is exactly
        // "the broker went away", not a transport failure — take the same
        // broker-closed path as a clean close.
        finish();
        return;
      }
      if (acknowledged) {
        fail(new BrokerSessionError(`the connection to the extension-host broker errored: ${error.message}`));
      } else {
        fail(new BrokerUnavailableError(`cannot reach the extension-host broker: ${error.message}`));
      }
    });
    socket.on('close', () => {
      if (!acknowledged && !settled) {
        clearTimeout(handshakeTimeout);
        fail(new BrokerUnavailableError('the extension-host broker closed the connection during the handshake'));
        return;
      }
      if (acknowledged) {
        finish();
      }
    });
  });
}
