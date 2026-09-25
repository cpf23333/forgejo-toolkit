import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { McpInstanceRegistryFile } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import {
  discoverDataDirs,
  matchInstanceForRemotes,
  remoteMatchesInstanceUrl,
  resolveAutoConfiguration,
  type AutoConfigOptions,
} from '../autoConfig';

/**
 * Discovery and matching run against real temporary directories: the module's
 * contract is exactly the bytes the extension host writes into globalStorage
 * plus the `.git/config` of a checkout, so faking the filesystem would test
 * nothing. FORGEJO_MCP_DATA_DIR points the discovery at the temporary
 * globalStorage stand-in; the platform-default discovery is covered by one
 * test with a fake home directory.
 */

function makeOptions(overrides: Partial<AutoConfigOptions> & { cwd: string }): AutoConfigOptions {
  return {
    env: {},
    platform: 'linux',
    homeDir: '/nonexistent-home',
    ...overrides,
  };
}

function registryFile(
  instances: Partial<McpInstanceRegistryFile['instances'][number]>[] = [],
): McpInstanceRegistryFile {
  return {
    updatedAt: '2026-01-01T00:00:00.000Z',
    instances: instances.map((instance, index) => ({
      id: instance.id ?? `instance-${index + 1}`,
      url: instance.url ?? 'https://forgejo.example.com',
      name: instance.name ?? 'Example',
    })),
  };
}

function writeRegistry(dir: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mcp-instances.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  );
}

function writeStateFile(dir: string, name: string, repositories: unknown[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z', repositories }), 'utf8');
  return filePath;
}

function writeGitConfig(cwd: string, config: string): void {
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.git', 'config'), config, 'utf8');
}

describe('remoteMatchesInstanceUrl', () => {
  it('matches https remotes by host plus port, keeping the port significant', () => {
    expect(remoteMatchesInstanceUrl('https://forgejo.example.com/owner/repo.git', 'https://forgejo.example.com')).toBe(
      true,
    );
    expect(
      remoteMatchesInstanceUrl('https://forgejo.example.com:8443/owner/repo.git', 'https://forgejo.example.com:8443'),
    ).toBe(true);
    expect(
      remoteMatchesInstanceUrl('https://forgejo.example.com/owner/repo.git', 'https://forgejo.example.com:8443'),
    ).toBe(false);
  });

  it('matches ssh and scp remotes by host, ignoring the transport port', () => {
    // Self-hosted servers commonly serve SSH on 2222 while the web UI runs on
    // another port; the two ports have no correspondence.
    expect(remoteMatchesInstanceUrl('git@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com')).toBe(
      true,
    );
    expect(
      remoteMatchesInstanceUrl('ssh://git@forgejo.example.com:2222/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(true);
    // git's scp syntax allows any login, not just git@.
    expect(remoteMatchesInstanceUrl('alice@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com')).toBe(
      true,
    );
    expect(remoteMatchesInstanceUrl('git@other.example.com:owner/repo.git', 'https://forgejo.example.com')).toBe(false);
  });

  it('treats the instance deployment sub-path as part of the match', () => {
    expect(
      remoteMatchesInstanceUrl(
        'https://forgejo.example.com/forgejo/owner/repo.git',
        'https://forgejo.example.com/forgejo',
      ),
    ).toBe(true);
    expect(
      remoteMatchesInstanceUrl(
        'alice@forgejo.example.com:forgejo/owner/repo.git',
        'https://forgejo.example.com/forgejo',
      ),
    ).toBe(true);
    expect(
      remoteMatchesInstanceUrl(
        'https://forgejo.example.com/other/owner/repo.git',
        'https://forgejo.example.com/forgejo',
      ),
    ).toBe(false);
  });

  it('rejects the instance root and unparseable input: a remote must name owner and repo', () => {
    expect(remoteMatchesInstanceUrl('https://forgejo.example.com', 'https://forgejo.example.com')).toBe(false);
    expect(remoteMatchesInstanceUrl('https://forgejo.example.com/owner', 'https://forgejo.example.com')).toBe(false);
    expect(remoteMatchesInstanceUrl('not a url', 'https://forgejo.example.com')).toBe(false);
    expect(remoteMatchesInstanceUrl('https://forgejo.example.com/owner/repo.git', 'not a url')).toBe(false);
  });
});

describe('matchInstanceForRemotes', () => {
  const instances = registryFile([
    { id: 'account-alice', url: 'https://forgejo.example.com', name: 'Alice' },
    { id: 'account-bob', url: 'https://forgejo.example.com', name: 'Bob' },
  ]).instances;

  it('takes the first instance when several match the same remote and flags the ambiguity', () => {
    // Two accounts on one host: the registry carries no username, so the
    // remote's owner namespace cannot disambiguate — first match wins.
    const match = matchInstanceForRemotes(
      [{ name: 'origin', url: 'git@forgejo.example.com:owner/repo.git' }],
      instances,
    );
    expect(match?.instance.id).toBe('account-alice');
    expect(match?.ambiguous).toBe(true);
  });

  it('tries remotes in order, origin first', () => {
    const single = registryFile([{ id: 'only', url: 'https://forgejo.example.com' }]).instances;
    const match = matchInstanceForRemotes(
      [
        { name: 'origin', url: 'https://unrelated.example.com/owner/repo.git' },
        { name: 'upstream', url: 'https://forgejo.example.com/owner/repo.git' },
      ],
      single,
    );
    expect(match?.remoteUrl).toBe('https://forgejo.example.com/owner/repo.git');
    expect(match?.ambiguous).toBe(false);
  });
});

describe('discoverDataDirs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-autoconfig-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('honors the FORGEJO_MCP_DATA_DIR override verbatim', async () => {
    const override = path.join(tempDir, 'custom-data');
    const search = await discoverDataDirs(makeOptions({ cwd: tempDir, env: { FORGEJO_MCP_DATA_DIR: override } }));
    expect(search.dirs).toEqual([override]);
  });

  it('expands the platform default plus one glob level of profiles', async () => {
    // A fake Linux home with a profiled VS Code install: the default
    // globalStorage and the profile's variant must both be found.
    const homeDir = path.join(tempDir, 'home');
    const profileStorage = path.join(
      homeDir,
      '.config',
      'Code',
      'User',
      'profiles',
      'abc123',
      'globalStorage',
      'cpf23333.forgejo-toolkit',
    );
    fs.mkdirSync(profileStorage, { recursive: true });
    const search = await discoverDataDirs(makeOptions({ cwd: tempDir, homeDir }));
    expect(search.dirs).toContain(
      path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'cpf23333.forgejo-toolkit'),
    );
    expect(search.dirs).toContain(profileStorage);
    expect(search.dirs).toContain(
      path.join(homeDir, '.config', 'Code - Insiders', 'User', 'globalStorage', 'cpf23333.forgejo-toolkit'),
    );
  });
});

describe('resolveAutoConfiguration', () => {
  let tempDir: string;
  let dataDir: string;
  let cwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-autoconfig-test-'));
    dataDir = path.join(tempDir, 'globalStorage');
    cwd = path.join(tempDir, 'checkout');
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function options(): AutoConfigOptions {
    return makeOptions({ cwd, env: { FORGEJO_MCP_DATA_DIR: dataDir } });
  }

  it('fails with the searched directories listed when no registry exists anywhere', async () => {
    const result = await resolveAutoConfiguration(options());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(result.message).toContain(dataDir);
    expect(result.message).toContain('FORGEJO_MCP_INSTANCE_URL');
  });

  it('fails with the corrupt file named when the registry does not parse', async () => {
    writeRegistry(dataDir, 'this is not json{');
    const result = await resolveAutoConfiguration(options());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(result.message).toContain(path.join(dataDir, 'mcp-instances.json'));
  });

  it('takes the instance URL from the newest state file when the cwd is one of its checkouts', async () => {
    writeRegistry(dataDir, registryFile([{}]));
    const stateFilePath = writeStateFile(dataDir, 'mcp-workspace-1234-abcd1234.json', [
      {
        instanceId: 'instance-1',
        instanceUrl: 'https://forgejo.example.com',
        owner: 'demo-user',
        repo: 'demo-repo',
        localPath: cwd,
        active: true,
      },
    ]);

    const result = await resolveAutoConfiguration(options());

    expect(result).toMatchObject({
      status: 'matched',
      url: 'https://forgejo.example.com',
      via: 'state-file',
      stateFile: stateFilePath,
    });
  });

  it('consults only the newest state file for the shortcut', async () => {
    // An older file knows this cwd, the newest does not: a stale second
    // opinion must not win over falling through to remote matching.
    writeRegistry(dataDir, registryFile([{}]));
    const entry = {
      instanceId: 'instance-1',
      instanceUrl: 'https://forgejo.example.com',
      owner: 'demo-user',
      repo: 'demo-repo',
      localPath: cwd,
      active: true,
    };
    const older = writeStateFile(dataDir, 'mcp-workspace-1111-aaaa1111.json', [entry]);
    writeStateFile(dataDir, 'mcp-workspace-2222-bbbb2222.json', []);
    fs.utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    writeGitConfig(cwd, '[remote "origin"]\n\turl = https://forgejo.example.com/demo-user/demo-repo.git\n');

    const result = await resolveAutoConfiguration(options());

    expect(result.status).toBe('matched');
    if (result.status !== 'matched') {
      throw new Error('unreachable');
    }
    expect(result.via).toBe('git-remote');
  });

  it('matches an https remote from .git/config when the state file has no entry for the cwd', async () => {
    writeRegistry(dataDir, registryFile([{}]));
    writeGitConfig(cwd, '[remote "origin"]\n\turl = https://forgejo.example.com/demo-user/demo-repo.git\n');

    const result = await resolveAutoConfiguration(options());

    expect(result).toMatchObject({ status: 'matched', url: 'https://forgejo.example.com', via: 'git-remote' });
  });

  it('matches an scp-style remote against the instance host', async () => {
    writeRegistry(dataDir, registryFile([{}]));
    writeGitConfig(cwd, '[remote "origin"]\n\turl = git@forgejo.example.com:demo-user/demo-repo.git\n');

    const result = await resolveAutoConfiguration(options());

    expect(result).toMatchObject({ status: 'matched', via: 'git-remote' });
  });

  it('reads the remotes of a worktree through the gitfile and commondir', async () => {
    // A linked worktree has a .git *file* whose gitdir carries no config; the
    // remotes live in the common directory the commondir file names.
    writeRegistry(dataDir, registryFile([{}]));
    const mainGitDir = path.join(tempDir, 'main-checkout', '.git');
    const worktreeGitDir = path.join(mainGitDir, 'worktrees', 'wt');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
    fs.writeFileSync(
      path.join(mainGitDir, 'config'),
      '[remote "origin"]\n\turl = https://forgejo.example.com/demo-user/demo-repo.git\n',
      'utf8',
    );

    const result = await resolveAutoConfiguration(options());

    expect(result).toMatchObject({ status: 'matched', via: 'git-remote' });
  });

  it('reports the ambiguity when several instances share the matched host', async () => {
    writeRegistry(
      dataDir,
      registryFile([
        { id: 'account-alice', url: 'https://forgejo.example.com', name: 'Alice' },
        { id: 'account-bob', url: 'https://forgejo.example.com', name: 'Bob' },
      ]),
    );
    writeGitConfig(cwd, '[remote "origin"]\n\turl = git@forgejo.example.com:demo-user/demo-repo.git\n');

    const result = await resolveAutoConfiguration(options());

    expect(result.status).toBe('matched');
    if (result.status !== 'matched') {
      throw new Error('unreachable');
    }
    expect(result.url).toBe('https://forgejo.example.com');
    expect(result.note).toContain('Alice');
  });

  it('strips credential userinfo from registry URLs before using them', async () => {
    // The writer already strips, but the file is a trust boundary: a damaged
    // or hand-edited registry must not leak credentials into logs or requests.
    writeRegistry(dataDir, registryFile([{ url: 'https://token-abc123@forgejo.example.com' }]));
    writeGitConfig(cwd, '[remote "origin"]\n\turl = https://forgejo.example.com/demo-user/demo-repo.git\n');

    const result = await resolveAutoConfiguration(options());

    expect(result.status).toBe('matched');
    if (result.status !== 'matched') {
      throw new Error('unreachable');
    }
    expect(result.url).not.toContain('token-abc123');
  });

  it('fails with the configured instance URLs listed when nothing matches', async () => {
    writeRegistry(
      dataDir,
      registryFile([
        { url: 'https://forgejo.example.com' },
        { id: 'instance-2', url: 'https://other.example.com', name: 'Other' },
      ]),
    );
    writeGitConfig(cwd, '[remote "origin"]\n\turl = https://unrelated.example.com/demo-user/demo-repo.git\n');

    const result = await resolveAutoConfiguration(options());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(result.message).toContain('https://forgejo.example.com');
    expect(result.message).toContain('https://other.example.com');
  });

  it('fails cleanly when the cwd is not a git repository and no state file matches', async () => {
    // No .git at all and no state file to guess from: remote matching and the
    // fallback are both skipped, and the error names the empty registry as the
    // reason nothing could be matched.
    writeRegistry(dataDir, registryFile());

    const result = await resolveAutoConfiguration(options());

    expect(result.status).toBe('failed');
  });

  it('falls back to the active entry of the newest state file when the cwd matches nothing', async () => {
    // The Agents window's Agent Host launches the server with the user's home
    // directory as cwd: not a checkout, not in any state file. The fallback
    // guesses the instance the user most recently worked with — the entry the
    // writer flagged active — instead of exiting with an error.
    writeRegistry(dataDir, registryFile([{}]));
    writeStateFile(dataDir, 'mcp-workspace-1234-abcd1234.json', [
      {
        instanceId: 'instance-1',
        instanceUrl: 'https://forgejo.example.com',
        owner: 'demo-user',
        repo: 'demo-repo',
        localPath: path.join(tempDir, 'some-checkout'),
        active: false,
      },
      {
        instanceId: 'instance-2',
        instanceUrl: 'https://other.example.com',
        owner: 'org',
        repo: 'lib',
        localPath: path.join(tempDir, 'other-checkout'),
        active: true,
      },
    ]);

    const result = await resolveAutoConfiguration(options());

    expect(result).toMatchObject({ status: 'matched', url: 'https://other.example.com', via: 'state-file-fallback' });
  });

  it('falls back to the first entry when no entry is flagged active', async () => {
    // The writer only sets active on unambiguous attribution, so it may be
    // false on every entry; the first entry is the fallback's fallback.
    writeRegistry(dataDir, registryFile([{}]));
    writeStateFile(dataDir, 'mcp-workspace-1234-abcd1234.json', [
      {
        instanceId: 'instance-1',
        instanceUrl: 'https://forgejo.example.com',
        owner: 'demo-user',
        repo: 'demo-repo',
        localPath: path.join(tempDir, 'some-checkout'),
        active: false,
      },
      {
        instanceId: 'instance-2',
        instanceUrl: 'https://other.example.com',
        owner: 'org',
        repo: 'lib',
        localPath: path.join(tempDir, 'other-checkout'),
        active: false,
      },
    ]);

    const result = await resolveAutoConfiguration(options());

    expect(result).toMatchObject({ status: 'matched', url: 'https://forgejo.example.com', via: 'state-file-fallback' });
  });

  it('guesses from the newest state file only, ignoring older files', async () => {
    // The older file's active entry names a different instance; the newest
    // file is the one whose guess counts — stale second opinions must not
    // outvote it.
    writeRegistry(dataDir, registryFile([{}]));
    const older = writeStateFile(dataDir, 'mcp-workspace-1111-aaaa1111.json', [
      {
        instanceId: 'instance-2',
        instanceUrl: 'https://other.example.com',
        owner: 'org',
        repo: 'lib',
        localPath: path.join(tempDir, 'other-checkout'),
        active: true,
      },
    ]);
    writeStateFile(dataDir, 'mcp-workspace-2222-bbbb2222.json', [
      {
        instanceId: 'instance-1',
        instanceUrl: 'https://forgejo.example.com',
        owner: 'demo-user',
        repo: 'demo-repo',
        localPath: path.join(tempDir, 'some-checkout'),
        active: true,
      },
    ]);
    fs.utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const result = await resolveAutoConfiguration(options());

    expect(result).toMatchObject({ status: 'matched', url: 'https://forgejo.example.com', via: 'state-file-fallback' });
  });

  it('prefers a git remote match over the state-file fallback guess', async () => {
    // The fallback is a guess; a real remote match of the working directory
    // always beats it.
    writeRegistry(dataDir, registryFile([{}]));
    writeStateFile(dataDir, 'mcp-workspace-1234-abcd1234.json', [
      {
        instanceId: 'instance-2',
        instanceUrl: 'https://other.example.com',
        owner: 'org',
        repo: 'lib',
        localPath: path.join(tempDir, 'other-checkout'),
        active: true,
      },
    ]);
    writeGitConfig(cwd, '[remote "origin"]\n\turl = https://forgejo.example.com/demo-user/demo-repo.git\n');

    const result = await resolveAutoConfiguration(options());

    expect(result).toMatchObject({ status: 'matched', url: 'https://forgejo.example.com', via: 'git-remote' });
  });

  it('matches the state-file localPath case-insensitively on Windows', async () => {
    writeRegistry(dataDir, registryFile([{}]));
    writeStateFile(dataDir, 'mcp-workspace-1234-abcd1234.json', [
      {
        instanceId: 'instance-1',
        instanceUrl: 'https://forgejo.example.com',
        owner: 'demo-user',
        repo: 'demo-repo',
        localPath: cwd.toUpperCase(),
        active: true,
      },
    ]);

    const result = await resolveAutoConfiguration(
      makeOptions({ cwd, env: { FORGEJO_MCP_DATA_DIR: dataDir }, platform: 'win32' }),
    );

    expect(result.status).toBe('matched');
  });

  // Explicit-env priority itself is wiring in server.ts (resolveAutoConfiguration
  // is only called when FORGEJO_MCP_INSTANCE_URL is absent) and is not
  // duplicated here; what this module guarantees is that the override env it
  // *does* own — FORGEJO_MCP_DATA_DIR — short-circuits all default discovery,
  // covered by the discoverDataDirs test above.
});
