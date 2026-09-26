import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { ForgejoClient } from '../../src/api/client';
import { startMockServer, stopMockServer, resetMockServer } from '../../src/test/mocks/server';
import { createMcpServer } from '../mcpServer';
import { defaultBrokerEndpoint, startMcpBroker, type McpBrokerHandle } from '../brokerServer';
import { BrokerUnavailableError, forwardToBroker } from '../brokerForwarder';

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
    await startRealBroker();
    await expect(forwardToBroker({ endpoint, authToken: 'wrong', cwd: process.cwd() })).rejects.toBeInstanceOf(
      BrokerUnavailableError,
    );
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
      createServer: (cwd) => {
        created.push(cwd);
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
});

describe('defaultBrokerEndpoint', () => {
  it('hashes the user into the pipe name on Windows', () => {
    const endpoint = defaultBrokerEndpoint({
      platform: 'win32',
      username: 'demo-user',
      homeDir: 'C:\\Users\\demo-user',
      socketDir: 'unused',
    });
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\forgejo-toolkit-mcp-[0-9a-f]{12}$/);
  });

  it('uses a short hashed socket path in the temp dir elsewhere (sun_path limit)', () => {
    const endpoint = defaultBrokerEndpoint({
      platform: 'linux',
      username: 'demo-user',
      homeDir: '/home/demo-user',
      socketDir: '/home/demo-user/.config/Code/User/globalStorage/cpf23333.forgejo-toolkit',
    });
    expect(endpoint).toMatch(/forgejo-toolkit-mcp-[0-9a-f]{12}\.sock$/);
    // The macOS globalStorage path alone approaches the ~104-char sun_path
    // limit for any moderately long username; the endpoint must stay short.
    expect(endpoint.length).toBeLessThan(80);
    expect(endpoint).not.toContain('globalStorage');
  });
});
