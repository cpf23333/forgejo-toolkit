import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type {
  McpInstanceRegistryFile,
  McpWorkspaceStateFile,
} from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
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
  buildInstanceRegistryPayload,
  buildMcpServerShimContent,
  buildWorkspaceStatePayload,
  cleanupMcpWorkspaceState,
  mcpInstanceRegistryFilePath,
  mcpServerShimFilePath,
  mcpWorkspaceStateFilePath,
  registerMcpWorkspaceStateSync,
  writeMcpInstanceRegistry,
  writeMcpServerShim,
  whenMcpStateWritesSettled,
  writeMcpWorkspaceState,
} from '../mcpWorkspaceState';

const detectMock = vi.mocked(detectLinkedRepositories);

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn() } as unknown as Logger;
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
    localPath: '/workspace/demo-repo',
    remoteUrl: 'https://forgejo.example.com/demo-user/demo-repo.git',
    ...overrides,
  };
}

/** Points the mocked active editor at a path (undefined: no editor open). */
function setActiveEditor(fsPath: string | undefined): void {
  (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = fsPath
    ? { document: { uri: { fsPath } } }
    : undefined;
}

/**
 * Polls a condition in real time. A `setImmediate` spin does not work here:
 * the fs work behind a promise chain completes in real milliseconds while the
 * spin burns through its rounds in microseconds without yielding real time.
 */
async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('until() timed out waiting for the expected effect');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Let the continuations behind the observed effect settle.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

afterEach(() => {
  setActiveEditor(undefined);
  vi.useRealTimers();
});

describe('buildWorkspaceStatePayload', () => {
  it('maps every linked repository and marks the verified active one', () => {
    const instances = [makeInstance(), makeInstance({ id: 'instance-2', url: 'https://other.example.com' })];
    const first = makeRepo();
    const second = makeRepo({ instanceId: 'instance-2', owner: 'org', repo: 'lib', localPath: '/workspace/lib' });
    const detected: DetectLinkedRepositoriesResult = { linked: second, all: [first, second], unpublished: [] };
    // With more than one match, the flag follows the editor: it is set only
    // because the active editor verifiably sits inside the attributed repo.
    setActiveEditor('/workspace/lib/src/index.ts');

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

  it('marks the single linked repository active without needing the editor', () => {
    // One match is unambiguous on its own: there is nothing else the user
    // could be looking at.
    const repo = makeRepo();
    const detected: DetectLinkedRepositoriesResult = { linked: repo, all: [repo], unpublished: [] };

    const payload = buildWorkspaceStatePayload([makeInstance()], detected);

    expect(payload.repositories[0].active).toBe(true);
  });

  it('flags nothing active when the attribution is only the fallback pick', () => {
    // Several matches and no editor to confirm the pick: detection still
    // returns matches[0] as linked, but that is weaker than what the flag
    // promises the agent, so no entry is flagged.
    const first = makeRepo();
    const second = makeRepo({ instanceId: 'instance-1', owner: 'org', repo: 'lib', localPath: '/workspace/lib' });
    const detected: DetectLinkedRepositoriesResult = { linked: second, all: [first, second], unpublished: [] };

    const payload = buildWorkspaceStatePayload([makeInstance()], detected);

    expect(payload.repositories.map((entry) => entry.active)).toEqual([false, false]);
  });

  it('flags nothing active when the editor sits outside the attributed repository', () => {
    const first = makeRepo();
    const second = makeRepo({ instanceId: 'instance-1', owner: 'org', repo: 'lib', localPath: '/workspace/lib' });
    const detected: DetectLinkedRepositoriesResult = { linked: second, all: [first, second], unpublished: [] };
    setActiveEditor('/elsewhere/notes.txt');

    const payload = buildWorkspaceStatePayload([makeInstance()], detected);

    expect(payload.repositories.map((entry) => entry.active)).toEqual([false, false]);
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
  let logger: Logger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-state-test-'));
    stateFilePath = path.join(tempDir, 'state', `mcp-workspace-${process.pid}-testnonce.json`);
    detectMock.mockReset();
    logger = makeLogger();
  });

  afterEach(async () => {
    // Every write this window enqueued must settle before the directory goes: a
    // still-open `.part` handle makes the removal fail on Windows, and retrying
    // the removal only narrows that race (see whenMcpStateWritesSettled).
    await whenMcpStateWritesSettled();
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
    // The file is the contract with the MCP child: no credential may reach
    // it, and the dropped remoteUrl field (a masked value nothing read) must
    // not come back.
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    expect(raw).not.toContain('secret-token');
    expect(written.repositories[0]).not.toHaveProperty('remoteUrl');
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

  it('surfaces a write failure at info level once per failure streak', async () => {
    // The logger has no warn level, so info is the visible channel; repeating
    // failures stay debug-only until a write succeeds and resets the streak.
    // The flag is module state, so a successful write first: the previous
    // test's failure must not leak into this streak.
    detectMock.mockResolvedValue({ linked: undefined, all: [], unpublished: [] });
    await writeMcpWorkspaceState(stateFilePath, configWith([makeInstance()]), logger);

    detectMock.mockRejectedValue(new Error('git exploded'));
    await writeMcpWorkspaceState(stateFilePath, configWith([makeInstance()]), logger);
    await writeMcpWorkspaceState(stateFilePath, configWith([makeInstance()]), logger);
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1);

    detectMock.mockResolvedValue({ linked: undefined, all: [], unpublished: [] });
    await writeMcpWorkspaceState(stateFilePath, configWith([makeInstance()]), logger);
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1);

    detectMock.mockRejectedValue(new Error('git exploded again'));
    await writeMcpWorkspaceState(stateFilePath, configWith([makeInstance()]), logger);
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(2);
  });
});

describe('writeMcpServerShim', () => {
  let tempDir: string;
  let logger: Logger;
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-shim-test-'));
    logger = makeLogger();
    context = {
      subscriptions: [] as { dispose(): unknown }[],
      globalStorageUri: { fsPath: path.join(tempDir, 'globalStorage') },
      // A Windows-style install path on purpose: the shim is a JS string
      // literal, so backslashes must not survive into it unescaped.
      extensionUri: { fsPath: 'D:\\extensions\\cpf23333.forgejo-toolkit-0.0.1' },
    } as unknown as vscode.ExtensionContext;
  });

  afterEach(async () => {
    // Every write this window enqueued must settle before the directory goes: a
    // still-open `.part` handle makes the removal fail on Windows, and retrying
    // the removal only narrows that race (see whenMcpStateWritesSettled).
    await whenMcpStateWritesSettled();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a shim that imports the current installation’s server bundle as a file URL', async () => {
    await writeMcpServerShim(context, logger);

    const shimFilePath = mcpServerShimFilePath(context);
    expect(path.basename(shimFilePath)).toBe('mcp-server.js');
    const content = fs.readFileSync(shimFilePath, 'utf8');
    // A dynamic `import()` specifier is a URL: a Windows drive-letter path is
    // read as the scheme `d:` and the ESM loader refuses to start the server.
    expect(content).toMatch(/import\(["']file:\/\/[^"']*mcp-server\.mjs["']\)/);
    expect(content).not.toContain('\\');
  });

  it('writes a specifier Node can actually resolve, not just one that looks right', async () => {
    // The text-only assertions above are what let the drive-letter form ship:
    // nothing ever resolved the specifier. This builds the shim for a real
    // install layout and imports what it names, exactly as Node would.
    const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-shim-install-'));
    try {
      fs.mkdirSync(path.join(extensionRoot, 'out'), { recursive: true });
      fs.writeFileSync(path.join(extensionRoot, 'out', 'mcp-server.mjs'), 'export const started = true;\n', 'utf8');
      const probeContext = {
        extensionUri: { fsPath: extensionRoot },
      } as unknown as vscode.ExtensionContext;

      const content = buildMcpServerShimContent(probeContext);
      const specifier = /import\(["']([^"']+)["']\)/.exec(content)?.[1];
      expect(specifier).toBeDefined();

      const loaded = (await import(/* @vite-ignore */ specifier!)) as { started?: boolean };
      expect(loaded.started).toBe(true);
    } finally {
      fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
  });

  it('leaves an unchanged shim untouched instead of bumping its mtime on every activation', async () => {
    await writeMcpServerShim(context, logger);
    const shimFilePath = mcpServerShimFilePath(context);
    // Pin the mtime to a recognizable past value: a rewrite would replace it
    // with the current time, so equality proves the second write was skipped.
    const pinned = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(shimFilePath, pinned, pinned);

    await writeMcpServerShim(context, logger);

    expect(fs.statSync(shimFilePath).mtimeMs).toBe(pinned.getTime());
  });

  it('rewrites the shim when the install path changes (extension upgrade)', async () => {
    await writeMcpServerShim(context, logger);
    const shimFilePath = mcpServerShimFilePath(context);
    (context as { extensionUri: { fsPath: string } }).extensionUri = {
      fsPath: 'D:\\extensions\\cpf23333.forgejo-toolkit-0.0.2',
    };

    await writeMcpServerShim(context, logger);

    const content = fs.readFileSync(shimFilePath, 'utf8');
    expect(content).toContain('cpf23333.forgejo-toolkit-0.0.2');
    expect(content).toMatch(/import\(["']file:\/\/[^"']*mcp-server\.mjs["']\)/);
  });

  it('keeps a quote in the install path from breaking the shim', () => {
    (context as { extensionUri: { fsPath: string } }).extensionUri = { fsPath: "/home/it's me/.vscode/extensions" };

    const content = buildMcpServerShimContent(context);

    // The specifier is a JSON string literal, so the quote is carried verbatim
    // (percent-encoded where a URL cannot carry it) instead of needing an escape
    // the generated file could get wrong.
    expect(content).toMatch(/import\("file:\/\/[^"]*it's[^"]*mcp-server\.mjs"\)/);
    expect(content).not.toContain("\\'");
  });

  it('logs and swallows a write failure instead of propagating it', async () => {
    // Advisory like the registry: a missing shim only breaks the static
    // `.mcp.json` launch path, so a failure must not surface as an extension
    // error.
    const blockedPath = path.join(tempDir, 'blocked');
    fs.writeFileSync(blockedPath, 'a file, not a directory', 'utf8');
    (context as { globalStorageUri: { fsPath: string } }).globalStorageUri = { fsPath: blockedPath };

    await expect(writeMcpServerShim(context, logger)).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('MCP server shim write failed'));
  });
});

describe('buildInstanceRegistryPayload', () => {
  it('publishes id, stripped URL and name — never the token', () => {
    // The registry is read by MCP processes launched outside VS Code's spawn
    // path; it must be credential-free even though the configured instance
    // object carries its token in memory.
    const payload = buildInstanceRegistryPayload([
      makeInstance({ url: 'https://token-abc123@forgejo.example.com' }),
      makeInstance({ id: 'instance-2', url: 'https://other.example.com', name: 'Other' }),
    ]);

    expect(typeof payload.updatedAt).toBe('string');
    expect(payload.instances).toEqual([
      { id: 'instance-1', url: 'https://forgejo.example.com/', name: 'Example' },
      { id: 'instance-2', url: 'https://other.example.com', name: 'Other' },
    ]);
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });
});

describe('writeMcpInstanceRegistry', () => {
  let tempDir: string;
  let registryFilePath: string;
  let logger: Logger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-registry-test-'));
    registryFilePath = path.join(tempDir, 'state', 'mcp-instances.json');
    logger = makeLogger();
  });

  afterEach(async () => {
    // Every write this window enqueued must settle before the directory goes: a
    // still-open `.part` handle makes the removal fail on Windows, and retrying
    // the removal only narrows that race (see whenMcpStateWritesSettled).
    await whenMcpStateWritesSettled();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function configWith(instances: ForgejoInstance[]): ConfigManager {
    return { getInstances: () => instances } as unknown as ConfigManager;
  }

  it('writes the registry at the fixed file name, creating the globalStorage directory', async () => {
    await writeMcpInstanceRegistry(registryFilePath, configWith([makeInstance()]), logger);

    const written = JSON.parse(fs.readFileSync(registryFilePath, 'utf8')) as McpInstanceRegistryFile;
    expect(written.instances).toHaveLength(1);
    expect(written.instances[0]).toMatchObject({ id: 'instance-1', url: 'https://forgejo.example.com' });
    // The file is the contract with the zero-config MCP child: no credential
    // may reach it.
    expect(fs.readFileSync(registryFilePath, 'utf8')).not.toContain('secret-token');
  });

  it('writes an empty array when no instances are configured instead of deleting the file', async () => {
    // "No instances configured" must stay distinguishable from "extension
    // never ran" for the discovering MCP child, so an emptied list is a
    // written file with an empty array, not a removed file.
    await writeMcpInstanceRegistry(registryFilePath, configWith([makeInstance()]), logger);
    await writeMcpInstanceRegistry(registryFilePath, configWith([]), logger);

    const written = JSON.parse(fs.readFileSync(registryFilePath, 'utf8')) as McpInstanceRegistryFile;
    expect(written.instances).toEqual([]);
  });

  it('logs and swallows a write failure instead of propagating it', async () => {
    // Advisory like the state file: the VS Code-spawned children never read
    // the registry, so a failure must not surface as an extension error.
    const blockedPath = path.join(tempDir, 'blocked');
    fs.writeFileSync(blockedPath, 'a file, not a directory', 'utf8');

    await expect(
      writeMcpInstanceRegistry(path.join(blockedPath, 'mcp-instances.json'), configWith([makeInstance()]), logger),
    ).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('MCP instance registry write failed'));
  });
});

describe('registerMcpWorkspaceStateSync', () => {
  let tempDir: string;
  let context: vscode.ExtensionContext;
  let logger: Logger;
  const emptyDetection: DetectLinkedRepositoriesResult = { linked: undefined, all: [], unpublished: [] };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-state-test-'));
    detectMock.mockReset();
    detectMock.mockResolvedValue(emptyDetection);
    logger = makeLogger();
    context = {
      subscriptions: [] as { dispose(): unknown }[],
      globalStorageUri: { fsPath: tempDir },
      extensionUri: { fsPath: path.join(tempDir, 'extension-install') },
    } as unknown as vscode.ExtensionContext;
  });

  afterEach(async () => {
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }
    // Every write this window enqueued must settle before the directory goes: a
    // still-open `.part` handle makes the removal fail on Windows, and retrying
    // the removal only narrows that race (see whenMcpStateWritesSettled).
    await whenMcpStateWritesSettled();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function register(): string {
    const config = {
      getInstances: () => [],
      onInstancesChanged: () => ({ dispose: vi.fn() }),
    } as unknown as ConfigManager;
    registerMcpWorkspaceStateSync(context, config, logger);
    return mcpWorkspaceStateFilePath(context);
  }

  /** The listener this registration added to a vscode event mock. */
  function lastListener(mock: ReturnType<typeof vi.fn>): (arg?: unknown) => void {
    return mock.mock.calls[mock.mock.calls.length - 1][0] as (arg?: unknown) => void;
  }

  it('writes the instance registry eagerly at registration, without waiting for the state debounce', async () => {
    // A zero-configuration MCP child can start the moment the extension ran
    // once; the registry write is not debounced and needs no detection.
    register();

    const registryFilePath = mcpInstanceRegistryFilePath(context);
    expect(path.basename(registryFilePath)).toBe('mcp-instances.json');
    await until(() => fs.existsSync(registryFilePath));

    const written = JSON.parse(fs.readFileSync(registryFilePath, 'utf8')) as McpInstanceRegistryFile;
    expect(written.instances).toEqual([]);
  });

  it('writes the stable-path shim at registration even with no instances configured', async () => {
    // The shim describes the installation, not the accounts: an empty
    // instance list must not skip it, or a static `.mcp.json` would keep
    // pointing at a stale install path after an upgrade.
    register();

    const shimFilePath = mcpServerShimFilePath(context);
    await until(() => fs.existsSync(shimFilePath));

    expect(fs.readFileSync(shimFilePath, 'utf8')).toMatch(
      /import\(["']file:\/\/[^"']*extension-install\/out\/mcp-server\.mjs["']\)/,
    );
  });

  it('rewrites the registry from the same instances-changed listener as the state file', async () => {
    // One listener serves both files: an instance add/remove must update the
    // registry and the state file together, not on separate subscriptions
    // that could drift.
    let instances = [makeInstance()];
    let instancesChangedListener: (() => void) | undefined;
    const config = {
      getInstances: () => instances,
      onInstancesChanged: (listener: () => void) => {
        instancesChangedListener = listener;
        return { dispose: vi.fn() };
      },
    } as unknown as ConfigManager;
    registerMcpWorkspaceStateSync(context, config, logger);
    const registryFilePath = mcpInstanceRegistryFilePath(context);
    await until(() => fs.existsSync(registryFilePath));

    instances = [];
    instancesChangedListener?.();
    await until(
      () => (JSON.parse(fs.readFileSync(registryFilePath, 'utf8')) as McpInstanceRegistryFile).instances.length === 0,
    );

    const written = JSON.parse(fs.readFileSync(registryFilePath, 'utf8')) as McpInstanceRegistryFile;
    expect(written.instances).toEqual([]);
  });

  it('names the file with the pid and a per-window nonce', () => {
    const stateFilePath = register();
    expect(path.basename(stateFilePath)).toMatch(new RegExp(`^mcp-workspace-${process.pid}-[0-9a-f]{8}\\.json$`));
  });

  it('sweeps state files orphaned by dead pids, keeping this window’s own', async () => {
    // 999999 is not a multiple of 4, so it is not even a valid Windows pid,
    // and no ordinary test host runs a process with it: the probe must see it
    // as dead. The nonce-less name is the pre-nonce format, also swept.
    const orphan = path.join(tempDir, 'mcp-workspace-999999-abcdef12.json');
    const legacyOrphan = path.join(tempDir, 'mcp-workspace-999999.json');
    const orphanPart = path.join(tempDir, 'mcp-workspace-999999-abcdef12.json.part');
    fs.writeFileSync(orphan, '{}', 'utf8');
    fs.writeFileSync(legacyOrphan, '{}', 'utf8');
    fs.writeFileSync(orphanPart, '{}', 'utf8');

    const ownFile = register();
    fs.writeFileSync(ownFile, '{}', 'utf8');
    await until(() => !fs.existsSync(orphan) && !fs.existsSync(legacyOrphan) && !fs.existsSync(orphanPart));

    expect(fs.existsSync(ownFile)).toBe(true);
  });

  it('merges rapid editor switches into a single debounced write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stateFilePath = register();
    const editorListener = lastListener(vi.mocked(vscode.window.onDidChangeActiveTextEditor));

    editorListener();
    editorListener();
    editorListener();
    await vi.advanceTimersByTimeAsync(300);
    // The debounce fired and enqueued the write; the write itself is real fs
    // work, so go back to real timers before waiting on it.
    vi.useRealTimers();
    await until(() => fs.existsSync(stateFilePath));

    expect(detectMock).toHaveBeenCalledTimes(1);
  });

  it('does not write when deactivation lands while detection is in flight', async () => {
    // The workspace-folders trigger enqueues immediately; gating detection
    // holds the write open across the cleanup call, so the disposed check is
    // the only thing standing between this and a recreated file.
    let resolveDetect!: (value: DetectLinkedRepositoriesResult) => void;
    detectMock.mockReturnValue(
      new Promise<DetectLinkedRepositoriesResult>((resolve) => {
        resolveDetect = resolve;
      }),
    );
    const stateFilePath = register();
    lastListener(vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders))();
    await until(() => detectMock.mock.calls.length === 1);

    // cleanup awaits the in-flight write, which is still waiting on
    // detection — so resolve detection only after cleanup has started.
    const cleanup = cleanupMcpWorkspaceState(logger);
    resolveDetect(emptyDetection);
    await cleanup;

    expect(fs.existsSync(stateFilePath)).toBe(false);
  });

  it('waits for an in-flight write before cleanup resolves', async () => {
    let resolveDetect!: (value: DetectLinkedRepositoriesResult) => void;
    detectMock.mockReturnValue(
      new Promise<DetectLinkedRepositoriesResult>((resolve) => {
        resolveDetect = resolve;
      }),
    );
    register();
    lastListener(vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders))();
    await until(() => detectMock.mock.calls.length === 1);

    let cleaned = false;
    const cleanup = cleanupMcpWorkspaceState(logger).then(() => {
      cleaned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cleaned).toBe(false);

    resolveDetect(emptyDetection);
    await cleanup;
    expect(cleaned).toBe(true);
  });
});

describe('cleanupMcpWorkspaceState', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-state-test-'));
    detectMock.mockReset();
  });

  afterEach(async () => {
    // Every write this window enqueued must settle before the directory goes: a
    // still-open `.part` handle makes the removal fail on Windows, and retrying
    // the removal only narrows that race (see whenMcpStateWritesSettled).
    await whenMcpStateWritesSettled();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes the state file registered for this window', async () => {
    const context = {
      subscriptions: [] as { dispose(): unknown }[],
      globalStorageUri: { fsPath: tempDir },
      extensionUri: { fsPath: path.join(tempDir, 'extension-install') },
    } as unknown as vscode.ExtensionContext;
    const config = {
      getInstances: () => [],
      onInstancesChanged: () => ({ dispose: vi.fn() }),
    } as unknown as ConfigManager;
    const logger = makeLogger();
    registerMcpWorkspaceStateSync(context, config, logger);
    const stateFilePath = mcpWorkspaceStateFilePath(context);
    expect(path.basename(stateFilePath)).toMatch(new RegExp(`^mcp-workspace-${process.pid}-[0-9a-f]{8}\\.json$`));
    fs.writeFileSync(stateFilePath, '{}', 'utf8');

    await cleanupMcpWorkspaceState(logger);

    expect(fs.existsSync(stateFilePath)).toBe(false);
    // A second cleanup is a no-op: the path is forgotten with the first.
    await expect(cleanupMcpWorkspaceState(logger)).resolves.toBeUndefined();
  });
});
