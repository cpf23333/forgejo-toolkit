import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  findLocalRepo,
  getRemoteUrl,
  getRefCommitSha,
  inspectPrWorktree,
  isCurrentWorkspaceBaseRepo,
  isPathInsideFolder,
  isSafeRemoteName,
  listRemotes,
  listWorkspaceRepositories,
  openWorktree,
  parseRemoteUrl,
  preferOwnNamespaceInstance,
  pushBranch,
  redactRemoteUrl,
  remoteMatchesInstance,
  resolveRemoteForRepo,
  revertMergeCommit,
  sameRepositoryUrl,
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

/**
 * Answers `git rev-parse --verify <ref>^{commit}` with the given shas and leaves
 * every other command to succeed silently, which is what the worktree helpers
 * need to run their pre-flight checks. `revListCounts` answers the divergence
 * guard's `git rev-list --count <from>..<tip>`: the key is the range git
 * receives, and a range that is absent counts as zero (the leftover branch has
 * nothing the start point does not reach).
 */
function mockRevParseShas(shasByRef: Record<string, string>, revListCounts: Record<string, number> = {}) {
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = String(args[2] ?? '').replace(/\^\{commit\}$/, '');
      const sha = shasByRef[ref];
      callback(null, { stdout: sha ? `${sha}\n` : '', stderr: '' } as unknown as string, '');
      return;
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      callback(null, { stdout: 'c0ffee1\n', stderr: '' } as unknown as string, '');
      return;
    }
    if (args[0] === 'rev-list' && args[1] === '--count') {
      const count = revListCounts[String(args[2] ?? '')] ?? 0;
      callback(null, { stdout: `${count}\n`, stderr: '' } as unknown as string, '');
      return;
    }
    callback(null, '', '');
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

  it('matches scp-style remotes whose login is not "git"', () => {
    // git's scp syntax allows any login (`user@host:path`), and the login names
    // the transport user, not the repository: a remote stored as
    // forgejo@host:... or alice@host:... must host-match the instance like the
    // git@ spelling does. The shared normalizeGitRemote (not used here anymore)
    // only recognises `git@`, which left those repositories looking unlinked.
    expect(remoteMatchesInstance('alice@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com')).toBe(true);
    expect(remoteMatchesInstance('forgejo@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com')).toBe(
      true,
    );
    // The transport rule is unchanged: an scp remote ignores the instance's web
    // port, because SSH's port is not the web port.
    expect(remoteMatchesInstance('alice@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com:3000')).toBe(
      true,
    );
    // The instance may be deployed under a sub-path, and the scp path carries it
    // like any other transport does.
    expect(
      remoteMatchesInstance('alice@forgejo.example.com:forgejo/owner/repo.git', 'https://forgejo.example.com/forgejo'),
    ).toBe(true);
  });

  it('rejects scp-style remotes of another host or outside the instance sub-path', () => {
    expect(remoteMatchesInstance('alice@other.example.com:owner/repo.git', 'https://forgejo.example.com')).toBe(false);
    // A remote under a different path of the same host is not that instance.
    expect(
      remoteMatchesInstance(
        'alice@forgejo.example.com:elsewhere/owner/repo.git',
        'https://forgejo.example.com/forgejo',
      ),
    ).toBe(false);
    // A remote that names no repository (host plus a single path segment) is not
    // an instance repository, exactly as normalizeGitRemote required before.
    expect(remoteMatchesInstance('alice@forgejo.example.com:owner', 'https://forgejo.example.com')).toBe(false);
  });

  it('keeps the http(s) host-plus-port rule for http remotes next to scp ones', () => {
    expect(
      remoteMatchesInstance('https://forgejo.example.com/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(false);
    expect(
      remoteMatchesInstance('https://forgejo.example.com:3000/owner/repo.git', 'https://forgejo.example.com:3000'),
    ).toBe(true);
  });

  it('matches when the configured instance URL carries credentials or a sub-path', () => {
    // publish.ts matches a remote against each configured instance URL, which is
    // user input: parsed.host/parsed.pathname never contain the userinfo, so an
    // instance stored as https://user:token@host is still recognised, for scp
    // and http remotes alike.
    expect(
      remoteMatchesInstance('alice@forgejo.example.com:owner/repo.git', 'https://alice:token@forgejo.example.com'),
    ).toBe(true);
    expect(
      remoteMatchesInstance('https://forgejo.example.com/owner/repo.git', 'https://alice:token@forgejo.example.com'),
    ).toBe(true);
    // The .git suffix is not part of the host/path key, so both https spellings
    // of the same remote match equally.
    expect(remoteMatchesInstance('https://forgejo.example.com/owner/repo', 'https://forgejo.example.com')).toBe(true);
    // The instance's deployment sub-path is part of the key, so an scp remote
    // matches it too — and a remote outside it does not.
    expect(
      remoteMatchesInstance('alice@forgejo.example.com:sub/owner/repo.git', 'https://forgejo.example.com/sub'),
    ).toBe(true);
    expect(
      remoteMatchesInstance('alice@forgejo.example.com:other/owner/repo.git', 'https://forgejo.example.com/sub'),
    ).toBe(false);
  });
});

describe('parseRemoteUrl', () => {
  it('parses a login-less scp remote', () => {
    // git's scp syntax does not require a login: `host:owner/repo.git` is an
    // ordinary remote (git only requires the part before the colon to contain no
    // `/`). Dropping it left those repositories unlinked, so the worktree flows
    // reported no matching remote.
    expect(parseRemoteUrl('forgejo.example.com:owner/repo.git')).toEqual({
      normalized: 'forgejo.example.com/owner/repo',
      compareWithoutPort: true,
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('keeps parsing the scp forms that carry a login', () => {
    expect(parseRemoteUrl('git@forgejo.example.com:owner/repo.git')?.normalized).toBe('forgejo.example.com/owner/repo');
    expect(parseRemoteUrl('alice@forgejo.example.com:owner/repo.git')?.normalized).toBe(
      'forgejo.example.com/owner/repo',
    );
    // An absolute repository path (a leading slash after the colon) is not a
    // separator and stays accepted, as before.
    expect(parseRemoteUrl('git@forgejo.example.com:/owner/repo.git')?.normalized).toBe(
      'forgejo.example.com/owner/repo',
    );
  });

  it('still rejects local paths, including Windows drive paths', () => {
    // Accepting the bare `host:path` form must not turn a local path into a
    // remote: git reads a leading `<letter>:` as a DOS drive prefix
    // (has_dos_drive_prefix), so `D:\repos\x` and `D:/repos/x` are local, and a
    // path without a colon (or with a `/` before it) never matched anyway.
    expect(parseRemoteUrl('D:\\repos\\x')).toBeUndefined();
    expect(parseRemoteUrl('D:/repos/x')).toBeUndefined();
    expect(parseRemoteUrl('/home/me/repo')).toBeUndefined();
    expect(parseRemoteUrl('./repos/x')).toBeUndefined();
    expect(parseRemoteUrl('repos/x')).toBeUndefined();
  });

  it('rejects a host:path that names no repository', () => {
    expect(parseRemoteUrl('forgejo.example.com:owner')).toBeUndefined();
    expect(parseRemoteUrl('forgejo.example.com:')).toBeUndefined();
  });
});

describe('sameRepositoryUrl', () => {
  it('matches an ssh remote against an instance URL that carries a port', () => {
    // The SSH port is transport-level and unrelated to the web port, so an
    // instance on :3000 must still recognise its own ssh remote. Comparing
    // parseRemoteUrl(...).normalized on both sides kept the port on the instance
    // URL and dropped it on the remote, which rejected every ssh/scp remote.
    expect(
      sameRepositoryUrl(
        'ssh://git@forgejo.example.com:2222/owner/repo.git',
        'https://forgejo.example.com:3000/owner/repo.git',
      ),
    ).toBe(true);
    expect(
      sameRepositoryUrl('git@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com:3000/owner/repo.git'),
    ).toBe(true);
  });

  it('matches an https remote against an instance URL on the same port', () => {
    expect(
      sameRepositoryUrl(
        'https://forgejo.example.com:8443/owner/repo.git',
        'https://forgejo.example.com:8443/owner/repo.git',
      ),
    ).toBe(true);
    // The port is only irrelevant when one side is a portless transport; two
    // http(s) URLs without an explicit port still match.
    expect(
      sameRepositoryUrl('https://forgejo.example.com/owner/repo.git', 'https://forgejo.example.com/owner/repo'),
    ).toBe(true);
  });

  it('rejects an https remote on a different port', () => {
    // The web port identifies the server, so it must match exactly when both
    // sides are http(s) — including an explicit port against the default one.
    expect(
      sameRepositoryUrl(
        'https://forgejo.example.com:8443/owner/repo.git',
        'https://forgejo.example.com:3000/owner/repo.git',
      ),
    ).toBe(false);
    expect(
      sameRepositoryUrl(
        'https://forgejo.example.com/owner/repo.git',
        'https://forgejo.example.com:3000/owner/repo.git',
      ),
    ).toBe(false);
  });

  it('matches a login-less scp remote against an instance URL without a port', () => {
    expect(sameRepositoryUrl('forgejo.example.com:owner/repo.git', 'https://forgejo.example.com/owner/repo.git')).toBe(
      true,
    );
  });

  it('matches a git+ssh remote against the instance https URL', () => {
    // `git+ssh://` is git's explicit-SSH alias and carries SSH's port, which is
    // as unrelated to the instance's web port as an `ssh://` remote's is. Kept
    // as a portless transport, the :2222 remote matches an instance on :3000.
    expect(
      sameRepositoryUrl(
        'git+ssh://git@forgejo.example.com:2222/owner/repo.git',
        'https://forgejo.example.com/owner/repo.git',
      ),
    ).toBe(true);
    expect(
      sameRepositoryUrl(
        'git+ssh://git@forgejo.example.com:2222/owner/repo.git',
        'https://forgejo.example.com:3000/owner/repo.git',
      ),
    ).toBe(true);
    // The host and repository still have to match.
    expect(
      sameRepositoryUrl(
        'git+ssh://git@other.example.com:2222/owner/repo.git',
        'https://forgejo.example.com/owner/repo.git',
      ),
    ).toBe(false);
    expect(
      sameRepositoryUrl(
        'git+ssh://git@forgejo.example.com:2222/owner/other.git',
        'https://forgejo.example.com/owner/repo.git',
      ),
    ).toBe(false);
  });

  it('keeps the instance sub-path in the comparison', () => {
    expect(
      sameRepositoryUrl(
        'git@forgejo.example.com:forgejo/owner/repo.git',
        'https://forgejo.example.com/forgejo/owner/repo.git',
      ),
    ).toBe(true);
    expect(
      sameRepositoryUrl('git@forgejo.example.com:owner/repo.git', 'https://forgejo.example.com/forgejo/owner/repo.git'),
    ).toBe(false);
  });

  it('ignores credentials on the remote and on the instance URL', () => {
    expect(
      sameRepositoryUrl(
        'https://alice:token_abc123@forgejo.example.com/owner/repo.git',
        'https://forgejo.example.com/owner/repo.git',
      ),
    ).toBe(true);
    expect(
      sameRepositoryUrl(
        'ssh://git@forgejo.example.com:2222/owner/repo.git',
        'https://alice:token_abc123@forgejo.example.com:3000/owner/repo.git',
      ),
    ).toBe(true);
  });

  it('rejects a different host or repository and unparseable URLs', () => {
    expect(
      sameRepositoryUrl('git@other.example.com:owner/repo.git', 'https://forgejo.example.com/owner/repo.git'),
    ).toBe(false);
    expect(
      sameRepositoryUrl('git@forgejo.example.com:owner/other.git', 'https://forgejo.example.com/owner/repo.git'),
    ).toBe(false);
    expect(sameRepositoryUrl('not a url', 'https://forgejo.example.com/owner/repo.git')).toBe(false);
    expect(sameRepositoryUrl('D:\\repos\\x', 'https://forgejo.example.com/owner/repo.git')).toBe(false);
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
    const branch = 'feature/$(id)';
    await pushBranch('/repo', 'origin', branch);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', branch],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('pushBranch refuses a remote name git would read as an option', async () => {
    // The remote name may come from the upstream (`@{upstream}`) or from a user
    // prompt, so it is not necessarily one this module chose; `git push --force
    // …` would run something else than the caller asked for. The fetch helpers
    // guard their remote the same way.
    await expect(pushBranch('/repo', '--force', 'main')).rejects.toThrow(/is not a usable git remote name/);
    await expect(pushBranch('/repo', '-u', 'main')).rejects.toThrow(/is not a usable git remote name/);
    expect(mocks.execFile).not.toHaveBeenCalled();
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
    // Shell-hostile but a valid ref (no space): proves there is no shell interpolation.
    const localBranch = 'pr-1;id';
    await fetchPullRequestHead('/repo', 'origin', 1, localBranch);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', '--', `refs/pull/1/head:${localBranch}`],
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
    const branch = 'pr-1$(id)';
    const worktreePath = '/cache/worktrees/evil" && pwned';
    await createWorktreeFromBranch('/repo', worktreePath, branch);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-B', branch, '--', worktreePath, branch],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('fetchBranch passes the branch as a single argv entry and the token via env config', async () => {
    const branch = 'main$(id)';
    await fetchBranch('/repo', 'origin', branch, 'tok');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', '--', branch],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_VALUE_0: 'Authorization: token tok',
        }),
      }),
      expect.any(Function),
    );
  });

  it('createWorktreeWithNewBranch passes branch, path and start point as single argv entries', async () => {
    const branch = 'issue-1-fix$(id)';
    const worktreePath = '/cache/worktrees/evil" && pwned';
    await createWorktreeWithNewBranch('/repo', worktreePath, branch, 'FETCH_HEAD');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-B', branch, '--', worktreePath, 'FETCH_HEAD'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('refuses to reset a leftover issue branch that has commits of its own', async () => {
    // Removing a worktree keeps its branch on purpose, so `-B` would reset it to
    // the freshly fetched tip and silently drop those commits. The leftover
    // branch carries a commit the new start point does not reach, so the
    // divergence count is positive.
    mockRevParseShas({ 'refs/heads/issue-1': 'aaaaaaa1', FETCH_HEAD: 'bbbbbbb2' }, { 'bbbbbbb2..aaaaaaa1': 1 });

    await expect(createWorktreeWithNewBranch('/repo', '/cache/worktrees/x', 'issue-1', 'FETCH_HEAD')).rejects.toThrow(
      /commits of its own/,
    );
    // The guard asks git whether startPoint reaches the leftover branch.
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['rev-list', '--count', 'bbbbbbb2..aaaaaaa1'],
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'add']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('still resets a leftover branch that points at the same commit', async () => {
    // The retry path: a previous start-work attempt left the branch at the tip
    // the fetch just produced, so re-creating the worktree is not destructive.
    mockRevParseShas({ 'refs/heads/issue-1': 'aaaaaaa1', FETCH_HEAD: 'aaaaaaa1' });

    await createWorktreeWithNewBranch('/repo', '/cache/worktrees/x', 'issue-1', 'FETCH_HEAD');

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-B', 'issue-1', '--', '/cache/worktrees/x', 'FETCH_HEAD'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('still resets a leftover branch that is merely behind the start point', async () => {
    // The branch a previous attempt created from an older fetch is an ancestor
    // of the freshly fetched tip, so resetting it forward discards no commit
    // (git reports zero commits startPoint does not already reach). This is the
    // benign retry the previous same-sha-only guard wrongly refused.
    mockRevParseShas({ 'refs/heads/issue-1': 'aaaaaaa1', FETCH_HEAD: 'bbbbbbb2' }, { 'bbbbbbb2..aaaaaaa1': 0 });

    await createWorktreeWithNewBranch('/repo', '/cache/worktrees/x', 'issue-1', 'FETCH_HEAD');

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-B', 'issue-1', '--', '/cache/worktrees/x', 'FETCH_HEAD'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('refuses when the divergence of the leftover branch cannot be determined', async () => {
    // `git rev-list` failing must not be read as "nothing to lose": the guard
    // fails closed and lets the user delete the branch deliberately.
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          const ref = String(args[2] ?? '').replace(/\^\{commit\}$/, '');
          const sha = { 'refs/heads/issue-1': 'aaaaaaa1', FETCH_HEAD: 'bbbbbbb2' }[ref] ?? '';
          callback(null, { stdout: sha ? `${sha}\n` : '', stderr: '' } as unknown as string, '');
          return;
        }
        if (args[0] === 'rev-list') {
          const error = new Error('Command failed: git rev-list') as Error & { stderr: string };
          error.stderr = 'fatal: bad revision';
          callback(error, '', error.stderr);
          return;
        }
        callback(null, '', '');
      },
    );

    await expect(createWorktreeWithNewBranch('/repo', '/cache/worktrees/x', 'issue-1', 'FETCH_HEAD')).rejects.toThrow(
      /commits of its own/,
    );
  });

  it('refuses to reset a leftover branch whose start point does not resolve', async () => {
    // The branch exists but the start point (an empty cache's missing
    // FETCH_HEAD, or any other unresolvable value) does not: the divergence is
    // unknown, so the branch might carry commits `-B` would drop. The guard
    // must fail closed instead of skipping the check because one rev-parse came
    // back empty.
    mockRevParseShas({ 'refs/heads/issue-1': 'aaaaaaa1' });

    await expect(createWorktreeWithNewBranch('/repo', '/cache/worktrees/x', 'issue-1', 'FETCH_HEAD')).rejects.toThrow(
      /cannot be resolved/,
    );
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'add']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('creates the branch when there is no leftover branch to reset', async () => {
    // The empty bare cache: nothing points at the new branch name, so `-B`
    // creates it from the start point and the divergence guard has nothing to
    // protect.
    mockRevParseShas({ FETCH_HEAD: 'bbbbbbb2' });

    await createWorktreeWithNewBranch('/repo', '/cache/worktrees/x', 'issue-1', 'FETCH_HEAD');

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-B', 'issue-1', '--', '/cache/worktrees/x', 'FETCH_HEAD'],
      expect.anything(),
      expect.any(Function),
    );
  });

  // The API supplies these values (repository default_branch, pull request head,
  // merge commit), so a leading `-` must be rejected rather than handed to git as
  // an option (`--depth=1`, `--prune`, `--upload-pack=…`).
  it('rejects a revision that git would read as an option', async () => {
    await expect(fetchBranch('/repo', 'origin', '--depth=1')).rejects.toThrow(/is not a valid git revision/);
    await expect(createWorktreeFromBranch('/repo', '/cache/worktrees/x', '-B')).rejects.toThrow(
      /is not a valid git revision/,
    );
    await expect(getRefCommitSha('/repo', '--no-verify')).rejects.toThrow(/is not a valid git revision/);
  });

  it('rejects a revision containing whitespace, which no ref may contain', async () => {
    await expect(fetchBranch('/repo', 'origin', 'main extra')).rejects.toThrow(/is not a valid git revision/);
  });

  it('rejects a merge commit that is not a SHA', async () => {
    await expect(revertMergeCommit('/repo', 'HEAD~1')).rejects.toThrow(/is not a commit SHA/);
    await expect(revertMergeCommit('/repo', '--no-verify')).rejects.toThrow(/is not a commit SHA/);
  });

  it('revertMergeCommit passes the merge sha as a single argv entry', async () => {
    const sha = 'abc1234';
    // Only the pre-revert commit has to answer; everything else succeeds empty,
    // so the revert is created and the plain origin push goes through.
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        const stdout = args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'c0ffee1\n' : '';
        callback(null, { stdout, stderr: '' } as unknown as string, '');
      },
    );
    await expect(revertMergeCommit('/repo', sha)).resolves.toEqual({ status: 'pushed' });
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['revert', '-m', '1', '--no-edit', '--', sha],
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

  it('revertMergeCommit refuses to start when the pre-revert commit cannot be read', async () => {
    // Without the pre-revert commit a failed revert could not be undone, so the
    // flow must not touch the repository at all.
    await expect(revertMergeCommit('/repo', 'abc1234')).rejects.toThrow(/could not determine the current commit/);
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['revert']),
      expect.anything(),
      expect.any(Function),
    );
  });
});

function mockGitSequence(handlers: Array<[string, string]>, failures: Array<[string, string]> = []) {
  // Every revert flow starts by recording the pre-revert commit and, on
  // failure, restores it, so both commands answer by default; tests that care
  // about them pass their own handler, and the first matching prefix wins.
  const withDefaults: Array<[string, string]> = [['rev-parse HEAD', 'c0ffee1\n'], ['reset --hard', ''], ...handlers];
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    const cmd = args.join(' ');
    for (const [prefix, stderr] of failures) {
      if (cmd.startsWith(prefix)) {
        // promisify(cp.execFile) rejects with the first callback value, and
        // runGit re-throws git's stderr from it.
        callback(Object.assign(new Error(`Command failed: git ${cmd}`), { stderr }), '', stderr);
        return;
      }
    }
    for (const [prefix, stdout] of withDefaults) {
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
      ['revert', '-m', '1', '--no-edit', '--', 'abc123'],
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

  it('reports a pushed revert only when the push actually went through', async () => {
    mockGitSequence([
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
      ['remote get-url --push --all origin', 'https://forgejo.example.com/owner/repo.git\n'],
    ]);

    await expect(revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl)).resolves.toEqual({
      status: 'pushed',
    });
    // A pushed revert needs no cleanup: neither the pre-revert commit is
    // restored nor is the repository touched again.
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['reset']),
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['revert', '--abort']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('undoes a conflicted revert with git revert --abort instead of a hard reset', async () => {
    mockGitSequence(
      [
        ['rev-parse --abbrev-ref HEAD', 'main\n'],
        ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
        ['remote get-url --push --all origin', 'https://forgejo.example.com/owner/repo.git\n'],
        // The sequencer left REVERT_HEAD behind: the revert is mid-flight.
        ['rev-parse --absolute-git-dir', '/repo/.git\n'],
      ],
      [['revert -m 1', 'error: could not revert abc123... hint: after resolving the conflicts']],
    );

    const failure = await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl).catch(
      (error: unknown) => error,
    );

    // The message says the local revert was undone and where the repository is.
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('could not revert');
    expect(message).toContain('undone');
    expect(message).toContain('c0ffee1');
    // `git revert --abort` reconstructs the pre-revert state and keeps local
    // modifications it does not need to overwrite, where `git reset --hard`
    // would discard the user's own edits together with the conflict.
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['revert', '--abort'], expect.anything(), expect.any(Function));
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['reset']),
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['push']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('keeps an unrelated tracked change when a conflicted revert is undone', async () => {
    // The user's own edit was in the tree before the revert and `git revert`
    // never touched it; no undo step may throw it away.
    mockGitSequence(
      [
        ['status --porcelain', ' M src/unrelated.ts\n'],
        ['rev-parse --abbrev-ref HEAD', 'main\n'],
        ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
        ['remote get-url --push --all origin', 'https://forgejo.example.com/owner/repo.git\n'],
        ['rev-parse --absolute-git-dir', '/repo/.git\n'],
      ],
      [['revert -m 1', 'error: could not revert abc123... hint: after resolving the conflicts']],
    );

    const failure = await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl).catch(
      (error: unknown) => error,
    );

    expect((failure as Error).message).toContain('undone');
    // Neither a hard reset nor a checkout may run: both restore tracked content,
    // which would drop the unrelated edit along with the conflict.
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['reset']),
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      ['checkout', '--', '.'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('tells the user the revert is still in progress when it cannot be aborted', async () => {
    mockGitSequence(
      [
        ['rev-parse --abbrev-ref HEAD', 'main\n'],
        ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
        ['remote get-url --push --all origin', 'https://forgejo.example.com/owner/repo.git\n'],
        ['rev-parse --absolute-git-dir', '/repo/.git\n'],
      ],
      [
        ['revert -m 1', 'error: could not revert abc123'],
        ['revert --abort', 'error: could not abort'],
      ],
    );

    const failure = await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl).catch(
      (error: unknown) => error,
    );

    const message = (failure as Error).message;
    // The repository is still mid-revert, so the message has to say how to undo
    // it; the view's mid-revert notice keys off this same wording.
    expect(message).toContain('git revert --abort');
    expect(message).not.toContain('was undone');
  });

  it('leaves the tree alone when the failed revert never applied anything', async () => {
    // Without sequencer state `git revert` changed nothing (it refused to start,
    // for instance over the user's local changes), so there is nothing to undo —
    // and a hard reset would only discard those changes.
    mockGitSequence(
      [
        ['status --porcelain', ' M src/unrelated.ts\n'],
        ['rev-parse --abbrev-ref HEAD', 'main\n'],
        ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
        ['remote get-url --push --all origin', 'https://forgejo.example.com/owner/repo.git\n'],
      ],
      [['revert -m 1', 'error: your local changes to the following files would be overwritten']],
    );

    const failure = await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl).catch(
      (error: unknown) => error,
    );

    const message = (failure as Error).message;
    // Nothing was undone and nothing was thrown away; the user is pointed at the
    // working tree instead of having it reset under them.
    expect(message).toContain('git status');
    expect(message).not.toContain('was undone');
    expect(message).not.toContain('git revert --abort');
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['reset']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('keeps an unrelated tracked change when the push of a revert fails', async () => {
    // The revert commit exists and the push failed, but the tree also held the
    // user's own edit: dropping the commit with a hard reset would take that edit
    // with it, so the host must leave the commit in place and name it instead.
    mockGitSequence(
      [
        ['status --porcelain', ' M src/unrelated.ts\n'],
        ['rev-parse --abbrev-ref HEAD', 'main\n'],
        ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
        ['remote get-url --push --all origin', 'https://forgejo.example.com/owner/repo.git\n'],
      ],
      [['push origin HEAD:main', 'error: failed to push some refs (non-fast-forward)']],
    );

    const failure = await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl).catch(
      (error: unknown) => error,
    );

    const message = (failure as Error).message;
    expect(message).toContain('non-fast-forward');
    expect(message).not.toContain('was undone');
    // The commit to drop and the command to drop it with are named, so the user
    // can finish the undo once their own edit is safe.
    expect(message).toContain('git reset --hard');
    expect(message).toContain('c0ffee1');
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['reset']),
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      ['checkout', '--', '.'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('removes the local revert commit when the push fails', async () => {
    // The cleanup reset must actually succeed for the "undone" message, so this
    // test needs the mocked `git reset` to answer like a real one.
    mockGitSequence(
      [
        ['rev-parse --abbrev-ref HEAD', 'main\n'],
        ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
        ['remote get-url --push --all origin', 'https://forgejo.example.com/owner/repo.git\n'],
      ],
      [['push origin HEAD:main', 'error: failed to push some refs (non-fast-forward)']],
    );

    const failure = await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('was undone');
    expect(message).toContain('non-fast-forward');
    // The bogus local commit is gone: the repository is back where it started,
    // so a failed push leaves nothing behind that looks like a revert.
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['reset', '--hard', 'c0ffee1'],
      expect.anything(),
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

  it('aborts when the push target is another repository on the same instance', async () => {
    mockGitSequence([
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
      // The fetch URL is the pull request's repository, but git would push to a
      // mirror of another repository on the same instance: only the push
      // targets may be trusted here.
      ['remote get-url origin', 'https://forgejo.example.com/owner/repo.git\n'],
      ['remote get-url --push --all origin', 'https://forgejo.example.com/other-owner/other-repo.git\n'],
    ]);

    await expect(
      revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl, { owner: 'owner', repo: 'repo' }),
    ).rejects.toThrow('does not point at');
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['push']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('aborts when only one of several push targets is the pull request repository', async () => {
    mockGitSequence([
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
      [
        'remote get-url --push --all origin',
        'https://forgejo.example.com/owner/repo.git\nhttps://forgejo.example.com/owner/other-repo.git\n',
      ],
    ]);

    await expect(
      revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl, { owner: 'owner', repo: 'repo' }),
    ).rejects.toThrow('does not point at');
  });

  it('aborts when the push target cannot be resolved', async () => {
    mockGitSequence([
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
    ]);

    await expect(
      revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl, { owner: 'owner', repo: 'repo' }),
    ).rejects.toThrow('does not point at');
  });

  it('pushes when every push target is the pull request repository', async () => {
    mockGitSequence([
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
      // Owner/repo names are case-insensitive, and ssh targets are supported.
      [
        'remote get-url --push --all origin',
        'https://forgejo.example.com/Owner/Repo.git\nssh://git@forgejo.example.com:2222/owner/repo.git\n',
      ],
    ]);

    await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl, { owner: 'owner', repo: 'repo' });

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'HEAD:main'],
      expect.objectContaining({
        env: expect.objectContaining({ GIT_CONFIG_VALUE_0: `Authorization: token ${token}` }),
      }),
      expect.any(Function),
    );
  });

  it('accepts an scp push target whose login is not "git"', async () => {
    // Both guards in this flow must read the owner/repo out of the scp form
    // (isExpectedRepo here, remoteMatchesInstance inside pushBranch): git's scp
    // syntax allows any login, and normalizeGitRemote parsed only `git@`.
    mockGitSequence([
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
      ['remote get-url --push --all origin', 'alice@forgejo.example.com:owner/repo.git\n'],
    ]);

    await revertMergeCommit('/repo', 'abc123', 'main', token, instanceUrl, { owner: 'owner', repo: 'repo' });

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'HEAD:main'],
      expect.objectContaining({
        env: expect.objectContaining({ GIT_CONFIG_VALUE_0: `Authorization: token ${token}` }),
      }),
      expect.any(Function),
    );
  });
});

describe('openWorktree', () => {
  let restoreUriFrom: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // The shared `vscode` mock's `Uri.from` drops `authority` — exactly the
    // component the remote case is about — so install a faithful one here and
    // restore the shared implementation afterwards.
    const shared = vi.mocked(vscode.Uri.from).getMockImplementation();
    restoreUriFrom = () => {
      if (shared) {
        vi.mocked(vscode.Uri.from).mockImplementation(shared as never);
      }
    };
    vi.mocked(vscode.Uri.from).mockImplementation(
      (components: { scheme: string; authority?: string; path?: string; query?: string }) =>
        ({ ...components, fsPath: components.path }) as never,
    );
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [];
  });

  afterEach(() => {
    restoreUriFrom?.();
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

  it('opens a local worktree through a file: URI', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: '/ws/project', scheme: 'file' } },
    ];

    await expect(openWorktree('/wt', true)).resolves.toBe(true);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder',
      expect.objectContaining({ scheme: 'file', fsPath: '/wt' }),
      true,
    );
  });

  it('opens a remote worktree on the workspace folder’s remote host', async () => {
    // Under Remote-SSH/WSL/dev containers the worktree path exists only on the
    // extension host. A `file:` URI is resolved by the client process, where the
    // path does not exist, so no window opens even though the command succeeds.
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: '/home/u/project', scheme: 'vscode-remote', authority: 'ssh-remote+host' } },
    ];

    await expect(openWorktree('/home/u/.cache/wt', true)).resolves.toBe(true);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder',
      expect.objectContaining({
        scheme: 'vscode-remote',
        authority: 'ssh-remote+host',
        path: '/home/u/.cache/wt',
      }),
      true,
    );
  });

  it('addresses a Windows path on a remote host in URI form', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: 'C:\\Users\\u\\project', scheme: 'vscode-remote', authority: 'wsl+Ubuntu' } },
    ];

    await expect(openWorktree('C:\\Users\\u\\wt', true)).resolves.toBe(true);

    // A URI path uses forward slashes and keeps the drive letter addressable.
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder',
      expect.objectContaining({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/c:/Users/u/wt' }),
      true,
    );
  });

  it('falls back to a file: URI when no folder is open', async () => {
    await expect(openWorktree('/wt', true)).resolves.toBe(true);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder',
      expect.objectContaining({ scheme: 'file', fsPath: '/wt' }),
      true,
    );
  });

  it('reports failure when opening the folder throws', async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('no such folder'));

    await expect(openWorktree('/wt', true)).resolves.toBe(false);
  });

  it('treats a case-different path as the same folder on macOS', async () => {
    // APFS is case-insensitive, so `/Users/u/Worktree` and `/users/u/worktree`
    // are one directory; without this the user gets the destructive
    // "replace the current workspace" modal for the folder that is already open.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
        { uri: { fsPath: '/Users/u/Worktree', scheme: 'file' } },
      ];

      await expect(openWorktree('/users/u/worktree', false)).resolves.toBe(true);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    } finally {
      if (descriptor) {
        Object.defineProperty(process, 'platform', descriptor);
      }
    }
  });
});

describe('isPathInsideFolder', () => {
  it('accepts a child of a directory whose name starts with two dots', () => {
    // `..cache` is an ordinary directory name; only `..` and `../…` escape.
    expect(isPathInsideFolder(path.join('/cache'), path.join('/cache', '..cache', 'x'))).toBe(true);
  });

  it('rejects the parent directory and paths under it', () => {
    expect(isPathInsideFolder('/cache', '/cache/..')).toBe(false);
    expect(isPathInsideFolder(path.join('/cache'), path.join('/cache', '..', 'x'))).toBe(false);
  });

  it('rejects the folder itself', () => {
    expect(isPathInsideFolder('/cache', '/cache')).toBe(false);
  });
});

describe('runGit', () => {
  afterEach(() => {
    // The shared vscode mock returns a fresh configuration object for every
    // call; restore that shape so later tests do not inherit this git.path.
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => ({ get: vi.fn(), update: vi.fn() }) as never);
  });

  it('runs the binary named by git.path, re-reading the setting on every call', async () => {
    let configuredPath: string | undefined = '/opt/git/bin/git';
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
      () => ({ get: (key: string) => (key === 'path' ? configuredPath : undefined), update: vi.fn() }) as never,
    );
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, '', '');
      },
    );

    await pushBranch('/repo', 'origin', 'main');
    // A changed setting is picked up by the next call: the value must not be
    // cached from the first spawn.
    configuredPath = '/opt/other/git';
    await pushBranch('/repo', 'origin', 'main');

    expect(mocks.execFile.mock.calls.map((call) => call[0])).toEqual(['/opt/git/bin/git', '/opt/other/git']);
  });

  it('names the git binary when spawning it fails (ENOENT)', async () => {
    // A user with no git on the extension host's PATH (a remote or dev
    // container without git, or a wrong git.path) otherwise sees only
    // "Git operation failed".
    mocks.execFile.mockImplementation(
      (file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', '');
      },
    );

    const failure = await pushBranch('/repo', 'origin', 'main').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('git');
    expect((failure as Error).message).toContain('not found');
    expect((failure as Error).message).not.toBe('Git operation failed');
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

  it('links a repository whose remote uses an scp login other than "git"', async () => {
    // git's scp syntax allows any login, not just `git`. The shared
    // normalizeGitRemote parses only `git@` (new URL() rejects
    // alice@host:owner/repo.git), so such a remote used to be dropped before
    // matching: the repository looked unlinked and was offered as a publish
    // candidate again.
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/a' } }];
    mockRemotes({ '/ws/a': 'alice@forgejo.example.com:alice/repo.git' });

    const result = await detectLinkedRepositories([instanceAlice]);

    expect(result.linked?.localPath).toBe('/ws/a');
    expect(result.linked?.instanceId).toBe('host-alice');
    expect(result.linked?.owner).toBe('alice');
    expect(result.linked?.repo).toBe('repo');
    expect(result.unpublished).toEqual([]);
    // The host matched in the cheap pass, so no repo-path fallback probe ran.
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
        if (args[0] === 'rev-list') {
          // The expected sha is present in this clone, so the count is a known
          // zero rather than "could not be determined".
          callback(null, { stdout: '0\n', stderr: '' } as unknown as string, '');
          return;
        }
        callback(null, { stdout: '', stderr: '' } as unknown as string, '');
      },
    );
  }

  it('inspects a stale worktree without removing it', async () => {
    mockStaleWorktree('pr-1-abc1234');

    await expect(inspectPrWorktree('/cache/worktrees/owner-repo-pr-1', 'abc1234cafebabe')).resolves.toEqual({
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
    const inspection = await inspectPrWorktree('/cache/worktrees/owner-repo-pr-1', 'abc1234cafebabe');
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
    const inspection = await inspectPrWorktree('/cache/worktrees/owner-repo-pr-1', 'abc1234cafebabe');

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
    const inspection = await inspectPrWorktree('/cache/worktrees/owner-repo-pr-1', 'abc1234cafebabe');
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

  it('ignores a remote whose name would be read as a git option', async () => {
    // `git remote add --force …` is legal, and `git fetch --force …` would then
    // fetch from the default remote while the caller still passes the instance
    // token; such a name is never handed to git.
    mockRemoteV([
      '--force\thttps://forgejo.example.com/alice/repo.git (fetch)',
      'origin\thttps://forgejo.example.com/alice/repo.git (fetch)',
    ]);

    await expect(listRemotes('/repo')).resolves.toEqual([
      { name: 'origin', url: 'https://forgejo.example.com/alice/repo.git' },
    ]);
  });
});

describe('isSafeRemoteName', () => {
  it('accepts ordinary remote names and refuses option-like ones', () => {
    expect(isSafeRemoteName('origin')).toBe(true);
    expect(isSafeRemoteName('upstream-2')).toBe(true);
    expect(isSafeRemoteName('my/fork')).toBe(true);
    expect(isSafeRemoteName('--force')).toBe(false);
    expect(isSafeRemoteName('-u')).toBe(false);
    expect(isSafeRemoteName('')).toBe(false);
    expect(isSafeRemoteName('remote with space')).toBe(false);
  });

  it('accepts a name with a leading underscore, which the publish prompt offers', () => {
    // `_forgejo` (and any other name in git's character set) can be created by
    // the publish prompt's validateRemoteName, so detection must not skip it.
    expect(isSafeRemoteName('_forgejo')).toBe(true);
    expect(isSafeRemoteName('_')).toBe(true);
    expect(isSafeRemoteName('_upstream/fork-2')).toBe(true);
  });

  it('still refuses every name git would read as an option', () => {
    expect(isSafeRemoteName('-')).toBe(false);
    expect(isSafeRemoteName('-_forgejo')).toBe(false);
    expect(isSafeRemoteName('--upload-pack=evil')).toBe(false);
  });

  it('accepts the rest of the characters git allows in a remote name', () => {
    // A remote name becomes a component of `refs/remotes/<name>/…`, and
    // `git check-ref-format refs/remotes/my+fork/main` succeeds: `+`, `@` and a
    // leading `_` are all legal there. Rejecting them would hide a remote the
    // user created from git itself (and the publish prompt can create).
    expect(isSafeRemoteName('my+fork')).toBe(true);
    expect(isSafeRemoteName('fork@2024')).toBe(true);
    expect(isSafeRemoteName('_forgejo+fork')).toBe(true);
    expect(isSafeRemoteName('a/b+c_d.e-f')).toBe(true);
  });

  it('refuses names that cannot be a ref component', () => {
    expect(isSafeRemoteName('a..b')).toBe(false);
    expect(isSafeRemoteName('..')).toBe(false);
    expect(isSafeRemoteName('my fork')).toBe(false);
    expect(isSafeRemoteName('my\tfork')).toBe(false);
    expect(isSafeRemoteName('my\nfork')).toBe(false);
    expect(isSafeRemoteName('my\u0000fork')).toBe(false);
  });
});

describe('redactRemoteUrl', () => {
  it('blanks the password and keeps the http username recognisable', () => {
    expect(redactRemoteUrl('https://alice:s3cret@forgejo.example.com/alice/repo.git')).toBe(
      'https://alice:***@forgejo.example.com/alice/repo.git',
    );
  });

  it('blanks a username that is the only userinfo of an http(s) url', () => {
    // Forgejo users commonly write the token in the username position
    // (`https://<token>@host/...`), so that username is a credential too.
    expect(redactRemoteUrl('https://ghp_example@forgejo.example.com/alice/repo.git')).toBe(
      'https://***@forgejo.example.com/alice/repo.git',
    );
    expect(redactRemoteUrl('https://token@forgejo.example.com/x.git')).toBe('https://***@forgejo.example.com/x.git');
  });

  it('keeps a plain ssh user visible instead of blanking the userinfo', () => {
    expect(redactRemoteUrl('ssh://git@forgejo.example.com/owner/repo.git')).toBe(
      'ssh://git@forgejo.example.com/owner/repo.git',
    );
  });

  it('still blanks a password on an ssh url', () => {
    expect(redactRemoteUrl('ssh://git:pw@forgejo.example.com/owner/repo.git')).toBe(
      'ssh://git:***@forgejo.example.com/owner/repo.git',
    );
  });

  it('leaves credential-free and scp-style remotes untouched', () => {
    expect(redactRemoteUrl('https://forgejo.example.com/alice/repo.git')).toBe(
      'https://forgejo.example.com/alice/repo.git',
    );
    expect(redactRemoteUrl('git@forgejo.example.com:alice/repo.git')).toBe('git@forgejo.example.com:alice/repo.git');
    expect(redactRemoteUrl('D:\\repos\\my repo')).toBe('D:\\repos\\my repo');
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

  it('matches a remote URL that carries credentials', async () => {
    // A remote written as https://user:token@host/... is the same repository on
    // the same instance as its credential-free form; comparing the raw userinfo
    // would make detection and pushing silently skip that user's repository.
    mockRemoteV({ origin: 'https://alice:token_abc123@forgejo.example.com/alice/repo.git' });

    await expect(resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo')).resolves.toBe('origin');
  });

  it('matches when the configured instance URL carries credentials too', async () => {
    // Both sides of the comparison can hold userinfo (the instance URL is user
    // input, the remote is whatever the repository stores); the credential is
    // not part of the repository identity on either side, so both are stripped.
    mockRemoteV({ origin: 'https://forgejo.example.com/alice/repo.git' });

    await expect(
      resolveRemoteForRepo('/repo', 'https://alice:token_abc123@forgejo.example.com', 'alice', 'repo'),
    ).resolves.toBe('origin');
  });

  it('matches an scp-style remote against the instance web URL', async () => {
    // git@host:owner/repo.git names the same repository as
    // https://host/owner/repo.git; a raw or normalizeGitUrl comparison keeps
    // the scheme and the login and would never equate them.
    mockRemoteV({ origin: 'git@forgejo.example.com:alice/repo.git' });

    await expect(resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo')).resolves.toBe('origin');
  });

  it('matches an ssh:// remote and ignores its transport port', async () => {
    mockRemoteV({ origin: 'ssh://git@forgejo.example.com:2222/alice/repo.git' });

    await expect(resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo')).resolves.toBe('origin');
    // SSH on 2222 has no relation to the instance's web port 3000.
    await expect(resolveRemoteForRepo('/repo', 'https://forgejo.example.com:3000', 'alice', 'repo')).resolves.toBe(
      'origin',
    );
  });

  it('does not match an ssh remote of another host or another repository', async () => {
    mockRemoteV({ origin: 'git@git.example.com:alice/repo.git' });
    await expect(
      resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo'),
    ).resolves.toBeUndefined();

    mockRemoteV({ origin: 'git@forgejo.example.com:alice/other.git' });
    await expect(
      resolveRemoteForRepo('/repo', 'https://forgejo.example.com', 'alice', 'repo'),
    ).resolves.toBeUndefined();
  });

  it('still requires the port to match for http(s) remotes', async () => {
    // Dropping the port for ssh remotes must not make http(s) matching lax: the
    // web port identifies the server.
    mockRemoteV({ origin: 'https://forgejo.example.com/alice/repo.git' });

    await expect(
      resolveRemoteForRepo('/repo', 'https://forgejo.example.com:3000', 'alice', 'repo'),
    ).resolves.toBeUndefined();
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

describe('workspace repository matching across transports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/ws/repo' } }];
    // Every candidate directory (the folder and its parent) is a repository.
    (fs.promises.access as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
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

  function remoteLines(url: string): string[] {
    return [`origin\t${url} (fetch)`, `origin\t${url} (push)`];
  }

  it('findLocalRepo matches an scp-style remote of the requested repository', async () => {
    mockRemoteV(remoteLines('git@forgejo.example.com:alice/repo.git'));

    await expect(findLocalRepo('https://forgejo.example.com', 'alice', 'repo')).resolves.toBe('/ws/repo');
  });

  it('findLocalRepo matches an ssh:// remote on an instance with a non-default web port', async () => {
    mockRemoteV(remoteLines('ssh://git@forgejo.example.com:2222/alice/repo.git'));

    await expect(findLocalRepo('https://forgejo.example.com:3000', 'alice', 'repo')).resolves.toBe('/ws/repo');
  });

  it('findLocalRepo matches when the configured instance URL carries credentials', async () => {
    mockRemoteV(remoteLines('https://forgejo.example.com/alice/repo.git'));

    await expect(findLocalRepo('https://alice:token_abc123@forgejo.example.com', 'alice', 'repo')).resolves.toBe(
      '/ws/repo',
    );
  });

  it('findLocalRepo does not match an ssh remote of another host or another repository', async () => {
    mockRemoteV(remoteLines('git@git.example.com:alice/repo.git'));
    await expect(findLocalRepo('https://forgejo.example.com', 'alice', 'repo')).resolves.toBeUndefined();

    mockRemoteV(remoteLines('git@forgejo.example.com:alice/other.git'));
    await expect(findLocalRepo('https://forgejo.example.com', 'alice', 'repo')).resolves.toBeUndefined();
  });

  it('isCurrentWorkspaceBaseRepo matches scp-style and ssh:// remotes', async () => {
    mockRemoteV(remoteLines('git@forgejo.example.com:alice/repo.git'));
    await expect(isCurrentWorkspaceBaseRepo('https://forgejo.example.com', 'alice', 'repo')).resolves.toBe('/ws/repo');

    mockRemoteV(remoteLines('ssh://git@forgejo.example.com:2222/alice/repo.git'));
    await expect(isCurrentWorkspaceBaseRepo('https://forgejo.example.com:3000', 'alice', 'repo')).resolves.toBe(
      '/ws/repo',
    );
  });

  it('isCurrentWorkspaceBaseRepo matches when the configured instance URL carries credentials', async () => {
    mockRemoteV(remoteLines('https://forgejo.example.com/alice/repo.git'));

    await expect(
      isCurrentWorkspaceBaseRepo('https://alice:token_abc123@forgejo.example.com', 'alice', 'repo'),
    ).resolves.toBe('/ws/repo');
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
