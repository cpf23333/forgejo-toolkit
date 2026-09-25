import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { McpWorkspaceStateFile } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import type { ConfigManager } from '../config';
import type { Logger } from '../logger';
import type { DetectLinkedRepositoriesResult } from '../worktree/gitOperations';

// The writer tests stub detection outright: which repositories link to which
// instance is gitOperations' own (heavily tested) concern; here only the
// mapping into the state file matters.
vi.mock('../worktree/gitOperations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worktree/gitOperations')>();
  return { ...actual, detectLinkedRepositories: vi.fn() };
});

import { detectLinkedRepositories } from '../worktree/gitOperations';
import {
  buildWorkspaceStatePayload,
  cleanupMcpWorkspaceState,
  mcpWorkspaceStateFilePath,
  registerMcpWorkspaceStateSync,
  writeMcpWorkspaceState,
} from '../mcpWorkspaceState';

const detectMock = vi.mocked(detectLinkedRepositories);

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
    localPath: '/workspace/demo-repo',
    remoteUrl: 'https://forgejo.example.com/demo-user/demo-repo.git',
    ...overrides,
  };
}

describe('buildWorkspaceStatePayload', () => {
  it('maps every linked repository and marks only the attributed one active', () => {
    const instances = [makeInstance(), makeInstance({ id: 'instance-2', url: 'https://other.example.com' })];
    const first = makeRepo();
    const second = makeRepo({ instanceId: 'instance-2', owner: 'org', repo: 'lib', localPath: '/workspace/lib' });
    const detected: DetectLinkedRepositoriesResult = { linked: second, all: [first, second], unpublished: [] };

    const payload = buildWorkspaceStatePayload(instances, detected);

    expect(typeof payload.updatedAt).toBe('string');
    expect(payload.repositories).toHaveLength(2);
    expect(payload.repositories[0]).toMatchObject({
      instanceId: 'instance-1',
      instanceUrl: 'https://forgejo.example.com',
      owner: 'demo-user',
      repo: 'demo-repo',
      localPath: '/workspace/demo-repo',
      active: false,
    });
    expect(payload.repositories[1]).toMatchObject({ instanceId: 'instance-2', active: true });
  });

  it('strips credential userinfo from the instance URL', () => {
    // The MCP child matches this value against its own instance URL and the
    // file must never carry credentials; the usable (stripped) form is both.
    const instances = [makeInstance({ url: 'https://token-abc123@forgejo.example.com' })];
    const detected: DetectLinkedRepositoriesResult = { linked: undefined, all: [makeRepo()], unpublished: [] };

    const payload = buildWorkspaceStatePayload(instances, detected);

    expect(payload.repositories[0].instanceUrl).toBe('https://forgejo.example.com/');
  });

  it('drops repositories whose instance disappeared between detection and mapping', () => {
    const detected: DetectLinkedRepositoriesResult = {
      linked: undefined,
      all: [makeRepo({ instanceId: 'removed-instance' })],
      unpublished: [],
    };

    const payload = buildWorkspaceStatePayload([], detected);

    expect(payload.repositories).toEqual([]);
  });
});

describe('writeMcpWorkspaceState', () => {
  let tempDir: string;
  let stateFilePath: string;
  const logger = { debug: vi.fn() } as unknown as Logger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-state-test-'));
    stateFilePath = path.join(tempDir, 'state', `mcp-workspace-${process.pid}.json`);
    detectMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function configWith(instances: ForgejoInstance[]): ConfigManager {
    return { getInstances: () => instances } as unknown as ConfigManager;
  }

  it('writes the detected mapping, creating the globalStorage directory', async () => {
    const instances = [makeInstance()];
    const repo = makeRepo();
    detectMock.mockResolvedValue({ linked: repo, all: [repo], unpublished: [] });

    await writeMcpWorkspaceState(stateFilePath, configWith(instances), logger);

    const written = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as McpWorkspaceStateFile;
    expect(written.repositories).toHaveLength(1);
    expect(written.repositories[0]).toMatchObject({ owner: 'demo-user', repo: 'demo-repo', active: true });
    // The file is the contract with the MCP child: no credential may reach it.
    expect(fs.readFileSync(stateFilePath, 'utf8')).not.toContain('secret-token');
  });

  it('writes an empty mapping when nothing is linked, so the child can tell it apart from a missing file', async () => {
    detectMock.mockResolvedValue({ linked: undefined, all: [], unpublished: [] });

    await writeMcpWorkspaceState(stateFilePath, configWith([makeInstance()]), logger);

    const written = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as McpWorkspaceStateFile;
    expect(written.repositories).toEqual([]);
  });

  it('logs and swallows a detection failure instead of propagating it', async () => {
    // The mapping is advisory; a failed write must never break the feature
    // that triggered it (editor switch, workspace change).
    detectMock.mockRejectedValue(new Error('git exploded'));

    await expect(writeMcpWorkspaceState(stateFilePath, configWith([makeInstance()]), logger)).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('git exploded'));
    expect(fs.existsSync(stateFilePath)).toBe(false);
  });
});

describe('cleanupMcpWorkspaceState', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-state-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes the state file registered for this window', async () => {
    const context = {
      subscriptions: [] as { dispose(): unknown }[],
      globalStorageUri: { fsPath: tempDir },
    } as unknown as vscode.ExtensionContext;
    const config = {
      getInstances: () => [],
      onInstancesChanged: () => ({ dispose: vi.fn() }),
    } as unknown as ConfigManager;
    const logger = { debug: vi.fn() } as unknown as Logger;
    registerMcpWorkspaceStateSync(context, config, logger);
    const stateFilePath = mcpWorkspaceStateFilePath(context);
    expect(stateFilePath).toBe(path.join(tempDir, `mcp-workspace-${process.pid}.json`));
    fs.writeFileSync(stateFilePath, '{}', 'utf8');

    await cleanupMcpWorkspaceState(logger);

    expect(fs.existsSync(stateFilePath)).toBe(false);
    // A second cleanup is a no-op: the path is forgotten with the first.
    await expect(cleanupMcpWorkspaceState(logger)).resolves.toBeUndefined();
  });
});
