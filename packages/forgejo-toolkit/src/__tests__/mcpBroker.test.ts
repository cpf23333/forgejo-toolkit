import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { McpBrokerRegistryFile } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ConfigManager } from '../config';
import type { Logger } from '../logger';

// Instance detection is stubbed outright: which checkout links to which
// instance is gitOperations' own (heavily tested) concern; here only the
// broker's wiring — file lifecycle, contention, instance pick — matters.
vi.mock('../worktree/gitOperations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worktree/gitOperations')>();
  return { ...actual, detectLinkedRepositories: vi.fn() };
});

// startMcpBroker is mockable for the same reason: most tests want the real
// listener, but the EACCES classification and the cleanup-during-startup race
// cannot be produced on demand with a real one. The default implementation
// stays the real function; individual tests override it.
const brokerServerActual = vi.hoisted(() => ({
  actual: undefined as unknown as typeof import('../../mcp/brokerServer'),
}));
vi.mock('../../mcp/brokerServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp/brokerServer')>();
  brokerServerActual.actual = actual;
  return { ...actual, startMcpBroker: vi.fn(actual.startMcpBroker) };
});

import { detectLinkedRepositories } from '../worktree/gitOperations';
import { startMcpBroker, type BrokerSessionRequest, type StartMcpBrokerOptions } from '../../mcp/brokerServer';
import {
  BROKER_TAKEOVER_POLL_MS,
  cleanupMcpBroker,
  findBrokerStateMatch,
  mcpBrokerFilePath,
  resolveBrokerInstance,
  startMcpBrokerIfFirst,
} from '../mcpBroker';

const detectMock = vi.mocked(detectLinkedRepositories);
const startMock = vi.mocked(startMcpBroker);

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), error: vi.fn(), isDebugEnabled: () => false } as unknown as Logger;
}

function makeInstance(overrides: Partial<ForgejoInstance> = {}): ForgejoInstance {
  return {
    id: 'instance-1',
    url: 'https://forgejo.example.com',
    token: 'secret-token',
    name: 'Example',
    username: 'demo-user',
    ...overrides,
  };
}

function makeRepo(overrides: Partial<LinkedRepository> = {}): LinkedRepository {
  return {
    instanceId: 'instance-1',
    owner: 'demo-user',
    repo: 'demo-repo',
    localPath: path.join(os.tmpdir(), 'demo-repo'),
    ...overrides,
  } as LinkedRepository;
}

let storageDir: string;
let context: vscode.ExtensionContext;
let logger: Logger;

function makeContext(dir: string): vscode.ExtensionContext {
  return {
    globalStorageUri: { fsPath: dir },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

/** A per-run endpoint that cannot collide with the production broker: the
 * default endpoint is a hash of the user profile, so a test on a machine
 * whose VS Code already hosts a broker must use its own name. */
function uniqueEndpoint(): string {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\forgejo-toolkit-mcp-test-${suffix}`
    : path.join(os.tmpdir(), `forgejo-toolkit-mcp-test-${suffix}.sock`);
}

beforeEach(async () => {
  storageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-broker-test-'));
  context = makeContext(storageDir);
  logger = makeLogger();
  detectMock.mockResolvedValue({ linked: undefined, all: [], unpublished: [] });
  startMock.mockImplementation(brokerServerActual.actual.startMcpBroker);
});

afterEach(async () => {
  await cleanupMcpBroker(logger);
  await fs.promises.rm(storageDir, { recursive: true, force: true });
});

describe('startMcpBrokerIfFirst', () => {
  it('writes the registration file and cleanup removes it', async () => {
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    const endpoint = uniqueEndpoint();
    await startMcpBrokerIfFirst(context, config, logger, { endpoint });

    const filePath = mcpBrokerFilePath(context);
    const payload = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as McpBrokerRegistryFile;
    expect(payload.version).toBe(1);
    expect(payload.pid).toBe(process.pid);
    expect(payload.endpoint).toBe(endpoint);
    // 32 random bytes as hex; per-launch, never a Forgejo token.
    expect(payload.authToken).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof payload.startedAt).toBe('string');

    await cleanupMcpBroker(logger);
    await expect(fs.promises.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('steps aside silently when the endpoint is already owned', async () => {
    // Occupy the endpoint with a plain listener, standing in for another
    // window's broker.
    const endpoint = uniqueEndpoint();
    if (process.platform !== 'win32') {
      await fs.promises.mkdir(path.dirname(endpoint), { recursive: true });
    }
    const squatter = net.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(endpoint, () => resolve());
    });
    try {
      const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
      await startMcpBrokerIfFirst(context, config, logger, { endpoint });
      // No registration write, no throw, and the reason was logged at debug.
      await expect(fs.promises.stat(mcpBrokerFilePath(context))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('another window'));
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it('cleanup without a started broker is a no-op and touches no file', async () => {
    // Another window's registration must survive this window's cleanup.
    const filePath = mcpBrokerFilePath(context);
    await fs.promises.writeFile(filePath, '{}', 'utf8');
    await cleanupMcpBroker(logger);
    expect(await fs.promises.readFile(filePath, 'utf8')).toBe('{}');
  });

  it.skipIf(process.platform === 'win32')('writes the registration owner-only', async () => {
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    await startMcpBrokerIfFirst(context, config, logger, { endpoint: uniqueEndpoint() });
    // The file carries the handshake secret, so it must not inherit the
    // process umask's world-readable default.
    const stats = await fs.promises.stat(mcpBrokerFilePath(context));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('logs EACCES as a real failure instead of stepping aside', async () => {
    // EACCES means a local permission problem (unwritable temp dir, another
    // user's leftover socket), not "another window owns the endpoint" — it
    // must surface at info level, not vanish into a debug log.
    startMock.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    await startMcpBrokerIfFirst(context, config, logger, { endpoint: uniqueEndpoint() });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('another window'));
    await expect(fs.promises.stat(mcpBrokerFilePath(context))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a cleanup during startup still stops the broker that arrives late', async () => {
    let resolveStart!: (handle: { endpoint: string; close: () => Promise<void> }) => void;
    const gate = new Promise<{ endpoint: string; close: () => Promise<void> }>((resolve) => {
      resolveStart = resolve;
    });
    startMock.mockReturnValue(gate);
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    const handle = { endpoint: 'unused', close: vi.fn().mockResolvedValue(undefined) };
    const startup = startMcpBrokerIfFirst(context, config, logger, { endpoint: uniqueEndpoint() });
    const cleanup = cleanupMcpBroker(logger);
    resolveStart(handle);
    await Promise.all([startup, cleanup]);
    // The late handle was closed by its own startup, and nothing registered.
    expect(handle.close).toHaveBeenCalled();
    await expect(fs.promises.stat(mcpBrokerFilePath(context))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('findBrokerStateMatch', () => {
  /** Writes a per-window state file into the test's globalStorage stand-in. */
  async function writeStateFile(name: string, repositories: Record<string, unknown>[]): Promise<string> {
    const filePath = path.join(storageDir, name);
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ updatedAt: new Date().toISOString(), repositories }),
      'utf8',
    );
    return filePath;
  }

  it('picks the state file whose published checkout contains the session cwd', async () => {
    // One broker serves the whole machine; a session can belong to another
    // window's workspace, and it must get that window's state file.
    const checkout = path.join(storageDir, 'other-window-repo');
    const filePath = await writeStateFile('mcp-workspace-111-aaa11111.json', [
      {
        instanceId: 'instance-2',
        instanceUrl: 'https://forgejo.example.com',
        owner: 'demo-user',
        repo: 'other-window-repo',
        localPath: checkout,
        active: false,
      },
    ]);
    const match = await findBrokerStateMatch(context, path.join(checkout, 'src'));
    expect(match?.stateFile).toBe(filePath);
    expect(match?.instanceId).toBe('instance-2');
  });

  it('matches the checkout root itself, not only its children', async () => {
    const checkout = path.join(storageDir, 'repo');
    const filePath = await writeStateFile('mcp-workspace-111-aaa11111.json', [
      { instanceId: 'instance-1', localPath: checkout },
    ]);
    const match = await findBrokerStateMatch(context, checkout);
    expect(match?.stateFile).toBe(filePath);
  });

  it('prefers the nested checkout when one contains the other', async () => {
    const outer = path.join(storageDir, 'mono');
    const inner = path.join(outer, 'nested');
    await writeStateFile('mcp-workspace-111-aaa11111.json', [{ instanceId: 'instance-1', localPath: outer }]);
    const innerFile = await writeStateFile('mcp-workspace-222-bbb22222.json', [
      { instanceId: 'instance-2', localPath: inner },
    ]);
    const match = await findBrokerStateMatch(context, path.join(inner, 'src'));
    expect(match?.stateFile).toBe(innerFile);
    expect(match?.instanceId).toBe('instance-2');
  });

  it('answers undefined when no published checkout contains the cwd', async () => {
    await writeStateFile('mcp-workspace-111-aaa11111.json', [
      { instanceId: 'instance-1', localPath: path.join(storageDir, 'repo') },
    ]);
    expect(await findBrokerStateMatch(context, os.homedir())).toBeUndefined();
  });

  it('ignores files that are not parseable state files', async () => {
    await fs.promises.writeFile(path.join(storageDir, 'mcp-workspace-broken.json'), 'not json', 'utf8');
    await fs.promises.writeFile(path.join(storageDir, 'unrelated.json'), '{}', 'utf8');
    expect(await findBrokerStateMatch(context, storageDir)).toBeUndefined();
  });
});

describe('resolveBrokerInstance', () => {
  it('picks the instance whose linked checkout contains the session cwd', async () => {
    const checkout = path.join(os.tmpdir(), 'demo-repo');
    detectMock.mockResolvedValue({
      linked: undefined,
      all: [makeRepo({ instanceId: 'instance-2', localPath: checkout })],
      unpublished: [],
    });
    const instances = [makeInstance({ id: 'instance-1' }), makeInstance({ id: 'instance-2', name: 'Other' })];
    const picked = await resolveBrokerInstance(path.join(checkout, 'src'), instances, logger);
    expect(picked?.id).toBe('instance-2');
  });

  it('matches the checkout root exactly, not only its children', async () => {
    const checkout = path.join(os.tmpdir(), 'demo-repo');
    detectMock.mockResolvedValue({
      linked: undefined,
      all: [makeRepo({ instanceId: 'instance-2', localPath: checkout })],
      unpublished: [],
    });
    const instances = [makeInstance({ id: 'instance-1' }), makeInstance({ id: 'instance-2', name: 'Other' })];
    const picked = await resolveBrokerInstance(checkout, instances, logger);
    expect(picked?.id).toBe('instance-2');
  });

  it('falls back to the first token-bearing instance when the cwd matches nothing', async () => {
    // The Agents window launches servers from the user's home directory,
    // which is no checkout at all — detection finds nothing.
    detectMock.mockResolvedValue({ linked: undefined, all: [], unpublished: [] });
    const instances = [makeInstance({ id: 'tokenless', token: '' }), makeInstance({ id: 'instance-1' })];
    const picked = await resolveBrokerInstance(os.homedir(), instances, logger);
    expect(picked?.id).toBe('instance-1');
  });

  it('prefers a token-bearing fallback over a detected instance without a token', async () => {
    const checkout = path.join(os.tmpdir(), 'demo-repo');
    detectMock.mockResolvedValue({
      linked: undefined,
      all: [makeRepo({ instanceId: 'tokenless', localPath: checkout })],
      unpublished: [],
    });
    const instances = [makeInstance({ id: 'tokenless', token: '' }), makeInstance({ id: 'instance-1' })];
    const picked = await resolveBrokerInstance(checkout, instances, logger);
    expect(picked?.id).toBe('instance-1');
  });

  it('answers undefined when no instance has a token at all', async () => {
    detectMock.mockResolvedValue({ linked: undefined, all: [], unpublished: [] });
    const picked = await resolveBrokerInstance(os.homedir(), [makeInstance({ token: '' })], logger);
    expect(picked).toBeUndefined();
  });
});

/**
 * The authenticated route for a definition the extension provided (§11.1
 * stage-2 follow-up). Those definitions no longer carry a token, so the
 * instance they were created for travels in the handshake and the broker has
 * to resolve *that* instance against its own token-bearing list.
 *
 * The session factory is captured through the real `startMcpBroker` entry
 * point, which is how production reaches it, and driven with the handshake
 * shape `mcp/brokerForwarder.ts` writes.
 */
describe('broker sessions that name an instance', () => {
  /** Starts the broker (with a mocked listener) and returns its session factory. */
  async function captureSessionFactory(
    config: ConfigManager,
  ): Promise<(session: BrokerSessionRequest) => Promise<{ close(): Promise<void> }>> {
    let factory: ((session: BrokerSessionRequest) => Promise<{ close(): Promise<void> }>) | undefined;
    startMock.mockImplementation((options: StartMcpBrokerOptions) => {
      const captured = options.createServer;
      factory = async (session) => captured(session) as Promise<{ close(): Promise<void> }>;
      return Promise.resolve({ endpoint: options.endpoint, close: () => Promise.resolve() });
    });
    await startMcpBrokerIfFirst(context, config, logger, { endpoint: uniqueEndpoint() });
    if (!factory) {
      throw new Error('the broker was expected to start');
    }
    return factory;
  }

  it('uses the instance the launch named, even when the cwd says otherwise', async () => {
    // The whole reason the id is in the handshake: with two instances, cwd
    // matching would hand this session the *other* account's credentials.
    detectMock.mockResolvedValue({ linked: undefined, all: [], unpublished: [] });
    const config = {
      getInstances: () => [
        makeInstance(),
        makeInstance({ id: 'instance-2', url: 'https://other.example.com', token: 'second-token', name: 'Other' }),
      ],
    } as unknown as ConfigManager;
    const factory = await captureSessionFactory(config);

    const server = await factory({ cwd: os.homedir(), instanceId: 'instance-2' });
    await server.close();
    // instance-1 is first in the list and would win any cwd fallback; the
    // resolved client is the one for instance-2, so detection never ran.
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('explicit instance id'));
    expect(detectMock).not.toHaveBeenCalled();
  });

  it('honours the launch’s URL-sync flag instead of the resolved instance’s default', async () => {
    const config = {
      getInstances: () => [makeInstance({ syncApiUrlsToInstanceUrl: true })],
    } as unknown as ConfigManager;
    const factory = await captureSessionFactory(config);

    // The flag lives in the editor's settings, which the broker owner can also
    // read through its own config — but the launch's value is the one that
    // must win, and `createMcpServer` is what carries it into the client.
    const server = await factory({ cwd: os.homedir(), instanceId: 'instance-1', syncApiUrls: false });
    await server.close();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('explicit instance id'));
  });

  it('refuses the session when the named instance has no usable token here', async () => {
    // Reached when the window that provided the definition removed the
    // instance (or its token) after VS Code resolved the server. Serving a
    // different instance would be the silent-wrong-account failure this whole
    // route exists to avoid, so the broker refuses and the forwarder reports
    // it instead of degrading.
    const config = { getInstances: () => [makeInstance({ token: '' })] } as unknown as ConfigManager;
    const factory = await captureSessionFactory(config);

    await expect(factory({ cwd: os.homedir(), instanceId: 'instance-1' })).rejects.toThrow(/instance-1/);
  });

  it('still resolves a session with no instance id by working directory, as a static launch needs', async () => {
    const checkout = path.join(os.tmpdir(), 'demo-repo');
    detectMock.mockResolvedValue({
      linked: undefined,
      all: [makeRepo({ instanceId: 'instance-2', localPath: checkout })],
      unpublished: [],
    });
    const config = {
      getInstances: () => [makeInstance(), makeInstance({ id: 'instance-2', name: 'Other' })],
    } as unknown as ConfigManager;
    const factory = await captureSessionFactory(config);

    const server = await factory({ cwd: checkout });
    await server.close();
    expect(detectMock).toHaveBeenCalled();
  });
});

/** The listen error another window's broker produces, verbatim enough. */
function endpointInUse(): Error {
  return Object.assign(new Error('MCP broker endpoint already in use'), { code: 'EADDRINUSE' });
}

/** Stands in for another window's broker holding the endpoint. */
async function occupyEndpoint(endpoint: string): Promise<net.Server> {
  if (process.platform !== 'win32') {
    await fs.promises.mkdir(path.dirname(endpoint), { recursive: true });
  }
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
  return server;
}

async function releaseEndpoint(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** True when something is listening on the endpoint right now. */
function endpointIsLive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

/** The registration another window (or a crashed one) left behind. */
async function writeRegistration(pid: number, endpoint: string, authToken: string): Promise<void> {
  const payload: McpBrokerRegistryFile = {
    version: 1,
    pid,
    endpoint,
    authToken,
    startedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(mcpBrokerFilePath(context), JSON.stringify(payload, null, 2), 'utf8');
}

function registrationExists(): boolean {
  return fs.existsSync(mcpBrokerFilePath(context));
}

/** How many "listening" lines a window's logger has seen. */
function listeningLines(target: Logger): number {
  return vi.mocked(target.info).mock.calls.filter((call) => String(call[0]).startsWith('MCP broker listening at'))
    .length;
}

/**
 * Advances the fake interval timer by one takeover tick. Only `setInterval` is
 * faked in this block, so `setTimeout` (and Date.now) stay real — which is what
 * flushUntil below needs.
 */
async function tickTakeoverWatcher(): Promise<void> {
  await vi.advanceTimersByTimeAsync(BROKER_TAKEOVER_POLL_MS);
}

/**
 * Waits (on real timers) for a positive outcome the watcher produces through
 * real I/O — the registration read and the listen are not fake-timer work.
 */
async function flushUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the broker takeover watcher');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Gives a tick's real file read time to land before a negative assertion. */
async function drainRealIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('automatic broker takeover', () => {
  beforeEach(() => {
    // Only the interval is faked: the takeover tick's reads and listens are
    // real I/O that a fake timer cannot stand in for, and flushUntil needs a
    // real setTimeout to wait on it.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the endpoint over from a cleanly closed owner and re-registers', async () => {
    // The owner window shut down cleanly, so `deactivate()` removed the
    // registration file — the file being gone is the whole signal.
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    const endpoint = uniqueEndpoint();
    const owner = await occupyEndpoint(endpoint);
    try {
      await startMcpBrokerIfFirst(context, config, logger, { endpoint });
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('another window'));
      expect(registrationExists()).toBe(false);

      await releaseEndpoint(owner);
      await tickTakeoverWatcher();
      await flushUntil(() => listeningLines(logger) === 1);
    } finally {
      // Idempotent: a failed assertion must not leave the squatter behind.
      await releaseEndpoint(owner).catch(() => undefined);
    }

    // The post-bind path ran unchanged: this window's live pid is published
    // and the takeover is logged at info level like any first bind.
    const payload = JSON.parse(await fs.promises.readFile(mcpBrokerFilePath(context), 'utf8')) as McpBrokerRegistryFile;
    expect(payload.version).toBe(1);
    expect(payload.pid).toBe(process.pid);
    expect(payload.endpoint).toBe(endpoint);
    expect(payload.authToken).toMatch(/^[0-9a-f]{64}$/);
    // …and the endpoint really is this window's listener now, which is what
    // the static shim's forwarder connects to.
    expect(await endpointIsLive(endpoint)).toBe(true);
  });

  it('takes the endpoint over after the owner was killed, with its dead pid left in the file', async () => {
    // A crash leaves the registration behind. The pid in it is verifiably
    // dead, which is the second signal that the owner is gone.
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(child.pid).toBeGreaterThan(0);
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    const endpoint = uniqueEndpoint();
    // The initial listen is the contended one; the takeover attempt uses the
    // real listener.
    startMock.mockRejectedValueOnce(endpointInUse());
    await startMcpBrokerIfFirst(context, config, logger, { endpoint });
    await writeRegistration(child.pid as number, endpoint, 'crashed-owner-token');

    await tickTakeoverWatcher();
    await flushUntil(() => listeningLines(logger) === 1);

    expect(startMock).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(await fs.promises.readFile(mcpBrokerFilePath(context), 'utf8')) as McpBrokerRegistryFile;
    expect(payload.pid).toBe(process.pid);
    expect(payload.authToken).not.toBe('crashed-owner-token');
  });

  it('stays stepped aside while the recorded owner pid is alive', async () => {
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    const endpoint = uniqueEndpoint();
    startMock.mockRejectedValueOnce(endpointInUse());
    await startMcpBrokerIfFirst(context, config, logger, { endpoint });
    // This test process's own pid stands in for the live owner window; its
    // registration must survive untouched.
    await writeRegistration(process.pid, endpoint, 'live-owner-token');

    await tickTakeoverWatcher();
    await tickTakeoverWatcher();
    await drainRealIo();

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(listeningLines(logger)).toBe(0);
    const payload = JSON.parse(await fs.promises.readFile(mcpBrokerFilePath(context), 'utf8')) as McpBrokerRegistryFile;
    expect(payload.authToken).toBe('live-owner-token');
    expect(payload.pid).toBe(process.pid);

    // Positive control: the very same watcher binds as soon as the owner is
    // really gone, so the assertions above proved "stayed aside", not "stopped
    // watching" (which is what an absent watcher would also look like).
    await fs.promises.rm(mcpBrokerFilePath(context), { force: true });
    await tickTakeoverWatcher();
    await flushUntil(() => listeningLines(logger) === 1);
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it('keeps watching when another window wins the race for the freed endpoint', async () => {
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    const endpoint = uniqueEndpoint();
    startMock.mockRejectedValueOnce(endpointInUse());
    await startMcpBrokerIfFirst(context, config, logger, { endpoint });
    expect(registrationExists()).toBe(false);

    // No registration says the owner is gone, so this window listens — and
    // loses to a window whose listen landed first. Binding is the arbiter, so
    // EADDRINUSE here only means "not me": still stepped aside, still watching.
    startMock.mockRejectedValueOnce(endpointInUse());
    await tickTakeoverWatcher();
    await drainRealIo();

    expect(startMock).toHaveBeenCalledTimes(2);
    expect(listeningLines(logger)).toBe(0);
    expect(registrationExists()).toBe(false);

    // The winner is gone too; the next tick binds for real.
    await tickTakeoverWatcher();
    await flushUntil(() => listeningLines(logger) === 1);

    expect(startMock).toHaveBeenCalledTimes(3);
    const payload = JSON.parse(await fs.promises.readFile(mcpBrokerFilePath(context), 'utf8')) as McpBrokerRegistryFile;
    expect(payload.pid).toBe(process.pid);
  });

  it('two stepped-aside windows race: exactly one binds, the other keeps watching', async () => {
    const endpoint = uniqueEndpoint();
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    const owner = await occupyEndpoint(endpoint);
    // Two windows of one profile: the same globalStorage and endpoint, but two
    // independent module instances, each with its own watcher state.
    vi.resetModules();
    const serverA = await import('../../mcp/brokerServer');
    const windowA = await import('../mcpBroker');
    vi.resetModules();
    const serverB = await import('../../mcp/brokerServer');
    const windowB = await import('../mcpBroker');
    const startA = vi.mocked(serverA.startMcpBroker);
    const startB = vi.mocked(serverB.startMcpBroker);
    const loggerA = makeLogger();
    const loggerB = makeLogger();
    startA.mockRejectedValueOnce(endpointInUse());
    startB.mockRejectedValueOnce(endpointInUse());
    try {
      await windowA.startMcpBrokerIfFirst(context, config, loggerA, { endpoint });
      await windowB.startMcpBrokerIfFirst(context, config, loggerB, { endpoint });
      expect(registrationExists()).toBe(false);

      await releaseEndpoint(owner);
      // One tick: both watchers fire, both read "no owner", both listen, and
      // exactly one of the two binds.
      await tickTakeoverWatcher();
      await flushUntil(() => listeningLines(loggerA) + listeningLines(loggerB) === 1);
      await drainRealIo();
      expect(listeningLines(loggerA) + listeningLines(loggerB)).toBe(1);

      const aWon = listeningLines(loggerA) === 1;
      const winner = aWon ? windowA : windowB;
      const winnerLogger = aWon ? loggerA : loggerB;
      const loser = aWon ? windowB : windowA;
      const loserLogger = aWon ? loggerB : loggerA;
      const loserStart = aWon ? startB : startA;
      const loserAttempts = loserStart.mock.calls.length;

      // The winner closes (a window the user shut): registration removed, pipe
      // released. The loser is still watching, so it binds itself.
      await winner.cleanupMcpBroker(winnerLogger);
      expect(registrationExists()).toBe(false);
      await tickTakeoverWatcher();
      await flushUntil(() => listeningLines(loserLogger) === 1);

      expect(loserStart.mock.calls.length).toBeGreaterThan(loserAttempts);
      const payload = JSON.parse(
        await fs.promises.readFile(mcpBrokerFilePath(context), 'utf8'),
      ) as McpBrokerRegistryFile;
      expect(payload.pid).toBe(process.pid);
      expect(payload.endpoint).toBe(endpoint);
      await loser.cleanupMcpBroker(loserLogger);
    } finally {
      await releaseEndpoint(owner).catch(() => undefined);
      await windowA.cleanupMcpBroker(loggerA).catch(() => undefined);
      await windowB.cleanupMcpBroker(loggerB).catch(() => undefined);
    }
  });

  it('clears the watcher when the MCP surface is disposed (mcpEnabled turned off)', async () => {
    // Turning the setting off disposes the surface, which calls
    // cleanupMcpBroker — the same path deactivate() uses.
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    const endpoint = uniqueEndpoint();
    startMock.mockRejectedValueOnce(endpointInUse());
    await startMcpBrokerIfFirst(context, config, logger, { endpoint });

    await cleanupMcpBroker(logger);
    await tickTakeoverWatcher();
    await drainRealIo();

    // No second attempt, so no broker bound behind the disabled surface.
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(registrationExists()).toBe(false);
    expect(await endpointIsLive(endpoint)).toBe(false);

    // Positive control: the setting turned back on binds again, so the silence
    // above was the cleared watcher and not an absent mechanism.
    startMock.mockRejectedValueOnce(endpointInUse());
    await startMcpBrokerIfFirst(context, config, logger, { endpoint });
    await tickTakeoverWatcher();
    await flushUntil(() => listeningLines(logger) === 1);
    expect(startMock).toHaveBeenCalledTimes(3);
  });

  it('deactivate() clears the watcher: no timer is left behind', async () => {
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    startMock.mockRejectedValueOnce(endpointInUse());
    const endpoint = uniqueEndpoint();
    await startMcpBrokerIfFirst(context, config, logger, { endpoint });
    expect(vi.getTimerCount()).toBe(1);

    // `deactivate()` in src/extension.ts is exactly this call — the timer must
    // be gone, not merely harmless, or reloading windows would accumulate
    // watchers.
    await cleanupMcpBroker(logger);
    expect(vi.getTimerCount()).toBe(0);
    await tickTakeoverWatcher();
    await drainRealIo();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(registrationExists()).toBe(false);
  });
});

describe('broker takeover watcher lifecycle', () => {
  it("unref's the takeover timer so it can never keep a window alive", async () => {
    // Real timers here: `hasRef()` is a Node Timeout method, and the point is
    // exactly that the timer does not hold the event loop open.
    const config = { getInstances: () => [makeInstance()] } as unknown as ConfigManager;
    startMock.mockRejectedValueOnce(endpointInUse());
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      await startMcpBrokerIfFirst(context, config, logger, { endpoint: uniqueEndpoint() });
      const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout | undefined;
      expect(timer).toBeDefined();
      expect(timer?.hasRef()).toBe(false);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
