import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { McpWorkspaceStateFile } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import { resolveWorkspaceRepository } from '../workspaceState';
import { buildToolHandlers, registerTools } from '../tools';

/**
 * Handler-level tests for the `get_workspace_repository` tool. The state file
 * is a real temporary file: the reader's contract is exactly the bytes the
 * extension host writes, so faking the filesystem would test nothing.
 */

function stateFile(overrides: Partial<McpWorkspaceStateFile> = {}): McpWorkspaceStateFile {
  return {
    updatedAt: '2026-01-01T00:00:00.000Z',
    repositories: [
      {
        instanceId: 'instance-1',
        instanceUrl: 'https://forgejo.example.com',
        owner: 'demo-user',
        repo: 'demo-repo',
        localPath: '/workspace/demo-repo',
        active: true,
      },
      {
        instanceId: 'instance-2',
        instanceUrl: 'https://other.example.com',
        owner: 'org',
        repo: 'lib',
        localPath: '/workspace/lib',
        active: false,
      },
    ],
    ...overrides,
  };
}

describe('resolveWorkspaceRepository', () => {
  let tempDir: string;
  let stateFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-reader-test-'));
    stateFilePath = path.join(tempDir, 'mcp-workspace-test.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeState(value: unknown): void {
    fs.writeFileSync(stateFilePath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  }

  it('answers "not configured" when no state file was passed to the process', async () => {
    const result = await resolveWorkspaceRepository(undefined, 'https://forgejo.example.com');
    expect(result.status).toBe('not_configured');
  });

  it('answers "not configured" when the path does not name a state file', async () => {
    // The path arrives through the process environment, which a hand-edited
    // launch can point anywhere; only this extension's own file names are
    // read.
    const foreign = path.join(tempDir, 'state.json');
    fs.writeFileSync(foreign, JSON.stringify(stateFile()), 'utf8');
    const result = await resolveWorkspaceRepository(foreign, 'https://forgejo.example.com');
    expect(result.status).toBe('not_configured');
  });

  it('answers "unavailable" for an implausibly large file without reading it', async () => {
    // The writer publishes a handful of repositories; a megabyte of "state"
    // is not something this process should parse.
    writeState(`{"padding":"${'x'.repeat(1024 * 1024)}"}`);
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com');
    expect(result.status).toBe('unavailable');
  });

  it('answers "unavailable" when the state file does not exist', async () => {
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com');
    expect(result.status).toBe('unavailable');
  });

  it('answers "unavailable" when the state file is not JSON', async () => {
    writeState('this is not json{');
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com');
    expect(result.status).toBe('unavailable');
  });

  it('answers "unavailable" when the state file has no repositories array', async () => {
    writeState({ updatedAt: '2026-01-01T00:00:00.000Z', repositories: 'oops' });
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com');
    expect(result.status).toBe('unavailable');
  });

  it('answers "empty" when no workspace repository is linked at all', async () => {
    writeState(stateFile({ repositories: [] }));
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com');
    expect(result.status).toBe('empty');
  });

  it('returns only the repositories of this process’s instance, with the active flag', async () => {
    writeState(stateFile());
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com');
    expect(result.status).toBe('matched');
    if (result.status !== 'matched') {
      throw new Error('unreachable');
    }
    expect(result.repositories).toEqual([
      { owner: 'demo-user', repo: 'demo-repo', localPath: '/workspace/demo-repo', active: true },
    ]);
  });

  it('matches instance URLs regardless of a trailing slash', async () => {
    writeState(stateFile());
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com/');
    expect(result.status).toBe('matched');
  });

  it('matches even when this process’s instance URL carries credential userinfo', async () => {
    // FORGEJO_MCP_INSTANCE_URL is the configured value verbatim (the child
    // needs it to authenticate), while the state file is written stripped.
    writeState(stateFile());
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://token-abc123@forgejo.example.com');
    expect(result.status).toBe('matched');
  });

  it('prefers the instance id over the URL, so two accounts on one host stay apart', async () => {
    // Two configured instances, same host URL, one token each: a URL match
    // alone would hand both MCP servers the same repositories.
    const twoAccounts = stateFile({
      repositories: [
        {
          instanceId: 'account-alice',
          instanceUrl: 'https://forgejo.example.com',
          owner: 'alice',
          repo: 'demo-repo',
          localPath: '/workspace/demo-repo',
          active: true,
        },
        {
          instanceId: 'account-bob',
          instanceUrl: 'https://forgejo.example.com',
          owner: 'bob',
          repo: 'fork',
          localPath: '/workspace/fork',
          active: false,
        },
      ],
    });
    writeState(twoAccounts);

    const alice = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com', 'account-alice');
    expect(alice.status).toBe('matched');
    if (alice.status !== 'matched') {
      throw new Error('unreachable');
    }
    expect(alice.repositories.map((entry) => entry.repo)).toEqual(['demo-repo']);

    // Bob's server sees no match of its own and is told which other instance
    // serves the workspace repositories.
    const bob = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com', 'account-bob');
    expect(bob.status).toBe('matched');
    if (bob.status !== 'matched') {
      throw new Error('unreachable');
    }
    expect(bob.repositories.map((entry) => entry.repo)).toEqual(['fork']);
  });

  it('falls back to the URL comparison when the process has no instance id', async () => {
    // A child spawned by an older host build never received
    // FORGEJO_MCP_INSTANCE_ID; it keeps the pre-id behavior, ambiguity and
    // all.
    writeState(stateFile());
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com', undefined);
    expect(result.status).toBe('matched');
  });

  it('reads a legacy file that still carries the dropped remoteUrl field', async () => {
    // Writer and reader can be on different extension versions; fields this
    // version no longer knows must not break the read.
    const legacy = stateFile() as unknown as { repositories: Record<string, unknown>[] };
    legacy.repositories[0].remoteUrl = 'https://forgejo.example.com/demo-user/demo-repo.git';
    writeState(legacy);
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com');
    expect(result.status).toBe('matched');
  });

  it('names the other instances when no repository matches this one', async () => {
    writeState(stateFile());
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://third.example.com');
    expect(result.status).toBe('other_instances');
    if (result.status !== 'other_instances') {
      throw new Error('unreachable');
    }
    // The agent needs to know which *other* MCP server serves the workspace.
    expect(result.message).toContain('https://forgejo.example.com');
    expect(result.message).toContain('https://other.example.com');
    expect(result.otherInstances).toHaveLength(2);
    expect(result.otherInstances[0]).toEqual({
      instanceUrl: 'https://forgejo.example.com',
      repositories: [{ owner: 'demo-user', repo: 'demo-repo', localPath: '/workspace/demo-repo' }],
    });
  });

  it('re-reads the file on every call instead of caching', async () => {
    // The workspace changes while this long-lived process runs; a cached
    // answer would quietly go stale.
    writeState(stateFile({ repositories: [] }));
    expect((await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com')).status).toBe('empty');
    writeState(stateFile());
    expect((await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com')).status).toBe('matched');
  });

  it('skips entries it cannot understand instead of failing the whole file', async () => {
    // The writer and this reader can be on different extension versions (the
    // host may have reloaded while this child keeps running).
    const state = stateFile();
    (state.repositories as unknown[]).push({ unexpected: 'shape' });
    writeState(state);
    const result = await resolveWorkspaceRepository(stateFilePath, 'https://forgejo.example.com');
    expect(result.status).toBe('matched');
  });
});

describe('get_workspace_repository tool wiring', () => {
  it('is registered and answers "not configured" without workspace context', async () => {
    // A stable tool surface: the tool must not disappear when the server runs
    // without the state file, or agents would have to guess at its presence.
    const registered = new Map<
      string,
      (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>
    >();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;
    registerTools(server, {} as never);

    const call = registered.get('get_workspace_repository');
    expect(call).toBeDefined();
    const result = await call!({});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'not_configured' });
  });

  it('passes the workspace context through to the handler', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-reader-test-'));
    try {
      const stateFilePath = path.join(tempDir, 'mcp-workspace-state.json');
      fs.writeFileSync(stateFilePath, JSON.stringify(stateFile()), 'utf8');
      const handlers = buildToolHandlers({} as never, {
        stateFile: stateFilePath,
        instanceUrl: 'https://forgejo.example.com',
      });
      const result = await handlers.get_workspace_repository();
      expect(result.status).toBe('matched');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
