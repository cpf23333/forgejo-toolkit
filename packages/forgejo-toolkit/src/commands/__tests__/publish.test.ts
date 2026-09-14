import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../../worktree/gitOperations', async (importOriginal) => {
  // Keep remoteMatchesInstance real: the multi-account selection logic depends
  // on genuine host matching.
  const original = await importOriginal<typeof import('../../worktree/gitOperations')>();
  return {
    addRemote: vi.fn(),
    getCurrentBranch: vi.fn(),
    getCurrentCommitSha: vi.fn(),
    getUpstreamBranch: vi.fn(),
    listRemotes: vi.fn(),
    listWorkspaceRepositories: vi.fn(),
    pushBranch: vi.fn(),
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

import { extractApiErrorMessage, publishToForgejo, validateRepoName } from '../publish';
import { ApiError } from '../../api/errors';
import {
  getCurrentBranch,
  getCurrentCommitSha,
  getUpstreamBranch,
  listRemotes,
  listWorkspaceRepositories,
  pushBranch,
} from '../../worktree/gitOperations';
import type { ConfigManager } from '../../config';
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
    expect(refresh).toHaveBeenCalledTimes(1);
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

  // Push failures must propagate to the command registration's catch
  // (commands/index.ts), which shows "Failed to publish". Swallowing them here
  // would pretend success — worst case right after the remote repository was
  // already created.
  it('propagates a push failure after the remote repository was created', async () => {
    setupWorkspace(undefined);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('sha1');
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    showInputBox.mockResolvedValue('my-repo');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Private', value: true } as never);
    createUserRepo.mockResolvedValue({ clone_url: `${INSTANCE_URL}/alice/my-repo.git`, full_name: 'alice/my-repo' });
    vi.mocked(pushBranch).mockRejectedValue(new Error('push failed: permission denied'));
    const { provider, refresh } = createViewProvider();

    await expect(publishToForgejo(createConfig([instance('a', 'alice', 'tok')]), provider)).rejects.toThrow(
      'push failed',
    );
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

  it('warns when no remote matches a configured instance', async () => {
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    vi.mocked(listWorkspaceRepositories).mockResolvedValue(['/repo']);
    vi.mocked(listRemotes).mockResolvedValue([{ name: 'origin', url: 'https://git.example.com/alice/repo.git' }]);

    await publishToForgejo(createConfig([instance('a', 'alice', 'tok')]));

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('No git remote'));
    expect(pushBranch).not.toHaveBeenCalled();
    expect(createUserRepo).not.toHaveBeenCalled();
  });
});
