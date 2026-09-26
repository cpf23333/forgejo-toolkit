import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { startMcpBroker } from '../../mcp/brokerServer';
import {
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
