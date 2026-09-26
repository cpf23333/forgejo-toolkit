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

import { detectLinkedRepositories } from '../worktree/gitOperations';
import { cleanupMcpBroker, mcpBrokerFilePath, resolveBrokerInstance, startMcpBrokerIfFirst } from '../mcpBroker';

const detectMock = vi.mocked(detectLinkedRepositories);

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
