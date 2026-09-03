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
  fetchPullRequestHead,
  getRemoteUrl,
  pushBranch,
  remoteMatchesInstance,
  revertMergeCommit,
} from '../gitOperations';

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
        const error = new Error(
          `Command failed: git -c http.extraHeader=Authorization: token ${token} push`,
        ) as Error & {
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
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['-c', `http.extraHeader=Authorization: token ${token}`, 'push', '-u', 'origin', 'main'],
      expect.anything(),
      expect.any(Function),
    );
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
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'main'],
      expect.anything(),
      expect.any(Function),
    );
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
      ['-c', `http.extraHeader=Authorization: token ${token}`, 'push', 'origin', 'main'],
      expect.anything(),
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

  it('pushBranch adds -u when setUpstream is true and the auth header when a token is given', async () => {
    await pushBranch('/repo', 'origin', 'main', 'tok', true);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['-c', 'http.extraHeader=Authorization: token tok', 'push', '-u', 'origin', 'main'],
      expect.anything(),
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

  it('revertMergeCommit passes the merge sha as a single argv entry', async () => {
    const sha = 'abc123$(touch pwned)';
    await revertMergeCommit('/repo', sha);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['revert', '-m', '1', '--no-edit', sha],
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['push'], expect.anything(), expect.any(Function));
  });
});
