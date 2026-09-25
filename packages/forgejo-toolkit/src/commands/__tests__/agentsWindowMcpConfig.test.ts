import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Logger } from '../../logger';
import {
  buildAgentsWindowMcpConfig,
  copyAgentsWindowMcpConfig,
  mergeMcpConfigIntoFile,
  type AgentsWindowMcpConfig,
} from '../agentsWindowMcpConfig';
import { mcpServerShimFilePath } from '../../mcpWorkspaceState';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('buildAgentsWindowMcpConfig', () => {
  it('builds a node-launched server entry pointing at the shim', () => {
    expect(buildAgentsWindowMcpConfig('/storage/mcp-server.js')).toEqual({
      servers: { forgejo: { command: 'node', args: ['/storage/mcp-server.js'] } },
    });
  });
});

describe('mergeMcpConfigIntoFile', () => {
  let tempDir: string;
  let mcpJsonPath: string;
  const config: AgentsWindowMcpConfig = buildAgentsWindowMcpConfig('/storage/mcp-server.js');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-config-test-'));
    mcpJsonPath = path.join(tempDir, '.mcp.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the file when none exists', async () => {
    await mergeMcpConfigIntoFile(mcpJsonPath, config);

    expect(JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'))).toEqual(config);
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
  let logger: Logger;
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-command-test-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir);
    logger = makeLogger();
    context = {
      subscriptions: [] as { dispose(): unknown }[],
      globalStorageUri: { fsPath: path.join(tempDir, 'globalStorage') },
      extensionUri: { fsPath: 'D:\\extensions\\cpf23333.forgejo-toolkit-0.0.1' },
    } as unknown as vscode.ExtensionContext;
    vi.clearAllMocks();
  });

  afterEach(() => {
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [];
    fs.rmSync(tempDir, { recursive: true, force: true });
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
    expect(fs.existsSync(shimFilePath)).toBe(true);
    expect(fs.readFileSync(shimFilePath, 'utf8')).toContain(
      "require('D:/extensions/cpf23333.forgejo-toolkit-0.0.1/out/mcp-server.js');",
    );
  });

  it('copies the snippet to the clipboard', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Copy to Clipboard' as never);

    await copyAgentsWindowMcpConfig(context, logger);

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0][0];
    expect(JSON.parse(copied)).toEqual({
      servers: {
        forgejo: { command: 'node', args: [path.join(tempDir, 'globalStorage', 'mcp-server.js')] },
      },
    });
  });

  it('offers no write action when no workspace folder is open', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);

    await copyAgentsWindowMcpConfig(context, logger);

    const [, ...actions] = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    expect(actions).toEqual(['Copy to Clipboard']);
  });

  it('merges the snippet into the workspace .mcp.json after the advisory is confirmed', async () => {
    openWorkspace();
    // The first info message picks the write action; the modal warning
    // default (extension-setup) accepts its first action, i.e. the write.
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Write to Workspace .mcp.json' as never);

    await copyAgentsWindowMcpConfig(context, logger);

    const written = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.mcp.json'), 'utf8'));
    expect(written.servers.forgejo.args).toEqual([path.join(tempDir, 'globalStorage', 'mcp-server.js')]);
  });

  it('does not touch the workspace file when the advisory is declined', async () => {
    openWorkspace();
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Write to Workspace .mcp.json' as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);

    await copyAgentsWindowMcpConfig(context, logger);

    expect(fs.existsSync(path.join(workspaceDir, '.mcp.json'))).toBe(false);
  });

  it('reports a broken existing .mcp.json and leaves it unchanged', async () => {
    openWorkspace();
    fs.writeFileSync(path.join(workspaceDir, '.mcp.json'), '{ not json', 'utf8');
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Write to Workspace .mcp.json' as never);

    await copyAgentsWindowMcpConfig(context, logger);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    expect(fs.readFileSync(path.join(workspaceDir, '.mcp.json'), 'utf8')).toBe('{ not json');
  });
});
