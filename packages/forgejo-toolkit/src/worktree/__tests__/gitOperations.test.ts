import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  probeRepository: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: mocks.exec,
  execFile: mocks.execFile,
}));

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return { probeRepository: clientMocks.probeRepository };
  }),
}));

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
    stat: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(async () => []),
    rm: vi.fn(),
  },
}));

import {
  addRemote,
  clearLinkedRepositoryCache,
  cloneRepository,
  createWorktreeFromBranch,
  createWorktreeWithNewBranch,
  detectLinkedRepositories,
  detectLinkedRepository,
  discardStalePrWorktree,
  fetchBranch,
  fetchPullRequestHead,
  getRemoteUrl,
  getRefCommitSha,
  inspectPrWorktree,
  listRemotes,
  listWorkspaceRepositories,
  openWorktree,
  preferOwnNamespaceInstance,
  pushBranch,
  remoteMatchesInstance,
  resolveRemoteForRepo,
  revertMergeCommit,
} from '../gitOperations';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../../logger';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function failWithTokenInCommandLine() {
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    // Simulate what promisify(cp.execFile) produces on failure: error.message
    // contains the full command line (including the token), stderr is attached.
    const error = new Error(`Command failed: git ${args.join(' ')}`) as Error & { stderr: string };
    error.stderr = 'fatal: Authentication failed';
    callback(error, '', error.stderr);
  });
}

describe('gitOperations token leak prevention', () => {
  const token = 'secret-token-abc123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushBranch rethrows without the token in the message', async () => {
    failWithTokenInCommandLine();
    await expect(pushBranch('/repo', 'origin', 'main', token, true)).rejects.toThrow('fatal: Authentication failed');
    await expect(pushBranch('/repo', 'origin', 'main', token, true)).rejects.not.toThrow(token);
  });

  it('cloneRepository rethrows without the token in the message', async () => {
    failWithTokenInCommandLine();
    await expect(cloneRepository('https://forgejo.example.com/a/b.git', '/tmp/b', token)).rejects.not.toThrow(token);
  });

  it('fetchPullRequestHead rethrows without the token in the message', async () => {
    failWithTokenInCommandLine();
    await expect(fetchPullRequestHead('/repo', 'origin', 1, 'pr-1', token)).rejects.not.toThrow(token);
  });

  it('falls back to a generic message when stderr is empty', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        const error = new Error(`Command failed: git push`) as Error & {
          stderr: string;
        };
        error.stderr = '';
        callback(error, '', '');
      },
    );
    const failure = await pushBranch('/repo', 'origin', 'main', token).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(token);
  });

  it('never puts the token on the git command line for push/clone/fetch', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, '', '');
      },
    );
    await pushBranch('/repo', 'origin', 'main', token);
    await cloneRepository('https://forgejo.example.com/a/b.git', '/tmp/b', token);
    await fetchPullRequestHead('/repo', 'origin', 1, 'pr-1', token);
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
    for (const call of mocks.execFile.mock.calls) {
      for (const arg of call[1] as string[]) {
        expect(arg).not.toContain(token);
      }
      const env = (call[2] as { env?: NodeJS.ProcessEnv }).env;
      expect(env?.GIT_CONFIG_COUNT).toBe('1');
      expect(env?.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
      expect(env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: token ${token}`);
    }
  });
});

describe('pushBranch remote ownership check (TOCTOU guard)', () => {
  const token = 'secret-token-abc123';
  const instanceUrl = 'https://forgejo.example.com';

  function mockRemoteUrlThenPush(remoteUrl: string | undefined) {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          if (remoteUrl === undefined) {
            const error = new Error('Command failed: git remote get-url') as Error & { stderr: string };
            error.stderr = 'fatal: No such remote';
            callback(error, '', error.stderr);
          } else {
            // promisify(cp.execFile) on the mock resolves with only the first
            // callback value, so hand runGit its { stdout, stderr } shape
            // directly instead of separate string arguments.
            callback(null, { stdout: `${remoteUrl}\n`, stderr: '' } as unknown as string, '');
          }
          return;
        }
        callback(null, '', '');
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushes with the token when the remote URL matches the instance', async () => {
    mockRemoteUrlThenPush('https://forgejo.example.com/owner/repo.git');
    await pushBranch('/repo', 'origin', 'main', token, true, instanceUrl);
    const pushCall = mocks.execFile.mock.calls.find((call) => (call[1] as string[]).includes('push'));
    expect(pushCall).toBeDefined();
    expect(pushCall![1]).toEqual(['push', '-u', 'origin', 'main']);
    const env = (pushCall![2] as { env?: NodeJS.ProcessEnv }).env;
    expect(env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: token ${token}`);
  });

  it('aborts without pushing when the remote URL belongs to another host', async () => {
    mockRemoteUrlThenPush('https://github.example.com/owner/repo.git');
    const failure = await pushBranch('/repo', 'origin', 'main', token, true, instanceUrl).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('does not belong to the expected Forgejo instance');
    expect((failure as Error).message).not.toContain(token);
    expect((failure as Error).message).not.toContain('github.example.com');
    // The push itself must never run.
    for (const call of mocks.execFile.mock.calls) {
      expect(call[1]).not.toContain('push');
    }
  });

  it('drops the token when the remote URL cannot be resolved', async () => {
    mockRemoteUrlThenPush(undefined);
    await pushBranch('/repo', 'origin', 'main', token, false, instanceUrl);
    const pushCall = mocks.execFile.mock.calls.find((call) => (call[1] as string[]).includes('push'));
    expect(pushCall).toBeDefined();
    expect(pushCall![1]).toEqual(['push', 'origin', 'main']);
    const env = (pushCall![2] as { env?: NodeJS.ProcessEnv }).env;
    expect(env?.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it('skips the check when tokenInstanceUrl is not given', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, '', '');
      },
    );
    await pushBranch('/repo', 'origin', 'main', token, false);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'main'],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: token ${token}`,
        }),
      }),
      expect.any(Function),
    );
  });

  it('aborts when a pushurl target belongs to another host (fetch URL still matches)', async () => {
    // `git remote -v` / `remote get-url` report the Forgejo fetch URL here, so
    // only resolving the push targets exposes the mirror that git pushes to.
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          callback(
            null,
            {
              stdout: 'https://forgejo.example.com/owner/repo.git\nhttps://mirror.example.com/owner/repo.git\n',
              stderr: '',
            } as unknown as string,
            '',
          );
          return;
        }
        callback(null, '', '');
      },
    );

    const failure = await pushBranch('/repo', 'origin', 'main', token, false, instanceUrl).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('does not belong to the expected Forgejo instance');
    expect((failure as Error).message).not.toContain(token);
    expect((failure as Error).message).not.toContain('mirror.example.com');
    for (const call of mocks.execFile.mock.calls) {
      expect(call[1]).not.toContain('push');
    }
    // The check must ask git for the push targets rather than the fetch URL.
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['remote', 'get-url', '--push', '--all', 'origin'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('pushes with the token when every push target belongs to the instance', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          callback(
            null,
            {
              stdout: 'https://forgejo.example.com/owner/repo.git\nssh://git@forgejo.example.com:2222/owner/repo.git\n',
              stderr: '',
            } as unknown as string,
            '',
          );
          return;
        }
        callback(null, '', '');
      },
    );

    await pushBranch('/repo', 'origin', 'main', token, false, instanceUrl);
    const pushCall = mocks.execFile.mock.calls.find((call) => (call[1] as string[]).includes('push'));
    expect(pushCall![1]).toEqual(['push', 'origin', 'main']);
    expect((pushCall![2] as { env?: NodeJS.ProcessEnv }).env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: token ${token}`);
  });
});

describe('remoteMatchesInstance', () => {
  it('matches http and ssh remotes of the instance host', () => {
    expect(remoteMatchesInstance('https://forgejo.example.com/owner/repo.git', 'https://forgejo.example.com')).toBe(
      true,
    );
    expect(remoteMatchesInstance('git@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com')).toBe(true);
  });

  it('rejects remotes of other hosts and unparseable URLs', () => {
    expect(remoteMatchesInstance('https://github.example.com/owner/repo.git', 'https://forgejo.example.com')).toBe(
      false,
    );
    expect(remoteMatchesInstance('not a url', 'https://forgejo.example.com')).toBe(false);
    expect(remoteMatchesInstance('https://forgejo.example.com/owner/repo.git', 'not a url')).toBe(false);
  });

  it('matches ssh:// remotes with a custom port against the instance host', () => {
    expect(
      remoteMatchesInstance('ssh://git@forgejo.example.com:2222/owner/repo.git', 'https://forgejo.example.com'),
    ).toBe(true);
    expect(remoteMatchesInstance('git://forgejo.example.com:9418/owner/repo.git', 'https://forgejo.example.com')).toBe(
      true,
    );
  });

  it('matches https remotes and instances on the same non-default port', () => {
    expect(
      remoteMatchesInstance('https://forgejo.example.com:8443/owner/repo.git', 'https://forgejo.example.com:8443'),
    ).toBe(true);
    expect(
      remoteMatchesInstance('https://forgejo.example.com:8443/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(false);
  });

  it('ignores the instance web port for ssh/git remotes', () => {
    // Self-hosted servers commonly serve SSH on 2222 while the web UI runs on
    // 3000; the two ports have no correspondence, so ssh/git remotes match the
    // instance host regardless of the instance URL's port.
    expect(
      remoteMatchesInstance('ssh://git@forgejo.example.com:2222/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(true);
    expect(remoteMatchesInstance('git@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com:3000')).toBe(
      true,
    );
    expect(
      remoteMatchesInstance('git://forgejo.example.com:9418/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(true);
    // ...but the host must still match.
    expect(
      remoteMatchesInstance('ssh://git@other.example.com:2222/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(false);
  });

  it('keeps requiring the port for https remotes', () => {
    expect(
      remoteMatchesInstance('https://forgejo.example.com:8443/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(false);
    expect(
      remoteMatchesInstance('https://forgejo.example.com/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(false);
  });
});

describe('gitOperations argument passing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, '', '');
      },
    );
  });

  it('pushBranch passes the branch as a single argv entry (no shell interpolation)', async () => {
    const branch = 'feature/$(touch pwned)';
    await pushBranch('/repo', 'origin', branch);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', branch],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('cloneRepository passes --quiet so clone progress does not overflow stderr maxBuffer', async () => {
    await cloneRepository('https://forgejo.example.com/a/b.git', '/tmp/b');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['clone', '--bare', '--quiet', 'https://forgejo.example.com/a/b.git', '/tmp/b'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('pushBranch adds -u when setUpstream is true and passes the token via env config', async () => {
    await pushBranch('/repo', 'origin', 'main', 'tok', true);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', '-u', 'origin', 'main'],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_VALUE_0: 'Authorization: token tok',
        }),
      }),
      expect.any(Function),
    );
  });

  it('fetchPullRequestHead passes the refspec as a single argv entry', async () => {
    const localBranch = 'pr-1; rm -rf /';
    await fetchPullRequestHead('/repo', 'origin', 1, localBranch);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', `refs/pull/1/head:${localBranch}`],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('getRemoteUrl passes the remote name as a single argv entry', async () => {
    const remote = 'up;stream$(touch pwned)';
    await getRemoteUrl('/repo', remote);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['remote', 'get-url', remote],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('addRemote passes remote and url as single argv entries', async () => {
    const remote = 'fork$(touch pwned)';
    const url = 'https://forgejo.example.com/a/b.git" && evil';
    await addRemote('/repo', remote, url);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['remote', 'add', remote, url],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('createWorktreeFromBranch passes branch and path as single argv entries', async () => {
    const branch = 'pr-1$(touch pwned)';
    const worktreePath = '/cache/worktrees/evil" && pwned';
    await createWorktreeFromBranch('/repo', worktreePath, branch);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-B', branch, worktreePath, branch],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('fetchBranch passes the branch as a single argv entry and the token via env config', async () => {
    const branch = 'main$(touch pwned)';
    await fetchBranch('/repo', 'origin', branch, 'tok');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', branch],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_VALUE_0: 'Authorization: token tok',
        }),
      }),
      expect.any(Function),
    );
  });

  it('createWorktreeWithNewBranch passes branch, path and start point as single argv entries', async () => {
    const branch = 'issue-1-fix$(touch pwned)';
    const worktreePath = '/cache/worktrees/evil" && pwned';
    await createWorktreeWithNewBranch('/repo', worktreePath, branch, 'FETCH_HEAD');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-B', branch, worktreePath, 'FETCH_HEAD'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('revertMergeCommit passes the merge sha as a single argv entry', async () => {
    const sha = 'abc123$(touch pwned)';
    await revertMergeCommit('/repo', sha);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['revert', '-m', '1', '--no-edit', sha],
      expect.anything(),
      expect.any(Function),
    );
    // No upstream configured in this mock: falls back to a plain origin push.
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'HEAD'],
      expect.anything(),
      expect.any(Function),
    );
  });
});

function mockGitSequence(handlers: Array<[string, string]>) {
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    const cmd = args.join(' ');
    for (const [prefix, stdout] of handlers) {
      if (cmd.startsWith(prefix)) {
        callback(null, { stdout, stderr: '' } as unknown as string, '');
        return;
      }
    }
    callback(null, { stdout: '', stderr: '' } as unknown as string, '');
  });
}

describe('revertMergeCommit branch guard and token push', () => {
  const token = 'secret-token-abc123';
  const instanceUrl = 'https://forgejo.example.com';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aborts before reverting when the current branch is not the base branch', async () => {
    mockGitSequence([['rev-parse --abbrev-ref HEAD', 'feature-x\n']]);
    await expect(revertMergeCommit('/repo', 'abc123', 'main')).rejects.toThrow('base branch');
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['revert']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('reverts and pushes with the token to the upstream branch', async () => {
    mockGitSequence([
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
      ['remote get-url --push --all origin', 'https://forgejo.example.com/owner/repo.git\n'],
    ]);
    await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['revert', '-m', '1', '--no-edit', 'abc123'],
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'HEAD:main'],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_VALUE_0: `Authorization: token ${token}`,
        }),
      }),
      expect.any(Function),
    );
  });

  it('aborts the push when the remote belongs to another host', async () => {
    mockGitSequence([
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
      ['remote get-url --push --all origin', 'https://github.example.com/owner/repo.git\n'],
    ]);
    await expect(revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl)).rejects.toThrow('does not belong');
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['push']),
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe('openWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [];
  });

  it('opens in a new window without asking', async () => {
    await expect(openWorktree('/wt', true)).resolves.toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', expect.anything(), true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('returns false when the replace-current-window confirmation is dismissed', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
    await expect(openWorktree('/wt', false)).resolves.toBe(false);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('opens in the current window after confirmation', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Open' as never);
    await expect(openWorktree('/wt', false)).resolves.toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', expect.anything(), false);
  });

  it('treats an already-open worktree as opened without asking', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/wt' } }];
    await expect(openWorktree('/wt', false)).resolves.toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});

describe('detectLinkedRepository', () => {
  const instanceAlice: ForgejoInstance = {
    id: 'host-alice',
    url: 'https://forgejo.example.com',
    token: '',
    name: 'alice@host',
    username: 'alice',
  };
  const instanceBob: ForgejoInstance = {
    id: 'host-bob',
    url: 'https://forgejo.example.com',
    token: '',
    name: 'bob@host',
    username: 'bob',
  };

  /**
   * Mock git remote queries. Each value is either a single URL (shorthand for
   * `origin`) or a map of remote name to URL, reported via both
   * `git remote -v` and `git remote get-url <name>`.
   */
  function mockRemotes(remotesByCwd: Record<string, string | Record<string, string>>) {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], options: { cwd?: string }, callback: ExecFileCallback) => {
        const entry = options?.cwd ? remotesByCwd[options.cwd] : undefined;
        const remotes: Record<string, string> = entry ? (typeof entry === 'string' ? { origin: entry } : entry) : {};
        if (args[0] === 'remote' && args[1] === '-v') {
          const stdout = Object.entries(remotes)
            .map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)`)
            .join('\n');
          callback(null, { stdout: stdout ? `${stdout}\n` : '', stderr: '' } as unknown as string, '');
          return;
        }
        if (args[0] === 'remote' && args[1] === 'get-url') {
          const url = remotes[args[2]];
          if (url) {
            callback(null, { stdout: `${url}\n`, stderr: '' } as unknown as string, '');
          } else {
            const error = new Error('Command failed: git remote get-url') as Error & { stderr: string };
            error.stderr = 'fatal: No such remote';
            callback(error, '', error.stderr);
          }
          return;
        }
        callback(null, '', '');
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clientMocks.probeRepository.mockReset();
    // The detection scan is cached module-wide (short TTL); isolate tests
    // from each other.
    clearLinkedRepositoryCache();
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [];
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
    // Default filesystem layout: every directory looks like a repo (access
    // always succeeds) and has no subdirectories to scan.
    (fs.promises.access as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
    (fs.promises.readdir as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => []);
  });

  /**
   * Simulate a filesystem layout for repository detection: `repos` are the
   * directories containing a `.git` entry, `children` maps a directory to the
   * names of its subdirectories.
   */
  function mockFsLayout(repos: string[], children: Record<string, string[]>) {
    const gitMarkers = new Set(repos.map((repoPath) => path.join(repoPath, '.git')));
    (fs.promises.access as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (p: unknown) => {
      if (gitMarkers.has(String(p))) {
        return undefined;
      }
      throw new Error('ENOENT');
    });
    (fs.promises.readdir as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (p: unknown) => {
      const names = children[String(p)] ?? [];
      return names.map((name) => ({ name, isDirectory: () => true }));
    });
  }

  it('prefers the workspace folder containing the active editor', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: '/ws/a' } },
      { uri: { fsPath: '/ws/b' } },
    ];
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/ws/b/src/file.ts' } },
    };
    mockRemotes({
      '/ws/a': 'https://forgejo.example.com/alice/repo-a.git',
      '/ws/b': 'https://forgejo.example.com/alice/repo-b.git',
    });

    const linked = await detectLinkedRepository([instanceAlice]);

    expect(linked?.localPath).toBe('/ws/b');
    expect(linked?.repo).toBe('repo-b');
  });

  it('falls back to the first matching folder when no editor is active', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: '/ws/a' } },
      { uri: { fsPath: '/ws/b' } },
    ];
    mockRemotes({
      '/ws/a': 'https://forgejo.example.com/alice/repo-a.git',
      '/ws/b': 'https://forgejo.example.com/alice/repo-b.git',
    });

    const linked = await detectLinkedRepository([instanceAlice]);

    expect(linked?.localPath).toBe('/ws/a');
  });

  it('binds the account whose username matches the remote owner', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
    mockRemotes({ '/ws/a': 'https://forgejo.example.com/bob/repo.git' });

    const linked = await detectLinkedRepository([instanceAlice, instanceBob]);

    expect(linked?.instanceId).toBe('host-bob');
  });

  it('keeps the first match and logs the ambiguity when the owner does not disambiguate', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
    mockRemotes({ '/ws/a': 'https://forgejo.example.com/someone-else/repo.git' });
    const infoSpy = vi.spyOn(logger, 'info');

    const linked = await detectLinkedRepository([instanceAlice, instanceBob]);

    expect(linked?.instanceId).toBe('host-alice');
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('2 accounts match'));
  });

  it('detectLinkedRepositories returns every match plus the attributed one', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: '/ws/a' } },
      { uri: { fsPath: '/ws/b' } },
    ];
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/ws/b/src/file.ts' } },
    };
    mockRemotes({
      '/ws/a': 'https://forgejo.example.com/alice/repo-a.git',
      '/ws/b': 'https://forgejo.example.com/alice/repo-b.git',
    });

    const result = await detectLinkedRepositories([instanceAlice]);

    expect(result.all.map((m) => m.localPath).sort()).toEqual(['/ws/a', '/ws/b']);
    expect(result.linked?.localPath).toBe('/ws/b');
  });

  it('detectLinkedRepositories reports repositories without a Forgejo remote as unpublished', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: '/ws/a' } },
      { uri: { fsPath: '/ws/b' } },
      { uri: { fsPath: '/ws/c' } },
    ];
    mockRemotes({
      '/ws/a': 'https://forgejo.example.com/alice/repo-a.git',
      // Points at another host: no Forgejo remote yet.
      '/ws/b': 'https://git.example.com/alice/repo-b.git',
      // No remotes at all (cwd absent from the map): publishable too.
    });

    const result = await detectLinkedRepositories([instanceAlice]);

    expect(result.linked?.localPath).toBe('/ws/a');
    expect(result.unpublished.sort()).toEqual(['/ws/b', '/ws/c']);
  });

  it('links via a non-origin remote when origin does not match any instance', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
    mockRemotes({
      '/ws/a': {
        origin: 'https://git.example.com/alice/repo.git',
        forgejo: 'https://forgejo.example.com/alice/repo.git',
      },
    });

    const linked = await detectLinkedRepository([instanceAlice]);

    expect(linked?.localPath).toBe('/ws/a');
    expect(linked?.remoteUrl).toBe('https://forgejo.example.com/alice/repo.git');
    // The second remote host-matches in the cheap pass, so no repo-path
    // fallback probe is needed for the non-matching origin.
    expect(clientMocks.probeRepository).not.toHaveBeenCalled();
  });

  it('prefers origin when several remotes match configured instances', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
    mockRemotes({
      '/ws/a': {
        upstream: 'https://forgejo.example.com/alice/upstream-repo.git',
        origin: 'https://forgejo.example.com/alice/repo.git',
      },
    });

    const linked = await detectLinkedRepository([instanceAlice]);

    expect(linked?.repo).toBe('repo');
  });

  it('discovers nested repositories one level below a non-repo folder', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/root' } }];
    const dirA = path.join('/root', 'a');
    const dirB = path.join('/root', 'b');
    mockFsLayout([dirA, dirB], { '/root': ['a', 'b'] });
    mockRemotes({
      [dirA]: 'https://forgejo.example.com/alice/repo-a.git',
      [dirB]: 'https://forgejo.example.com/alice/repo-b.git',
    });

    const linked = await detectLinkedRepository([instanceAlice]);

    expect(linked?.localPath).toBe(dirA);
    expect(linked?.repo).toBe('repo-a');
  });

  it('attributes the active editor to the nested repository containing it', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/root' } }];
    const dirNested = path.join('/root', 'nested');
    mockFsLayout(['/root', dirNested], { '/root': ['nested'] });
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
      document: { uri: { fsPath: path.join('/root', 'nested', 'src', 'file.ts') } },
    };
    mockRemotes({
      '/root': 'https://forgejo.example.com/alice/root-repo.git',
      [dirNested]: 'https://forgejo.example.com/alice/nested-repo.git',
    });

    const linked = await detectLinkedRepository([instanceAlice]);

    expect(linked?.localPath).toBe(dirNested);
    expect(linked?.repo).toBe('nested-repo');
  });

  it('prefers options.preferredPath over the active editor for attribution', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/root' } }];
    const dirA = path.join('/root', 'a');
    const dirB = path.join('/root', 'b');
    mockFsLayout([dirA, dirB], { '/root': ['a', 'b'] });
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
      document: { uri: { fsPath: path.join('/root', 'a', 'file.ts') } },
    };
    mockRemotes({
      [dirA]: 'https://forgejo.example.com/alice/repo-a.git',
      [dirB]: 'https://forgejo.example.com/alice/repo-b.git',
    });

    const linked = await detectLinkedRepository([instanceAlice], {
      preferredPath: path.join('/root', 'b', 'other.ts'),
    });

    expect(linked?.repo).toBe('repo-b');
  });

  it('asks the user to pick when several repositories match and pickOnAmbiguity is set', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/root' } }];
    const dirA = path.join('/root', 'a');
    const dirB = path.join('/root', 'b');
    mockFsLayout([dirA, dirB], { '/root': ['a', 'b'] });
    mockRemotes({
      [dirA]: 'https://forgejo.example.com/alice/repo-a.git',
      [dirB]: 'https://forgejo.example.com/alice/repo-b.git',
    });
    vi.mocked(vscode.window.showQuickPick).mockImplementation(
      async (items: unknown) => (items as unknown[])[1] as never,
    );

    const linked = await detectLinkedRepository([instanceAlice], { pickOnAmbiguity: true });

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(linked?.repo).toBe('repo-b');
    expect(linked?.localPath).toBe(dirB);
  });

  it('returns undefined when the ambiguity pick is dismissed', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/root' } }];
    const dirA = path.join('/root', 'a');
    const dirB = path.join('/root', 'b');
    mockFsLayout([dirA, dirB], { '/root': ['a', 'b'] });
    mockRemotes({
      [dirA]: 'https://forgejo.example.com/alice/repo-a.git',
      [dirB]: 'https://forgejo.example.com/alice/repo-b.git',
    });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as never);

    const linked = await detectLinkedRepository([instanceAlice], { pickOnAmbiguity: true });

    expect(linked).toBeUndefined();
  });

  it('returns the first match without prompting by default', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/root' } }];
    const dirA = path.join('/root', 'a');
    const dirB = path.join('/root', 'b');
    mockFsLayout([dirA, dirB], { '/root': ['a', 'b'] });
    mockRemotes({
      [dirA]: 'https://forgejo.example.com/alice/repo-a.git',
      [dirB]: 'https://forgejo.example.com/alice/repo-b.git',
    });

    const linked = await detectLinkedRepository([instanceAlice]);

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(linked?.repo).toBe('repo-a');
  });

  describe('repo-path fallback binding', () => {
    // A self-hosted server reachable under two network addresses: the
    // instance URL matches neither remote host, so host matching fails and
    // the fallback probes each instance for owner/repo. Placeholder domains
    // only (no literal IPs, per project rules).
    const instanceLan: ForgejoInstance = {
      id: 'lan',
      url: 'https://lan.example.com',
      token: '',
      name: 'u@lan',
      username: 'cpf23333',
    };
    const instanceVpnAlias: ForgejoInstance = {
      id: 'vpn-alias',
      url: 'https://vpn-alias.example.com',
      token: '',
      name: 'u@vpn-alias',
      username: 'cpf23333',
    };

    function setupUnmatchedRemote(remote = 'https://vpn.example.com/cpf23333/repo.git') {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
      mockRemotes({ '/ws/a': remote });
    }

    it('binds the instance that verifies the repository path', async () => {
      setupUnmatchedRemote('https://vpn.example.com/cpf23333/repo.git');
      clientMocks.probeRepository.mockResolvedValue(true);
      const infoSpy = vi.spyOn(logger, 'info');

      const linked = await detectLinkedRepository([instanceLan]);

      expect(linked?.instanceId).toBe('lan');
      expect(linked?.owner).toBe('cpf23333');
      expect(linked?.repo).toBe('repo');
      expect(clientMocks.probeRepository).toHaveBeenCalledTimes(1);
      expect(clientMocks.probeRepository).toHaveBeenCalledWith('cpf23333', 'repo');
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('repo-path fallback'));
    });

    it('does not count a repository linked via the fallback as unpublished', async () => {
      setupUnmatchedRemote('https://vpn.example.com/cpf23333/fallback-linked-repo.git');
      clientMocks.probeRepository.mockResolvedValue(true);

      const result = await detectLinkedRepositories([instanceLan]);

      // No remote host-matched (pass 1), but the repo-path fallback verified
      // the repository on the instance: it is published, so the Publish
      // button must not be offered for it.
      expect(result.all.map((m) => m.localPath)).toEqual(['/ws/a']);
      expect(result.unpublished).toEqual([]);
    });

    it('does not bind when no instance verifies the repository path', async () => {
      setupUnmatchedRemote('https://vpn.example.com/cpf23333/unverified-repo.git');
      clientMocks.probeRepository.mockResolvedValue(false);

      const linked = await detectLinkedRepository([instanceLan]);

      expect(linked).toBeUndefined();
    });

    it('binds the verifying instance when only one of several verifies', async () => {
      setupUnmatchedRemote('https://vpn.example.com/cpf23333/one-verifies-repo.git');
      clientMocks.probeRepository.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const linked = await detectLinkedRepository([instanceLan, instanceVpnAlias]);

      expect(linked?.instanceId).toBe('vpn-alias');
      expect(clientMocks.probeRepository).toHaveBeenCalledTimes(2);
    });

    it('binds the first and logs the ambiguity when several instances verify', async () => {
      setupUnmatchedRemote('https://vpn.example.com/cpf23333/ambiguous-repo.git');
      clientMocks.probeRepository.mockResolvedValue(true);
      const infoSpy = vi.spyOn(logger, 'info');

      const linked = await detectLinkedRepository([instanceLan, instanceVpnAlias]);

      expect(linked?.instanceId).toBe('lan');
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('bound to first'));
    });

    it('caches the positive binding and does not probe again on repeat detection', async () => {
      setupUnmatchedRemote('https://vpn.example.com/cpf23333/positive-cache-repo.git');
      clientMocks.probeRepository.mockResolvedValue(true);

      await detectLinkedRepository([instanceLan]);
      const linked = await detectLinkedRepository([instanceLan]);

      expect(linked?.instanceId).toBe('lan');
      expect(clientMocks.probeRepository).toHaveBeenCalledTimes(1);
    });

    it('caches the negative outcome and does not probe again on repeat detection', async () => {
      setupUnmatchedRemote('https://vpn.example.com/cpf23333/negative-cache-repo.git');
      clientMocks.probeRepository.mockResolvedValue(false);

      await detectLinkedRepository([instanceLan]);
      const linked = await detectLinkedRepository([instanceLan]);

      expect(linked).toBeUndefined();
      expect(clientMocks.probeRepository).toHaveBeenCalledTimes(1);
    });

    it('never probes when an instance host matches the remote', async () => {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
      mockRemotes({ '/ws/a': 'https://forgejo.example.com/alice/repo.git' });

      const linked = await detectLinkedRepository([instanceAlice]);

      expect(linked?.instanceId).toBe('host-alice');
      expect(clientMocks.probeRepository).not.toHaveBeenCalled();
    });
  });

  describe('shared scan cache', () => {
    function countRemoteListings(): number {
      return mocks.execFile.mock.calls.filter(
        (call) => (call[1] as string[])[0] === 'remote' && (call[1] as string[])[1] === '-v',
      ).length;
    }

    it('does not spawn git again for a repeated detection within the TTL', async () => {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
      mockRemotes({ '/ws/a': 'https://forgejo.example.com/alice/repo.git' });

      await detectLinkedRepository([instanceAlice]);
      const listingsAfterFirst = countRemoteListings();
      expect(listingsAfterFirst).toBeGreaterThan(0);

      const linked = await detectLinkedRepository([instanceAlice]);

      expect(linked?.localPath).toBe('/ws/a');
      expect(countRemoteListings()).toBe(listingsAfterFirst);
    });

    it('coalesces concurrent detections into a single scan', async () => {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
      mockRemotes({ '/ws/a': 'https://forgejo.example.com/alice/repo.git' });

      const [first, second] = await Promise.all([
        detectLinkedRepositories([instanceAlice]),
        detectLinkedRepositories([instanceAlice]),
      ]);

      expect(first.linked?.localPath).toBe('/ws/a');
      expect(second.linked?.localPath).toBe('/ws/a');
      expect(countRemoteListings()).toBe(1);
    });

    it('re-scans after clearLinkedRepositoryCache', async () => {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
      mockRemotes({ '/ws/a': 'https://forgejo.example.com/alice/repo.git' });

      await detectLinkedRepository([instanceAlice]);
      clearLinkedRepositoryCache();
      await detectLinkedRepository([instanceAlice]);

      expect(countRemoteListings()).toBe(2);
    });

    it('re-scans when the instance list changes', async () => {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
      mockRemotes({ '/ws/a': 'https://forgejo.example.com/alice/repo.git' });

      await detectLinkedRepository([instanceAlice]);
      const linked = await detectLinkedRepository([instanceAlice, instanceBob]);

      expect(linked?.instanceId).toBe('host-alice');
      expect(countRemoteListings()).toBe(2);
    });

    it('re-attributes to the active editor without re-scanning', async () => {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/root' } }];
      const dirA = path.join('/root', 'a');
      const dirB = path.join('/root', 'b');
      mockFsLayout([dirA, dirB], { '/root': ['a', 'b'] });
      mockRemotes({
        [dirA]: 'https://forgejo.example.com/alice/repo-a.git',
        [dirB]: 'https://forgejo.example.com/alice/repo-b.git',
      });
      (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
        document: { uri: { fsPath: path.join('/root', 'a', 'file.ts') } },
      };

      const first = await detectLinkedRepository([instanceAlice]);
      expect(first?.repo).toBe('repo-a');
      const listingsAfterFirst = countRemoteListings();

      (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
        document: { uri: { fsPath: path.join('/root', 'b', 'file.ts') } },
      };
      const second = await detectLinkedRepository([instanceAlice]);

      expect(second?.repo).toBe('repo-b');
      expect(countRemoteListings()).toBe(listingsAfterFirst);
    });

    it('re-scans after the TTL expires', async () => {
      vi.useFakeTimers();
      try {
        (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
        mockRemotes({ '/ws/a': 'https://forgejo.example.com/alice/repo.git' });

        await detectLinkedRepository([instanceAlice]);
        expect(countRemoteListings()).toBe(1);

        vi.setSystemTime(Date.now() + 11_000);
        await detectLinkedRepository([instanceAlice]);

        expect(countRemoteListings()).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still prompts per call with pickOnAmbiguity while reusing the scan', async () => {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/root' } }];
      const dirA = path.join('/root', 'a');
      const dirB = path.join('/root', 'b');
      mockFsLayout([dirA, dirB], { '/root': ['a', 'b'] });
      mockRemotes({
        [dirA]: 'https://forgejo.example.com/alice/repo-a.git',
        [dirB]: 'https://forgejo.example.com/alice/repo-b.git',
      });
      vi.mocked(vscode.window.showQuickPick).mockImplementation(
        async (items: unknown) => (items as unknown[])[0] as never,
      );

      await detectLinkedRepository([instanceAlice], { pickOnAmbiguity: true });
      const listingsAfterFirst = countRemoteListings();
      expect(listingsAfterFirst).toBeGreaterThan(0);
      await detectLinkedRepository([instanceAlice], { pickOnAmbiguity: true });

      expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(2);
      expect(countRemoteListings()).toBe(listingsAfterFirst);
    });
  });
});

describe('stale PR worktree inspection and discard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The leftover worktree directory exists on disk.
    (fs.promises.access as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
  });

  /**
   * Mock the git reads involved in the stale path: HEAD lookup in the
   * worktree (an old sha, so the directory is stale), the branch checked out
   * there, and success for everything else (worktree removal, branch
   * deletion).
   */
  function mockStaleWorktree(checkedOutBranch: string | undefined) {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          callback(null, { stdout: 'old0000deadbeef\n', stderr: '' } as unknown as string, '');
          return;
        }
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          if (checkedOutBranch === undefined) {
            const error = new Error('Command failed: git rev-parse') as Error & { stderr: string };
            error.stderr = 'fatal: ref HEAD is not a symbolic ref';
            callback(error, '', error.stderr);
          } else {
            callback(null, { stdout: `${checkedOutBranch}\n`, stderr: '' } as unknown as string, '');
          }
          return;
        }
        callback(null, { stdout: '', stderr: '' } as unknown as string, '');
      },
    );
  }

  it('inspects a stale worktree without removing it', async () => {
    mockStaleWorktree('pr-1-abc1234');

    await expect(inspectPrWorktree('/cache/worktrees/owner-repo-pr-1', 'new1234cafebabe')).resolves.toEqual({
      state: 'stale',
      info: { branch: 'pr-1-abc1234', dirty: false, commitsAhead: 0 },
    });
    // The caller decides whether to discard, so inspection must never delete.
    for (const call of mocks.execFile.mock.calls) {
      expect(call[1]).not.toContain('remove');
      expect(call[1]).not.toContain('branch');
    }
  });

  it('deletes the throwaway pr-<n>-<sha7> branch when the stale worktree is discarded', async () => {
    mockStaleWorktree('pr-1-abc1234');
    const inspection = await inspectPrWorktree('/cache/worktrees/owner-repo-pr-1', 'new1234cafebabe');
    expect(inspection.state).toBe('stale');

    await discardStalePrWorktree(
      '/repo',
      '/cache/worktrees/owner-repo-pr-1',
      inspection.state === 'stale' ? inspection.info.branch : undefined,
    );

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/cache/worktrees/owner-repo-pr-1'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'pr-1-abc1234'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    );
  });

  it('never deletes a non-throwaway branch checked out in a stale worktree', async () => {
    mockStaleWorktree('feature-user-work');
    const inspection = await inspectPrWorktree('/cache/worktrees/owner-repo-pr-1', 'new1234cafebabe');

    await discardStalePrWorktree(
      '/repo',
      '/cache/worktrees/owner-repo-pr-1',
      inspection.state === 'stale' ? inspection.info.branch : undefined,
    );

    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['branch']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('skips branch cleanup when the stale directory is detached', async () => {
    mockStaleWorktree(undefined);
    const inspection = await inspectPrWorktree('/cache/worktrees/owner-repo-pr-1', 'new1234cafebabe');
    expect(inspection.state === 'stale' ? inspection.info.branch : 'unset').toBeUndefined();

    await discardStalePrWorktree(
      '/repo',
      '/cache/worktrees/owner-repo-pr-1',
      inspection.state === 'stale' ? inspection.info.branch : undefined,
    );

    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['branch']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('does not delete the branch when the worktree removal itself fails', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          callback(null, { stdout: 'old0000deadbeef\n', stderr: '' } as unknown as string, '');
          return;
        }
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          callback(null, { stdout: 'pr-1-old0000\n', stderr: '' } as unknown as string, '');
          return;
        }
        const error = new Error('Command failed') as Error & { stderr: string };
        error.stderr = 'fatal: removal failed';
        callback(error, '', error.stderr);
      },
    );

    await expect(discardStalePrWorktree('/repo', '/cache/worktrees/owner-repo-pr-1', 'pr-1-old0000')).rejects.toThrow(
      'fatal: removal failed',
    );
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['branch']),
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe('listWorkspaceRepositories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [];
  });

  it('lists repo folders and one-level nested repositories', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: '/root' } },
      { uri: { fsPath: '/plain' } },
    ];
    const gitMarkers = new Set(['/root', path.join('/plain', 'sub')].map((repoPath) => path.join(repoPath, '.git')));
    (fs.promises.access as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (p: unknown) => {
      if (gitMarkers.has(String(p))) {
        return undefined;
      }
      throw new Error('ENOENT');
    });
    (fs.promises.readdir as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (p: unknown) => {
      const names = String(p) === '/plain' ? ['sub', 'not-a-repo'] : [];
      return names.map((name) => ({ name, isDirectory: () => true }));
    });

    const repos = await listWorkspaceRepositories();

    expect(repos).toEqual(['/root', path.join('/plain', 'sub')]);
  });

  it('returns an empty list when the workspace has no repositories', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/plain' } }];
    (fs.promises.access as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('ENOENT');
    });
    (fs.promises.readdir as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => []);

    await expect(listWorkspaceRepositories()).resolves.toEqual([]);
  });
});

describe('preferOwnNamespaceInstance', () => {
  const base = { url: 'https://forgejo.example.com', token: '', name: 'n' };
  const alice: ForgejoInstance = { ...base, id: 'a', username: 'alice' };
  const bob: ForgejoInstance = { ...base, id: 'b', username: 'bob' };

  it('prefers the account matching the remote owner, case-insensitively', () => {
    expect(preferOwnNamespaceInstance([alice, bob], 'Bob').id).toBe('b');
  });

  it('falls back to the first match when no username matches', () => {
    expect(preferOwnNamespaceInstance([alice, bob], 'carol').id).toBe('a');
  });
});

describe('listRemotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockRemoteV(lines: string[]) {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args[0] === 'remote' && args[1] === '-v') {
          const stdout = lines.length > 0 ? `${lines.join('\n')}\n` : '';
          callback(null, { stdout, stderr: '' } as unknown as string, '');
          return;
        }
        callback(null, '', '');
      },
    );
  }

  it('keeps a spaced remote URL reported on the fetch and push lines', async () => {
    // git prints remote URLs verbatim, so a local-path remote containing a
    // space (e.g. "D:\repos\my repo") must still be recognized; both the fetch
    // and the push line are the same pair and stay deduplicated.
    mockRemoteV([
      'upstream\thttps://forgejo.example.com/alice/repo.git (fetch)',
      'upstream\thttps://forgejo.example.com/alice/repo.git (push)',
      'origin\tD:\\repos\\my repo (fetch)',
      'origin\tD:\\repos\\my repo (push)',
    ]);

    await expect(listRemotes('/repo')).resolves.toEqual([
      { name: 'origin', url: 'D:\\repos\\my repo' },
      { name: 'upstream', url: 'https://forgejo.example.com/alice/repo.git' },
    ]);
  });

  it('parses a spaced URL on the fetch line and on the push line separately', async () => {
    mockRemoteV([
      'origin\t/home/me/My Repos/x.git (fetch)',
      'origin\thttps://forgejo.example.com/alice/repo.git (push)',
    ]);

    await expect(listRemotes('/repo')).resolves.toEqual([
      { name: 'origin', url: '/home/me/My Repos/x.git' },
      { name: 'origin', url: 'https://forgejo.example.com/alice/repo.git' },
    ]);
  });
});

describe('resolveRemoteForRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockRemoteV(remotes: Record<string, string>) {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args[0] === 'remote' && args[1] === '-v') {
          const stdout = Object.entries(remotes)
            .map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)`)
            .join('\n');
          callback(null, { stdout: stdout ? `${stdout}\n` : '', stderr: '' } as unknown as string, '');
          return;
        }
        callback(null, '', '');
      },
    );
  }

  it('returns origin when it points at the repo', async () => {
    mockRemoteV({
      origin: 'https://forgejo.example.com/alice/repo.git',
      upstream: 'https://forgejo.example.com/someone-else/other.git',
    });

    await expect(resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo')).resolves.toBe('origin');
  });

  it('returns a non-origin remote when only it matches', async () => {
    mockRemoteV({
      origin: 'https://forgejo.example.com/alice/fork.git',
      upstream: 'https://forgejo.example.com/alice/repo.git',
    });

    await expect(resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo')).resolves.toBe(
      'upstream',
    );
  });

  it('matches URLs with or without the .git suffix', async () => {
    mockRemoteV({ upstream: 'https://forgejo.example.com/alice/repo' });

    await expect(resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo')).resolves.toBe(
      'upstream',
    );
  });

  it('prefers origin when several remotes match', async () => {
    mockRemoteV({
      upstream: 'https://forgejo.example.com/alice/repo.git',
      origin: 'https://forgejo.example.com/alice/repo.git',
    });

    await expect(resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo')).resolves.toBe('origin');
  });

  it('returns undefined when no remote points at the repo', async () => {
    mockRemoteV({ origin: 'https://forgejo.example.com/alice/other.git' });

    await expect(
      resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo'),
    ).resolves.toBeUndefined();
  });
});

describe('getRefCommitSha', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a ref to its commit sha', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        expect(args).toEqual(['rev-parse', '--verify', 'pr-1-abcdef1^{commit}']);
        callback(null, { stdout: 'abcdef1234567890\n', stderr: '' } as unknown as string, '');
      },
    );

    await expect(getRefCommitSha('/repo', 'pr-1-abcdef1')).resolves.toBe('abcdef1234567890');
  });

  it('returns undefined for an unknown ref', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        const error = new Error('Command failed: git rev-parse') as Error & { stderr: string };
        error.stderr = 'fatal: Needed a single revision';
        callback(error, '', error.stderr);
      },
    );

    await expect(getRefCommitSha('/repo', 'no-such-ref')).resolves.toBeUndefined();
  });
});
