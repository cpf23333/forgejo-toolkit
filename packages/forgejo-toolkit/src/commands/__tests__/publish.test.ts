import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../../worktree/gitOperations', async (importOriginal) => {
  // Keep remoteMatchesInstance, parseRemoteUrl and redactRemoteUrl real: the
  // multi-account selection logic depends on genuine host matching and genuine
  // owner/repo parsing, and the log/quick-pick path strips stored credentials
  // with the real redaction.
  const original = await importOriginal<typeof import('../../worktree/gitOperations')>();
  return {
    addRemote: vi.fn(),
    clearLinkedRepositoryCache: vi.fn(),
    getCurrentBranch: vi.fn(),
    getCurrentCommitSha: vi.fn(),
    getUpstreamBranch: vi.fn(),
    listRemotes: vi.fn(),
    listWorkspaceRepositories: vi.fn(),
    parseRemoteUrl: original.parseRemoteUrl,
    pushBranch: vi.fn(),
    redactRemoteUrl: original.redactRemoteUrl,
    remoteMatchesInstance: original.remoteMatchesInstance,
  };
});

const { createUserRepo } = vi.hoisted(() => ({
  createUserRepo: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  ForgejoClient: class {
    createUserRepo = createUserRepo;
  },
}));

import { extractApiErrorMessage, publishToForgejo, validateRemoteName, validateRepoName } from '../publish';
import { ApiError } from '../../api/errors';
import {
  addRemote,
  clearLinkedRepositoryCache,
  getCurrentBranch,
  getCurrentCommitSha,
  getUpstreamBranch,
  listRemotes,
  listWorkspaceRepositories,
  pushBranch,
} from '../../worktree/gitOperations';
import type { ConfigManager } from '../../config';
import { logger } from '../../logger';
import type { ForgejoToolkitViewProvider } from '../../webview/viewProvider';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

const INSTANCE_URL = 'https://forgejo.example.com';

function instance(id: string, username: string, token: string): ForgejoInstance {
  return { id, url: INSTANCE_URL, token, name: `${username}@host`, username };
}

function createConfig(instances: ForgejoInstance[]): ConfigManager {
  return { getInstances: () => instances } as unknown as ConfigManager;
}

function createViewProvider(): { provider: ForgejoToolkitViewProvider; refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn();
  return { provider: { refresh } as unknown as ForgejoToolkitViewProvider, refresh };
}

const showInputBox = vi.fn();

function setupWorkspace(remoteUrl?: string) {
  (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/repo' } }];
  vi.mocked(listWorkspaceRepositories).mockResolvedValue(['/repo']);
  vi.mocked(listRemotes).mockResolvedValue(remoteUrl ? [{ name: 'origin', url: remoteUrl }] : []);
}

describe('validateRepoName', () => {
  it('accepts letters, digits, dot, underscore and dash', () => {
    expect(validateRepoName('my-repo_1.0')).toBeUndefined();
  });

  it('rejects empty names', () => {
    expect(validateRepoName('   ')).toBeTruthy();
  });

  it('rejects names starting with a dot', () => {
    expect(validateRepoName('.hidden')).toBeTruthy();
    expect(validateRepoName('..')).toBeTruthy();
  });

  it('rejects names with characters outside the allowed set', () => {
    expect(validateRepoName('bad name')).toBeTruthy();
    expect(validateRepoName('bad/name')).toBeTruthy();
  });
});

describe('validateRemoteName', () => {
  const existing = [{ name: 'origin', url: 'https://git.example.com/alice/repo.git' }];

  it('accepts a free valid name', () => {
    expect(validateRemoteName('forgejo', existing)).toBeUndefined();
    expect(validateRemoteName('na.me-1_x', existing)).toBeUndefined();
  });

  it('rejects empty names and invalid characters', () => {
    expect(validateRemoteName('  ', existing)).toBeTruthy();
    expect(validateRemoteName('bad name', existing)).toBeTruthy();
    expect(validateRemoteName('bad/name', existing)).toBeTruthy();
  });

  it('rejects names git check-ref-format would reject', () => {
    expect(validateRemoteName('a..b', existing)).toBeTruthy();
    expect(validateRemoteName('..', existing)).toBeTruthy();
    expect(validateRemoteName('-bad', existing)).toBeTruthy();
    expect(validateRemoteName('.hidden', existing)).toBeTruthy();
    expect(validateRemoteName('trail.', existing)).toBeTruthy();
    expect(validateRemoteName('name.lock', existing)).toBeTruthy();
  });

  it('rejects a name already used by another remote', () => {
    expect(validateRemoteName('origin', existing)).toBeTruthy();
  });
});

describe('extractApiErrorMessage', () => {
  it('pulls the message field out of a JSON error body', () => {
    expect(extractApiErrorMessage('Forgejo API error 422: {"message":"name is reserved"}')).toBe('name is reserved');
  });

  it('falls back to the raw text when the body is not JSON', () => {
    expect(extractApiErrorMessage('Forgejo API error 500: boom')).toBe('Forgejo API error 500: boom');
  });
});

describe('publishToForgejo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.window as unknown as { showInputBox: typeof showInputBox }).showInputBox = showInputBox;
  });

  it('aborts before creating a remote repository when the local one has no commits', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue(undefined);
    const { provider } = createViewProvider();

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]), provider);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('no commits'));
    expect(showInputBox).not.toHaveBeenCalled();
    expect(createUserRepo).not.toHaveBeenCalled();
  });

  it('reports a 422 "already exists" body as a name conflict', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockRejectedValue(
      new Error('Forgejo API error 422: {"message":"The repository with the same name already exists."}'),
    );

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });

  it('passes through the server validation message for other 422s', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    // The client wraps HTTP failures in ApiError; the user-facing message keeps
    // the server's reason and offers a log button.
    createUserRepo.mockRejectedValue(
      new ApiError('http', 'Forgejo API error 422: {"message":"name is reserved"}', 422),
    );

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('name is reserved'),
      'View Log',
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });

  it('refreshes the dashboard data after a successful publish', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockResolvedValue({ clone_url: `${INSTANCE_URL}/alice/my-repo.git`, full_name: 'alice/my-repo' });
    const { provider, refresh } = createViewProvider();

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]), provider);

    expect(pushBranch).toHaveBeenCalled();
    // The 10s linked-repository scan cache only keys on folders and instances,
    // so the new remote must invalidate it before the refresh reads it.
    expect(clearLinkedRepositoryCache).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clearLinkedRepositoryCache).mock.invocationCallOrder[0]).toBeLessThan(
      refresh.mock.invocationCallOrder[0],
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('clears the linked-repository cache when the remote was added but no branch is checked out', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue(undefined);
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockResolvedValue({ clone_url: `${INSTANCE_URL}/alice/my-repo.git`, full_name: 'alice/my-repo' });
    const { provider, refresh } = createViewProvider();

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]), provider);

    expect(addRemote).toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
    expect(clearLinkedRepositoryCache).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('opens the published repository in the browser when html_url is http(s)', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockResolvedValue({
      clone_url: `${INSTANCE_URL}/alice/my-repo.git`,
      full_name: 'alice/my-repo',
      html_url: `${INSTANCE_URL}/alice/my-repo`,
    });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Open in Browser' as never);

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    expect((vi.mocked(vscode.env.openExternal).mock.calls[0][0] as { scheme: string }).scheme).toBe('https');
  });

  it('does not open an html_url with a non-web scheme', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    // html_url comes from the API response; a hostile or compromised instance
    // must not get the host to open arbitrary schemes.
    createUserRepo.mockResolvedValue({
      clone_url: `${INSTANCE_URL}/alice/my-repo.git`,
      full_name: 'alice/my-repo',
      html_url: 'javascript:alert(1)',
    });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Open in Browser' as never);

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it('asks which account to push with when several match the remote and the owner does not disambiguate', async () => {
    setupWorkspace(`${INSTANCE_URL}/shared/repo.git`);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    vi.mocked(getUpstreamBranch).mockResolvedValue(undefined);
    const bob = instance('b', 'bob', 'tok-bob');
    // The pick lists accounts in config order; select the second one (bob).
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: bob.name, instance: bob } as never);
    const { provider, refresh } = createViewProvider();

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok-alice'), bob]), provider);

    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(pushBranch).toHaveBeenCalledWith('/repo', 'origin', 'main', 'tok-bob', true, INSTANCE_URL);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('pushes with the account matching the remote owner without asking', async () => {
    setupWorkspace(`${INSTANCE_URL}/bob/repo.git`);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/main');

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok-alice'), instance('b', 'bob', 'tok-bob')]));

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(pushBranch).toHaveBeenCalledWith('/repo', 'origin', 'main', 'tok-bob', false, INSTANCE_URL);
  });

  it('parses the owner out of an scp remote whose login is not "git"', async () => {
    // `alice@host:owner/repo.git` is a legal remote, but the shared URL parser
    // only recognises the `git@` spelling: without the transport-agnostic parse
    // the owner lookup fails and the account cannot be disambiguated.
    setupWorkspace('alice@forgejo.example.com:bob/repo.git');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/main');

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok-alice'), instance('b', 'bob', 'tok-bob')]));

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(pushBranch).toHaveBeenCalledWith('/repo', 'origin', 'main', 'tok-bob', false, INSTANCE_URL);
  });

  it('redacts stored credentials from the remote URL it logs', async () => {
    // `git remote -v` reports whatever the repository stores, so the remote may
    // embed `user:token@`; the output channel must never receive that token.
    setupWorkspace('https://bob:secret-token@forgejo.example.com/bob/repo.git');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/main');
    const infoSpy = vi.spyOn(logger, 'info');

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok-alice'), instance('b', 'bob', 'tok-bob')]));

    const logged = infoSpy.mock.calls.map((call) => String(call[0])).join('\n');
    infoSpy.mockRestore();
    expect(logged).toContain('accounts match');
    expect(logged).toContain('forgejo.example.com/bob/repo.git');
    expect(logged).not.toContain('secret-token');
  });

  // Push failures must propagate to the command registration's catch
  // (commands/index.ts), which shows "Failed to publish". Swallowing them here
  // would pretend success — worst case right after the remote repository was
  // already created. The propagated message spells out the intermediate state
  // (repository created, remote added) so a retry does not blindly hit a 422.
  it('propagates a push failure after the remote repository was created', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockResolvedValue({ clone_url: `${INSTANCE_URL}/alice/my-repo.git`, full_name: 'alice/my-repo' });
    vi.mocked(pushBranch).mockRejectedValue(new Error('push failed: permission denied'));
    const { provider, refresh } = createViewProvider();

    const failure = await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]), provider).catch(
      (error: unknown) => error,
    );
    vi.mocked(pushBranch).mockReset();

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('push failed');
    expect((failure as Error).message).toContain('alice/my-repo');
    expect((failure as Error).message).toContain('was created on');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports the created repository when adding the remote fails', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockResolvedValue({ clone_url: `${INSTANCE_URL}/alice/my-repo.git`, full_name: 'alice/my-repo' });
    vi.mocked(addRemote).mockRejectedValue(new Error('remote origin already exists'));
    const { provider, refresh } = createViewProvider();

    const failure = await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]), provider).catch(
      (error: unknown) => error,
    );
    vi.mocked(addRemote).mockReset();

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('alice/my-repo');
    expect((failure as Error).message).toContain('remote failed');
    expect((failure as Error).message).toContain('remote origin already exists');
    // The push must not be attempted without the remote in place.
    expect(pushBranch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('propagates a push failure when pushing to an existing remote', async () => {
    setupWorkspace(`${INSTANCE_URL}/alice/repo.git`);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/main');
    vi.mocked(pushBranch).mockRejectedValue(new Error('push failed: non-fast-forward'));

    await expect(publishToForgejo(createConfig([instance('a', 'alice', 'tok')]))).rejects.toThrow('push failed');
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('pushes to a Forgejo remote living under a non-origin name', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    vi.mocked(listWorkspaceRepositories).mockResolvedValue(['/repo']);
    vi.mocked(listRemotes).mockResolvedValue([
      { name: 'upstream', url: 'https://git.example.com/alice/repo.git' },
      { name: 'forgejo', url: `${INSTANCE_URL}/alice/repo.git` },
    ]);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    vi.mocked(getUpstreamBranch).mockResolvedValue('forgejo/main');
    vi.mocked(pushBranch).mockResolvedValue(undefined);

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    expect(pushBranch).toHaveBeenCalledWith('/repo', 'forgejo', 'main', 'tok', false, INSTANCE_URL);
  });

  it('prefers origin when several remotes match configured instances', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    vi.mocked(listWorkspaceRepositories).mockResolvedValue(['/repo']);
    vi.mocked(listRemotes).mockResolvedValue([
      { name: 'origin', url: `${INSTANCE_URL}/alice/repo.git` },
      { name: 'mirror', url: `${INSTANCE_URL}/alice/mirror.git` },
    ]);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    vi.mocked(getUpstreamBranch).mockResolvedValue(undefined);
    vi.mocked(pushBranch).mockResolvedValue(undefined);

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(pushBranch).toHaveBeenCalledWith('/repo', 'origin', 'main', 'tok', true, INSTANCE_URL);
  });

  it('publishes under a new remote name when every existing remote points elsewhere', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    vi.mocked(listWorkspaceRepositories).mockResolvedValue(['/repo']);
    // Cloned from a non-Forgejo host: origin is taken, nothing matches the
    // configured instance — the publish flow must still be offered.
    vi.mocked(listRemotes).mockResolvedValue([{ name: 'origin', url: 'https://git.example.com/alice/repo.git' }]);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    // Two input boxes: repository name, then the Forgejo remote's name.
    showInputBox.mockResolvedValueOnce('my-repo').mockResolvedValueOnce('forgejo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockResolvedValue({ clone_url: `${INSTANCE_URL}/alice/my-repo.git`, full_name: 'alice/my-repo' });

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    expect(createUserRepo).toHaveBeenCalled();
    expect(addRemote).toHaveBeenCalledWith('/repo', 'forgejo', `${INSTANCE_URL}/alice/my-repo.git`);
    expect(pushBranch).toHaveBeenCalledWith('/repo', 'forgejo', 'main', 'tok', true, INSTANCE_URL);
  });

  it('uses origin without asking when no remote exists yet', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockResolvedValue({ clone_url: `${INSTANCE_URL}/alice/my-repo.git`, full_name: 'alice/my-repo' });

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    // Only the repository name was asked for — no remote-name prompt.
    expect(showInputBox).toHaveBeenCalledTimes(1);
    expect(addRemote).toHaveBeenCalledWith('/repo', 'origin', `${INSTANCE_URL}/alice/my-repo.git`);
    expect(pushBranch).toHaveBeenCalledWith('/repo', 'origin', 'main', 'tok', true, INSTANCE_URL);
  });
});
