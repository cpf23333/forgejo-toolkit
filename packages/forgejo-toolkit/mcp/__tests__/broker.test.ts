import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { ForgejoClient } from '../../src/api/client';
import { startMockServer, stopMockServer, resetMockServer } from '../../src/test/mocks/server';
import { createMcpServer } from '../mcpServer';
import {
  defaultBrokerEndpoint,
  LinePump,
  LinePumpClosedError,
  startMcpBroker,
  unlinkIfSameFile,
  type McpBrokerHandle,
} from '../brokerServer';
import { BrokerSessionError, BrokerUnavailableError, forwardToBroker } from '../brokerForwarder';

// These tests intentionally run over real sockets, not InMemoryTransport: the
// feature under test *is* the bridging (handshake, NDJSON framing, session
// lifecycle), which an in-memory pair would bypass entirely.

const isWindows = process.platform === 'win32';

/** A unique endpoint per test, so parallel vitest files can never collide. */
function testEndpoint(): string {
  const suffix = crypto.randomBytes(6).toString('hex');
  if (isWindows) {
    return `\\\\.\\pipe\\forgejo-toolkit-mcp-test-${suffix}`;
  }
  return path.join(os.tmpdir(), `forgejo-toolkit-mcp-test-${suffix}.sock`);
}

const TEST_TOKEN = crypto.randomBytes(32).toString('hex');

interface ForwarderHarness {
  input: PassThrough;
  output: PassThrough;
  done: Promise<unknown>;
  /** Resolves with the parsed JSON-RPC message carrying the given id. */
  waitForMessage(id: number): Promise<Record<string, unknown>>;
}

/**
 * Starts a forwarder over in-memory stdio streams and returns a line reader
 * for its output side.
 */
function startForwarder(endpoint: string, authToken: string): ForwarderHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = pending.get(message.id as number);
      if (waiter) {
        pending.delete(message.id as number);
        waiter(message);
      }
      newline = buffer.indexOf('\n');
    }
  });
  const done = forwardToBroker({ endpoint, authToken, cwd: process.cwd(), input, output });
  return {
    input,
    output,
    done,
    waitForMessage: (id) =>
      new Promise((resolve) => {
        pending.set(id, resolve);
      }),
  };
}

/** Sends the initialize handshake plus the initialized notification. */
async function initializeSession(harness: ForwarderHarness): Promise<void> {
  const initialized = harness.waitForMessage(1);
  harness.input.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    })}\n`,
  );
  const response = await initialized;
  expect(response.result).toBeTruthy();
  harness.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}

describe('MCP broker over real sockets', () => {
  let broker: McpBrokerHandle | undefined;
  let endpoint: string;

  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(async () => {
    resetMockServer();
    await broker?.close();
    broker = undefined;
  });

  async function startRealBroker(): Promise<void> {
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
    });
  }

  it('rejects a wrong handshake token and the forwarder reports BrokerUnavailableError', async () => {
    const logs: string[] = [];
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
      log: (message) => logs.push(message),
    });
    const presented = 'wrong-token-that-must-not-leak-into-logs';
    await expect(forwardToBroker({ endpoint, authToken: presented, cwd: process.cwd() })).rejects.toBeInstanceOf(
      BrokerUnavailableError,
    );
    // The rejection is logged, but never with the presented value: a wrong
    // guess is still a secret-shaped value and logs are a leak channel.
    expect(logs.some((message) => message.includes('mismatched handshake token'))).toBe(true);
    expect(logs.join('\n')).not.toContain(presented);
  });

  it('rejects a non-JSON first line', async () => {
    await startRealBroker();
    const socket = net.connect(endpoint);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('this is not json\n');
    await new Promise<void>((resolve) => socket.once('close', resolve));
    // The socket is destroyed without the acknowledgement ever arriving.
    expect(socket.destroyed).toBe(true);
  });

  it('reports BrokerUnavailableError when nothing listens at the endpoint', async () => {
    await expect(
      forwardToBroker({ endpoint: testEndpoint(), authToken: TEST_TOKEN, cwd: process.cwd() }),
    ).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('round-trips initialize and tools/list end to end through the forwarder', async () => {
    await startRealBroker();
    const harness = startForwarder(endpoint, TEST_TOKEN);
    await initializeSession(harness);
    const listed = harness.waitForMessage(2);
    harness.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const response = await listed;
    const tools = (response.result as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toContain('list_issues');
    harness.input.end();
    await expect(harness.done).resolves.toEqual({ reason: 'input-ended' });
  });

  it('serves several sessions in parallel, each with its own server instance', async () => {
    const created: string[] = [];
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: (session) => {
        created.push(session.cwd);
        return createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
      },
    });
    const first = startForwarder(endpoint, TEST_TOKEN);
    const second = startForwarder(endpoint, TEST_TOKEN);
    await Promise.all([initializeSession(first), initializeSession(second)]);
    expect(created).toHaveLength(2);
    first.input.end();
    second.input.end();
    await Promise.all([first.done, second.done]);
  });

  it('resolves the forwarder with broker-closed when the broker shuts down mid-session', async () => {
    await startRealBroker();
    const harness = startForwarder(endpoint, TEST_TOKEN);
    await initializeSession(harness);
    const live = broker;
    broker = undefined; // ownership moves to this test, so afterEach does not double-close
    await live?.close();
    await expect(harness.done).resolves.toEqual({ reason: 'broker-closed' });
  });

  it('drops a connection that never completes its handshake after the timeout', async () => {
    const logs: string[] = [];
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
      log: (message) => logs.push(message),
      handshakeTimeoutMs: 150,
    });
    const socket = net.connect(endpoint);
    await new Promise<void>((resolve) => socket.once('close', resolve));
    expect(logs.some((message) => message.includes('never completed its handshake'))).toBe(true);
  });

  it('does not log the handshake timeout for a probe that connects and leaves', async () => {
    // The stale-socket probe of another starting window is exactly this
    // shape: connect, learn the broker is alive, destroy. It must neither
    // trip the timeout warning nor leak a pending handshake wait.
    const logs: string[] = [];
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
      log: (message) => logs.push(message),
      handshakeTimeoutMs: 150,
    });
    const probe = net.connect(endpoint);
    await new Promise<void>((resolve) => probe.once('connect', resolve));
    probe.destroy();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(logs.some((message) => message.includes('never completed its handshake'))).toBe(false);
  });

  it('passes the launch identity fields on to the session factory', async () => {
    // This is the wire the extension-provided route depends on: the definition
    // carries no token, so *which* instance the session is for has to survive
    // the handshake (state file and URL-sync flag likewise). The static route
    // sends only authToken + cwd, which must keep working as before.
    const requests: unknown[] = [];
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: (request) => {
        requests.push(request);
        return createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
      },
    });

    const socket = net.connect(endpoint);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      `${JSON.stringify({
        authToken: TEST_TOKEN,
        cwd: 'C:\\proj',
        instanceId: 'instance-7',
        stateFile: 'C:\\state\\mcp-workspace-1-abc.json',
        syncApiUrls: false,
      })}\n`,
    );
    let ack = Buffer.alloc(0);
    while (!ack.includes(0x0a)) {
      ack = Buffer.concat([ack, await new Promise<Buffer>((resolve) => socket.once('data', resolve))]);
    }
    expect(ack.subarray(0, ack.indexOf(0x0a)).toString('utf8')).toBe('{"ok":true}');
    expect(requests).toEqual([
      {
        cwd: 'C:\\proj',
        instanceId: 'instance-7',
        stateFile: 'C:\\state\\mcp-workspace-1-abc.json',
        syncApiUrls: false,
      },
    ]);
    socket.destroy();
  });

  it('treats a malformed identity field as absent instead of failing the session', async () => {
    const requests: unknown[] = [];
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: (request) => {
        requests.push(request);
        return createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
      },
    });

    const socket = net.connect(endpoint);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    // A different extension version, or a hand-crafted line: the handshake has
    // already authorized the peer, so the wrong type must mean "not provided"
    // rather than an exception inside the extension host.
    socket.write(`${JSON.stringify({ authToken: TEST_TOKEN, cwd: '', instanceId: 7, syncApiUrls: 'no' })}\n`);
    let ack = Buffer.alloc(0);
    while (!ack.includes(0x0a)) {
      ack = Buffer.concat([ack, await new Promise<Buffer>((resolve) => socket.once('data', resolve))]);
    }
    expect(ack.subarray(0, ack.indexOf(0x0a)).toString('utf8')).toBe('{"ok":true}');
    expect(requests).toEqual([
      { cwd: process.cwd(), instanceId: undefined, stateFile: undefined, syncApiUrls: undefined },
    ]);
    socket.destroy();
  });

  it('accepts a handshake whose multi-byte cwd arrives split across chunks', async () => {
    // Node's read boundaries are byte offsets: the 3-byte characters of a
    // non-ASCII cwd (an ordinary Windows user profile path) land in two
    // chunks. Per-chunk decoding would corrupt them into U+FFFD and the
    // broker would resolve the session against a garbled directory.
    const cwd = 'C:\\Users\\用户\\proj';
    const seen: string[] = [];
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: (session) => {
        seen.push(session.cwd);
        return createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
      },
    });
    const socket = net.connect(endpoint);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    const handshake = Buffer.from(`${JSON.stringify({ authToken: TEST_TOKEN, cwd })}\n`, 'utf8');
    // Split one byte into 用's 3-byte sequence: the boundary case per-chunk
    // decoding would corrupt.
    const split = handshake.indexOf(Buffer.from('用', 'utf8')) + 1;
    socket.write(handshake.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.write(handshake.subarray(split));
    let ack = Buffer.alloc(0);
    while (!ack.includes(0x0a)) {
      ack = Buffer.concat([ack, await new Promise<Buffer>((resolve) => socket.once('data', resolve))]);
    }
    expect(ack.subarray(0, ack.indexOf(0x0a)).toString('utf8')).toBe('{"ok":true}');
    expect(seen).toEqual([cwd]);
    socket.destroy();
  });

  it('drops a connection whose first line never terminates within the buffer limit', async () => {
    const logs: string[] = [];
    endpoint = testEndpoint();
    broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
      log: (message) => logs.push(message),
    });
    const socket = net.connect(endpoint);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    // 5 MB without a newline: past the 4 MB line budget. The connection must
    // die instead of the buffer growing until the host runs out of memory.
    socket.on('error', () => undefined); // a reset on the way down is expected
    const flood = Buffer.alloc(5 * 1024 * 1024, 0x61);
    socket.write(flood);
    await new Promise<void>((resolve) => socket.once('close', resolve));
    expect(logs.some((message) => message.includes('buffer limit'))).toBe(true);
  });
});

describe('unix socket file lifecycle', () => {
  const isUnix = process.platform !== 'win32';

  it.skipIf(!isUnix)('unlinks a stale socket file and listens anyway', async () => {
    const endpoint = testEndpoint();
    await fs.promises.writeFile(endpoint, 'leftover from a crashed broker');
    const broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
    });
    // Listening replaced the stale file with a real socket.
    const stats = await fs.promises.stat(endpoint);
    expect(stats.isSocket()).toBe(true);
    await broker.close();
  });

  it.skipIf(!isUnix)('rethrows EADDRINUSE when a live broker owns the endpoint', async () => {
    const endpoint = testEndpoint();
    const first = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
    });
    await expect(
      startMcpBroker({
        endpoint,
        authToken: TEST_TOKEN,
        createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await first.close();
  });

  it.skipIf(!isUnix)('removes its own socket file on close', async () => {
    const endpoint = testEndpoint();
    const broker = await startMcpBroker({
      endpoint,
      authToken: TEST_TOKEN,
      createServer: () => createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token')),
    });
    await broker.close();
    await expect(fs.promises.stat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!isUnix)('unlinkIfSameFile leaves a successor broker’s socket alone', async () => {
    // The close-time guard against the takeover race: broker A recorded the
    // inode it created; by the time A closes, broker B already replaced the
    // path. A must not unlink B's live socket.
    const endpoint = testEndpoint();
    await fs.promises.writeFile(endpoint, 'A');
    const aId = await fs.promises.stat(endpoint).then((stats) => ({ dev: stats.dev, ino: stats.ino }));
    await fs.promises.rm(endpoint);
    await fs.promises.writeFile(endpoint, 'B');
    await unlinkIfSameFile(endpoint, aId);
    expect(await fs.promises.readFile(endpoint, 'utf8')).toBe('B');
    const bId = await fs.promises.stat(endpoint).then((stats) => ({ dev: stats.dev, ino: stats.ino }));
    await unlinkIfSameFile(endpoint, bId);
    await expect(fs.promises.stat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('LinePump', () => {
  /** A minimal socket stand-in: an EventEmitter with a destroy stub. */
  function fakeSocket(): { socket: net.Socket; emitted: EventEmitter } {
    const emitted = new EventEmitter();
    const socket = emitted as unknown as net.Socket;
    socket.destroy = vi.fn(() => {
      queueMicrotask(() => emitted.emit('close'));
      return socket;
    }) as unknown as net.Socket['destroy'];
    return { socket, emitted };
  }

  it('assembles a line split across chunks', async () => {
    const { socket, emitted } = fakeSocket();
    const pump = new LinePump(socket);
    const line = pump.nextLine();
    emitted.emit('data', Buffer.from('hel'));
    emitted.emit('data', Buffer.from('lo\n'));
    await expect(line).resolves.toBe('hello');
  });

  it('streams several lines from one chunk in order', () => {
    const { socket, emitted } = fakeSocket();
    const pump = new LinePump(socket);
    const lines: string[] = [];
    pump.setHandler((line) => lines.push(line));
    emitted.emit('data', Buffer.from('a\nb\nc\n'));
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('decodes a multi-byte character split across chunks intact', async () => {
    const { socket, emitted } = fakeSocket();
    const pump = new LinePump(socket);
    const line = pump.nextLine();
    const bytes = Buffer.from('用户\n', 'utf8'); // 3 bytes per character
    emitted.emit('data', bytes.subarray(0, 2)); // inside 用
    emitted.emit('data', bytes.subarray(2));
    await expect(line).resolves.toBe('用户');
  });

  it('rejects a pending nextLine when the socket closes first', async () => {
    const { socket, emitted } = fakeSocket();
    const pump = new LinePump(socket);
    const line = pump.nextLine();
    line.catch(() => undefined); // settle the rejection before the assert
    emitted.emit('close');
    await expect(line).rejects.toBeInstanceOf(LinePumpClosedError);
    // …and a wait started after the close rejects immediately too.
    await expect(pump.nextLine()).rejects.toBeInstanceOf(LinePumpClosedError);
  });

  it('destroys the socket when one line outgrows the buffer limit', async () => {
    const { socket, emitted } = fakeSocket();
    const logs: string[] = [];
    const pump = new LinePump(socket, { maxLineBytes: 8, log: (message) => logs.push(message) });
    const line = pump.nextLine();
    line.catch(() => undefined);
    emitted.emit('data', Buffer.alloc(16, 0x61));
    expect(socket.destroy).toHaveBeenCalled();
    expect(logs.some((message) => message.includes('buffer limit'))).toBe(true);
    await expect(line).rejects.toBeInstanceOf(LinePumpClosedError);
  });
});

describe('forwardToBroker error layers', () => {
  interface FakeBrokerSocket {
    socket: net.Socket;
    /** Bytes the forwarder wrote (the handshake); the readable side stays broker-owned. */
    writes: Buffer[];
    /** Feeds bytes as if the broker sent them. */
    send(data: string | Buffer): void;
  }

  /**
   * A duplex stand-in for the broker connection. `write` is captured instead
   * of looping back (a plain PassThrough would echo the forwarder's own
   * handshake into its input side), and 'connect' is fired on the next tick
   * like a real socket.
   */
  function fakeBrokerSocket(): FakeBrokerSocket {
    const stream = new PassThrough();
    const writes: Buffer[] = [];
    const socket = stream as unknown as net.Socket;
    socket.write = ((chunk: string | Buffer, encodingOrCallback?: unknown, callback?: unknown) => {
      writes.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(
              chunk,
              typeof encodingOrCallback === 'string' ? (encodingOrCallback as BufferEncoding) : 'utf8',
            ),
      );
      const done = (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback) as
        | (() => void)
        | undefined;
      done?.();
      return true;
    }) as unknown as net.Socket['write'];
    queueMicrotask(() => stream.emit('connect'));
    return { socket, writes, send: (data) => stream.push(data) };
  }

  const baseOptions = { endpoint: 'unused', authToken: TEST_TOKEN, cwd: process.cwd() };

  it('maps a pre-ack socket error to BrokerUnavailableError', async () => {
    const fake = fakeBrokerSocket();
    const attempt = forwardToBroker({
      ...baseOptions,
      connect: () => fake.socket,
      input: new PassThrough(),
      output: new PassThrough(),
    });
    fake.socket.emit('error', Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }));
    await expect(attempt).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('maps a post-ack socket error to BrokerSessionError, never a fallback', async () => {
    const fake = fakeBrokerSocket();
    const attempt = forwardToBroker({
      ...baseOptions,
      connect: () => fake.socket,
      input: new PassThrough(),
      output: new PassThrough(),
    });
    fake.send(`${JSON.stringify({ ok: true })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    fake.socket.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    await expect(attempt).rejects.toBeInstanceOf(BrokerSessionError);
  });

  it('treats a post-ack ECONNRESET as the broker closing, not an error', async () => {
    const fake = fakeBrokerSocket();
    const attempt = forwardToBroker({
      ...baseOptions,
      connect: () => fake.socket,
      input: new PassThrough(),
      output: new PassThrough(),
    });
    fake.send(`${JSON.stringify({ ok: true })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    fake.socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await expect(attempt).resolves.toEqual({ reason: 'broker-closed' });
  });

  it('fails an oversized handshake response instead of buffering forever', async () => {
    const fake = fakeBrokerSocket();
    const attempt = forwardToBroker({
      ...baseOptions,
      connect: () => fake.socket,
      input: new PassThrough(),
      output: new PassThrough(),
    });
    attempt.catch(() => undefined);
    fake.send(Buffer.alloc(65 * 1024, 0x61)); // 65 KB, no newline
    await expect(attempt).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('forwards the ack chunk’s remainder bytes verbatim, multibyte splits included', async () => {
    const fake = fakeBrokerSocket();
    const output = new PassThrough();
    const received: Buffer[] = [];
    output.on('data', (chunk: Buffer) => received.push(chunk));
    const attempt = forwardToBroker({ ...baseOptions, connect: () => fake.socket, input: new PassThrough(), output });
    attempt.catch(() => undefined);
    const frame = Buffer.from('{"jsonrpc":"2.0","note":"用户"}\n', 'utf8');
    // The first session frame shares the ack's chunk; its tail — split inside
    // a 3-byte character — arrives in the next one.
    fake.send(Buffer.concat([Buffer.from('{"ok":true}\n'), frame.subarray(0, 20)]));
    await new Promise((resolve) => setImmediate(resolve));
    fake.send(frame.subarray(20));
    await new Promise((resolve) => setImmediate(resolve));
    expect(Buffer.concat(received)).toEqual(frame);
    fake.socket.destroy();
    await expect(attempt).resolves.toEqual({ reason: 'broker-closed' });
  });
});

describe('defaultBrokerEndpoint', () => {
  it('hashes the user into the pipe name on Windows', () => {
    const endpoint = defaultBrokerEndpoint({
      platform: 'win32',
      username: 'demo-user',
      homeDir: 'C:\\Users\\demo-user',
    });
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\forgejo-toolkit-mcp-[0-9a-f]{12}$/);
  });

  it('uses a short hashed socket path in the temp dir elsewhere (sun_path limit)', () => {
    const endpoint = defaultBrokerEndpoint({
      platform: 'linux',
      username: 'demo-user',
      homeDir: '/home/demo-user',
    });
    expect(endpoint).toMatch(/forgejo-toolkit-mcp-[0-9a-f]{12}\.sock$/);
    // The macOS globalStorage path alone approaches the ~104-char sun_path
    // limit for any moderately long username; the endpoint must stay short.
    expect(endpoint.length).toBeLessThan(80);
    expect(endpoint).not.toContain('globalStorage');
  });
});
