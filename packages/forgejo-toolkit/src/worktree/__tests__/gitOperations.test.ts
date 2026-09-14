import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: mocks.exec,
  execFile: mocks.execFile,
}));

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
    stat: vi.fn(),
    readFile: vi.fn(),
    rm: vi.fn(),
  },
}));

import {
  addRemote,
  cloneRepository,
  createWorktreeFromBranch,
  createWorktreeWithNewBranch,
  detectLinkedRepository,
  fetchBranch,
  fetchPullRequestHead,
  getRemoteUrl,
  openWorktree,
  preferOwnNamespaceInstance,
  pushBranch,
  remoteMatchesInstance,
  revertMergeCommit,
} from '../gitOperations';
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
      ['remote get-url origin', 'https://forgejo.example.com/owner/repo.git\n'],
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
      ['remote get-url origin', 'https://github.example.com/owner/repo.git\n'],
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

  function mockRemotes(remotesByCwd: Record<string, string>) {
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], options: { cwd?: string }, callback: ExecFileCallback) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          const url = options?.cwd ? remotesByCwd[options.cwd] : undefined;
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
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [];
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
  });

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
