import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as vscode from 'vscode';
import type { Logger } from '../../logger';
import {
  buildAgentsWindowMcpConfig,
  copyAgentsWindowMcpConfig,
  mergeMcpConfigIntoFile,
  userMcpJsonPath,
  type AgentsWindowMcpConfig,
} from '../agentsWindowMcpConfig';
import { mcpServerShimFilePath } from '../../mcpWorkspaceState';
import { removeTempDirSync } from '../../__tests__/tempDir';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/**
 * The shared vscode mock's `Uri.joinPath` stringifies its arguments, which
 * turns a plain `{ fsPath }` base into "[object Object]/...". The product
 * code joins real Uris, so these tests substitute an implementation that
 * resolves the segments against the base's fsPath — close enough to the
 * real `joinPath` for the relative `..` segments the command uses.
 */
function mockRealisticJoinPath(): void {
  vi.mocked(vscode.Uri.joinPath).mockImplementation(
    (base: vscode.Uri, ...segments: string[]) =>
      ({ fsPath: path.join(base.fsPath, ...segments), scheme: 'file' }) as vscode.Uri,
  );
}

describe('buildAgentsWindowMcpConfig', () => {
  it('builds a node-launched server entry pointing at the shim', () => {
    expect(buildAgentsWindowMcpConfig('/storage/mcp-server.js')).toEqual({
      servers: { forgejo: { command: 'node', args: ['/storage/mcp-server.js'] } },
    });
  });
});

describe('userMcpJsonPath', () => {
  beforeEach(() => {
    mockRealisticJoinPath();
  });

  it('resolves two levels above globalStorageUri: the profile’s User directory', () => {
    // globalStorage is `<profile>/User/globalStorage/<publisher>.<name>`;
    // the user-level MCP registry lives in the profile's User directory,
    // and a profile install must land in its own profile's mcp.json.
    const context = {
      globalStorageUri: { fsPath: path.join('profiles', 'work', 'User', 'globalStorage', 'cpf23333.forgejo-toolkit') },
    } as unknown as vscode.ExtensionContext;

    expect(userMcpJsonPath(context)).toBe(path.join('profiles', 'work', 'User', 'mcp.json'));
  });
});

describe('mergeMcpConfigIntoFile', () => {
  let tempDir: string;
  let mcpJsonPath: string;
  const config: AgentsWindowMcpConfig = buildAgentsWindowMcpConfig('/storage/mcp-server.js');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-config-test-'));
    mcpJsonPath = path.join(tempDir, 'mcp.json');
  });

  afterEach(() => {
    removeTempDirSync(tempDir);
  });

  it('creates the file when none exists', async () => {
    await mergeMcpConfigIntoFile(mcpJsonPath, config);

    expect(JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'))).toEqual(config);
  });

  it('creates a missing user-level file with the inputs scaffold VS Code writes there', async () => {
    await mergeMcpConfigIntoFile(mcpJsonPath, config, { servers: {}, inputs: [] });

    expect(JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'))).toEqual({
      servers: { forgejo: { command: 'node', args: ['/storage/mcp-server.js'] } },
      inputs: [],
    });
  });

  it('creates the parent directory when the target lives in a not-yet-existing .vscode', async () => {
    const nested = path.join(tempDir, 'workspace', '.vscode', 'mcp.json');

    await mergeMcpConfigIntoFile(nested, config);

    expect(JSON.parse(fs.readFileSync(nested, 'utf8'))).toEqual(config);
  });

  it('merges into an existing file, keeping other servers and top-level keys', async () => {
    fs.writeFileSync(
      mcpJsonPath,
      JSON.stringify({ inputs: [{ id: 'x' }], servers: { other: { command: 'other-cmd' } } }, null, 2),
      'utf8',
    );

    await mergeMcpConfigIntoFile(mcpJsonPath, config);

    expect(JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'))).toEqual({
      inputs: [{ id: 'x' }],
      servers: {
        other: { command: 'other-cmd' },
        forgejo: { command: 'node', args: ['/storage/mcp-server.js'] },
      },
    });
  });

  it('overrides a same-named forgejo entry instead of duplicating it', async () => {
    fs.writeFileSync(
      mcpJsonPath,
      JSON.stringify({ servers: { forgejo: { command: 'node', args: ['/old/path/mcp-server.js'] } } }, null, 2),
      'utf8',
    );

    await mergeMcpConfigIntoFile(mcpJsonPath, config);

    const written = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    expect(Object.keys(written.servers)).toEqual(['forgejo']);
    expect(written.servers.forgejo.args).toEqual(['/storage/mcp-server.js']);
  });

  it('reports invalid JSON and leaves the file untouched', async () => {
    fs.writeFileSync(mcpJsonPath, '{ not json', 'utf8');

    await expect(mergeMcpConfigIntoFile(mcpJsonPath, config)).rejects.toThrow('not valid JSON');
    expect(fs.readFileSync(mcpJsonPath, 'utf8')).toBe('{ not json');
  });

  it('reports a top-level non-object and leaves the file untouched', async () => {
    fs.writeFileSync(mcpJsonPath, '["an array"]', 'utf8');

    await expect(mergeMcpConfigIntoFile(mcpJsonPath, config)).rejects.toThrow('must contain a JSON object');
    expect(fs.readFileSync(mcpJsonPath, 'utf8')).toBe('["an array"]');
  });
});

describe('copyAgentsWindowMcpConfig', () => {
  let tempDir: string;
  let workspaceDir: string;
  let userDir: string;
  let extensionDir: string;
  let logger: Logger;
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-command-test-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir);
    userDir = path.join(tempDir, 'User');
    // The installed extension directory, named the way VS Code names it but
    // built from the platform's own path APIs. A hard-coded `D:\...` fixture
    // is a *relative* path on POSIX, so `pathToFileURL` would resolve it
    // against the cwd and the "current installation" the shim names would no
    // longer be this fixture at all.
    extensionDir = path.join(tempDir, 'extensions', 'cpf23333.forgejo-toolkit-0.0.1');
    logger = makeLogger();
    context = {
      subscriptions: [] as { dispose(): unknown }[],
      globalStorageUri: { fsPath: path.join(userDir, 'globalStorage', 'cpf23333.forgejo-toolkit') },
      extensionUri: { fsPath: extensionDir },
    } as unknown as vscode.ExtensionContext;
    vi.clearAllMocks();
    mockRealisticJoinPath();
  });

  afterEach(() => {
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [];
    removeTempDirSync(tempDir);
  });

  function openWorkspace(): void {
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [
      { uri: { fsPath: workspaceDir }, name: 'workspace', index: 0 },
    ];
  }

  it('writes the shim before offering the snippet, so the referenced path exists', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);

    await copyAgentsWindowMcpConfig(context, logger);

    const shimFilePath = mcpServerShimFilePath(context);
    // The shim lives in globalStorage; the bundle it names lives in the
    // versioned install directory. Keep the two apart in this test.
    expect(shimFilePath).toBe(path.join(context.globalStorageUri.fsPath, 'mcp-server.js'));
    expect(fs.existsSync(shimFilePath)).toBe(true);

    const content = fs.readFileSync(shimFilePath, 'utf8');
    // The specifier is a `file://` URL: a dynamic `import()` is resolved as a
    // URL, so a bare path (a Windows drive letter, or anything relative) is
    // refused by the ESM loader and the shim this command hands the user could
    // never start the server. The expected URL is derived with the same
    // function the writer uses instead of being spelled out literally, so the
    // assertion is about the path rather than about the platform that ran it.
    const specifier = /^import\((.*)\)\.catch\(/m.exec(content)?.[1];
    expect(specifier).toBeDefined();
    const importedUrl = JSON.parse(specifier!) as string;
    const installedBundlePath = path.join(extensionDir, 'out', 'mcp-server.mjs');

    // Exactly the current installation's bundle, as an absolute `file://` URL.
    expect(importedUrl).toBe(pathToFileURL(installedBundlePath).href);
    expect(new URL(importedUrl).protocol).toBe('file:');
    const importedPath = fileURLToPath(importedUrl);
    expect(path.isAbsolute(importedPath)).toBe(true);
    expect(path.dirname(importedPath)).toBe(path.join(extensionDir, 'out'));
    expect(path.basename(importedPath)).toBe('mcp-server.mjs');
    // Not the stable shim's own cache directory: the snippet points at the
    // shim, but the shim must point at the installed extension.
    expect(importedPath.startsWith(context.globalStorageUri.fsPath)).toBe(false);
  });

  it('offers the user-level write first, then the workspace write, then the clipboard', async () => {
    openWorkspace();
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);

    await copyAgentsWindowMcpConfig(context, logger);

    const [, ...actions] = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    expect(actions).toEqual([
      'Write to User mcp.json (Recommended)',
      'Write to Workspace .vscode/mcp.json',
      'Copy to Clipboard',
    ]);
  });

  it('offers no workspace write when no workspace folder is open', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);

    await copyAgentsWindowMcpConfig(context, logger);

    const [, ...actions] = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    expect(actions).toEqual(['Write to User mcp.json (Recommended)', 'Copy to Clipboard']);
  });

  it('copies the snippet to the clipboard', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Copy to Clipboard' as never);

    await copyAgentsWindowMcpConfig(context, logger);

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0][0];
    expect(JSON.parse(copied)).toEqual({
      servers: {
        forgejo: {
          command: 'node',
          args: [path.join(userDir, 'globalStorage', 'cpf23333.forgejo-toolkit', 'mcp-server.js')],
        },
      },
    });
  });

  it('writes the user-level mcp.json of the owning profile after the advisory is confirmed', async () => {
    // The first info message picks the user write action; the modal warning
    // default (extension-setup) accepts its first action, i.e. the write.
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Write to User mcp.json (Recommended)' as never,
    );

    await copyAgentsWindowMcpConfig(context, logger);

    const target = path.join(userDir, 'mcp.json');
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(written.servers.forgejo.args).toEqual([
      path.join(userDir, 'globalStorage', 'cpf23333.forgejo-toolkit', 'mcp-server.js'),
    ]);
    // A fresh user-level file carries the inputs scaffold VS Code itself
    // writes there.
    expect(written.inputs).toEqual([]);
  });

  it('merges the snippet into the workspace .vscode/mcp.json after the advisory is confirmed', async () => {
    openWorkspace();
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Write to Workspace .vscode/mcp.json' as never,
    );

    await copyAgentsWindowMcpConfig(context, logger);

    const written = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.vscode', 'mcp.json'), 'utf8'));
    expect(written.servers.forgejo.args).toEqual([
      path.join(userDir, 'globalStorage', 'cpf23333.forgejo-toolkit', 'mcp-server.js'),
    ]);
  });

  it('does not touch any file when the advisory is declined', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Write to User mcp.json (Recommended)' as never,
    );
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);

    await copyAgentsWindowMcpConfig(context, logger);

    expect(fs.existsSync(path.join(userDir, 'mcp.json'))).toBe(false);
  });

  it('reports a broken existing mcp.json and leaves it unchanged', async () => {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'mcp.json'), '{ not json', 'utf8');
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Write to User mcp.json (Recommended)' as never,
    );

    await copyAgentsWindowMcpConfig(context, logger);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    expect(fs.readFileSync(path.join(userDir, 'mcp.json'), 'utf8')).toBe('{ not json');
  });
});
