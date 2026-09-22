import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createPrFromCurrentBranch } from '../createPullRequest';
import type { ConfigManager } from '../../config';
import type { ForgejoToolkitViewProvider } from '../../webview/viewProvider';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

vi.mock('../../worktree/gitOperations', async (importOriginal) => {
  // publish.ts's findInstanceForRemote (used by createPullRequest.ts) calls
  // the real remoteMatchesInstance, so keep it unmocked.
  const original = await importOriginal<typeof import('../../worktree/gitOperations')>();
  return {
    detectLinkedRepository: vi.fn(),
    getCurrentBranch: vi.fn(),
    getRemotePushUrls: vi.fn(),
    getUpstreamBranch: vi.fn(),
    getAheadCount: vi.fn(),
    pushBranch: vi.fn(),
    remoteMatchesInstance: original.remoteMatchesInstance,
  };
});

const { getRepoDetail } = vi.hoisted(() => ({
  getRepoDetail: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  ForgejoClient: class {
    getRepoDetail = getRepoDetail;
  },
}));

import {
  detectLinkedRepository,
  getAheadCount,
  getCurrentBranch,
  getRemotePushUrls,
  getUpstreamBranch,
  pushBranch,
} from '../../worktree/gitOperations';

const instance: ForgejoInstance = {
  id: 'inst1',
  url: 'https://forgejo.example.com',
  token: 'token',
  name: 'user@forgejo.example.com',
  username: 'user',
};

const linked = {
  instanceId: instance.id,
  owner: 'owner',
  repo: 'repo',
  localPath: '/workspace/repo',
  remoteUrl: 'https://forgejo.example.com/owner/repo.git',
};

function createConfig(): ConfigManager {
  return {
    getInstances: () => [instance],
  } as unknown as ConfigManager;
}

function createViewProvider() {
  return {
    openCreatePullRequest: vi.fn(),
    openPullRequestDetail: vi.fn(),
  } as unknown as ForgejoToolkitViewProvider & {
    openCreatePullRequest: ReturnType<typeof vi.fn>;
    openPullRequestDetail: ReturnType<typeof vi.fn>;
  };
}

describe('createPrFromCurrentBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectLinkedRepository).mockResolvedValue(linked);
    vi.mocked(getCurrentBranch).mockResolvedValue('feature');
    vi.mocked(getUpstreamBranch).mockResolvedValue(undefined);
    vi.mocked(getAheadCount).mockResolvedValue(undefined);
    // Default: the push remote belongs to the linked instance, so pushes
    // keep authenticating with the instance token.
    vi.mocked(getRemotePushUrls).mockResolvedValue(['https://forgejo.example.com/owner/repo.git']);
    vi.mocked(pushBranch).mockResolvedValue(undefined);
    getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
  });

  it('prompts to push when the branch has no upstream, then opens the create form', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Push' as never);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(pushBranch).toHaveBeenCalledWith('/workspace/repo', 'origin', 'feature', 'token', true, instance.url);
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalledWith({
      instanceId: 'inst1',
      owner: 'owner',
      repo: 'repo',
      head: 'feature',
    });
  });

  it('aborts without pushing when the user declines the push prompt', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(pushBranch).not.toHaveBeenCalled();
    expect(viewProvider.openCreatePullRequest).not.toHaveBeenCalled();
  });

  it('prompts to push when the branch is ahead of its upstream', async () => {
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/feature');
    vi.mocked(getAheadCount).mockResolvedValue(2);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Push' as never);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(pushBranch).toHaveBeenCalledWith('/workspace/repo', 'origin', 'feature', 'token', false, instance.url);
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalledWith({
      instanceId: 'inst1',
      owner: 'owner',
      repo: 'repo',
      head: 'feature',
    });
  });

  it('prompts to push when the upstream ref cannot be resolved (deleted remote branch)', async () => {
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/gone');
    vi.mocked(getAheadCount).mockResolvedValue(undefined);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Push' as never);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    // Pushing recreates the deleted remote branch, so the prefilled head exists.
    expect(pushBranch).toHaveBeenCalledWith('/workspace/repo', 'origin', 'feature:gone', 'token', false, instance.url);
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalledWith({
      instanceId: 'inst1',
      owner: 'owner',
      repo: 'repo',
      head: 'gone',
    });
  });

  it('prefills head with the upstream remote branch name when it differs from the local name', async () => {
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/renamed-feature');
    vi.mocked(getAheadCount).mockResolvedValue(0);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalledWith({
      instanceId: 'inst1',
      owner: 'owner',
      repo: 'repo',
      head: 'renamed-feature',
    });
  });

  it('pushes with the instance token when the upstream remote belongs to the linked instance', async () => {
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/feature');
    vi.mocked(getAheadCount).mockResolvedValue(1);
    vi.mocked(getRemotePushUrls).mockResolvedValue(['git@forgejo.example.com:owner/repo.git']);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Push' as never);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(getRemotePushUrls).toHaveBeenCalledWith('/workspace/repo', 'origin');
    expect(pushBranch).toHaveBeenCalledWith('/workspace/repo', 'origin', 'feature', 'token', false, instance.url);
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalled();
  });

  it('aborts without pushing when the upstream remote belongs to another host', async () => {
    vi.mocked(getUpstreamBranch).mockResolvedValue('mirror/feature');
    vi.mocked(getAheadCount).mockResolvedValue(1);
    vi.mocked(getRemotePushUrls).mockResolvedValue(['https://github.example.com/owner/repo.git']);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
    expect(viewProvider.openCreatePullRequest).not.toHaveBeenCalled();
  });

  it('aborts without pushing when only one of the push targets belongs to the instance', async () => {
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/feature');
    vi.mocked(getAheadCount).mockResolvedValue(1);
    // A mirror configured through remote.<name>.pushurl: the Forgejo URL is
    // still there, but git would also push to the mirror with the token.
    vi.mocked(getRemotePushUrls).mockResolvedValue([
      'https://forgejo.example.com/owner/repo.git',
      'https://mirror.example.com/owner/repo.git',
    ]);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
    expect(viewProvider.openCreatePullRequest).not.toHaveBeenCalled();
  });

  it('pushes without the token when the upstream remote URL cannot be resolved', async () => {
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/feature');
    vi.mocked(getAheadCount).mockResolvedValue(1);
    vi.mocked(getRemotePushUrls).mockResolvedValue(undefined);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Push' as never);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(pushBranch).toHaveBeenCalledWith('/workspace/repo', 'origin', 'feature', undefined, false, instance.url);
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalled();
  });

  it('blocks the command on the default branch', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
    expect(viewProvider.openCreatePullRequest).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the default-branch lookup fails (offline)', async () => {
    getRepoDetail.mockRejectedValue(new Error('network down'));
    // With an up-to-date upstream no push prompt appears; the flow continues.
    vi.mocked(getUpstreamBranch).mockResolvedValue('origin/feature');
    vi.mocked(getAheadCount).mockResolvedValue(0);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalledWith({
      instanceId: 'inst1',
      owner: 'owner',
      repo: 'repo',
      head: 'feature',
    });
  });

  it('opens the existing pull request directly when an index is given', async () => {
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider, { index: 5 });
    expect(viewProvider.openPullRequestDetail).toHaveBeenCalledWith({
      instanceId: 'inst1',
      owner: 'owner',
      repo: 'repo',
      index: 5,
    });
    expect(getRepoDetail).not.toHaveBeenCalled();
    expect(viewProvider.openCreatePullRequest).not.toHaveBeenCalled();
  });
});
