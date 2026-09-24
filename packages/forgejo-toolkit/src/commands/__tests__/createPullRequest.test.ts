import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createPrFromCurrentBranch } from '../createPullRequest';
import type { ConfigManager } from '../../config';
import type { ForgejoToolkitViewProvider } from '../../webview/viewProvider';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

vi.mock('../../worktree/gitOperations', async (importOriginal) => {
  // publish.ts's findInstanceForRemote (used by createPullRequest.ts) calls
  // the real remoteMatchesInstance, so keep it unmocked. The module's other
  // exports are spread through as well: vitest's mock proxy throws on any
  // export the factory does not define, so a partial factory breaks every test
  // the moment the module under test imports one more helper.
  const original = await importOriginal<typeof import('../../worktree/gitOperations')>();
  return {
    ...original,
    detectLinkedRepository: vi.fn(),
    getCurrentBranch: vi.fn(),
    getRemotePushUrls: vi.fn(),
    getUpstreamBranch: vi.fn(),
    getAheadCount: vi.fn(),
    pushBranch: vi.fn(),
    // The exact resolver (git config / longest remote-name match) is exercised
    // by the gitOperations tests; here it stands in for git's own answer.
    resolveUpstreamRemote: vi.fn(),
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
  resolveUpstreamRemote,
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

/**
 * Set the branch's upstream as git reports it (`git rev-parse --abbrev-ref
 * @{upstream}`) together with how `resolveUpstreamRemote` resolves it. The
 * resolver reads git's own configuration, which these tests do not have, so the
 * default splits at the first `/` like the old code did — the slash-named remote
 * cases pass `remote`/`branch` explicitly, which is the whole point of using the
 * resolver instead of the split.
 */
function setUpstream(value: string | undefined, remote?: string, branch?: string) {
  vi.mocked(getUpstreamBranch).mockResolvedValue(value);
  if (value === undefined) {
    vi.mocked(resolveUpstreamRemote).mockResolvedValue(undefined);
    return;
  }
  const slash = value.indexOf('/');
  vi.mocked(resolveUpstreamRemote).mockResolvedValue({
    remote: remote ?? value.slice(0, slash),
    branch: branch ?? value.slice(slash + 1),
  });
}

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
    setUpstream(undefined);
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
    setUpstream('origin/feature');
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
    setUpstream('origin/gone');
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
    setUpstream('origin/renamed-feature');
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
    setUpstream('origin/feature');
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
    setUpstream('mirror/feature');
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
    setUpstream('origin/feature');
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
    setUpstream('origin/feature');
    vi.mocked(getAheadCount).mockResolvedValue(1);
    vi.mocked(getRemotePushUrls).mockResolvedValue(undefined);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Push' as never);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(pushBranch).toHaveBeenCalledWith('/workspace/repo', 'origin', 'feature', undefined, false, instance.url);
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalled();
  });

  it('uses the resolved remote for a slash-named upstream instead of splitting it', async () => {
    // `my/fork` is a valid remote name (`isSafeRemoteName` allows the slash), so
    // `my/fork/feature` is remote `my/fork` with branch `feature`. The
    // first-slash split produced remote `my`, so the push and the prefilled PR
    // head named a remote that does not exist.
    setUpstream('my/fork/feature', 'my/fork', 'feature');
    vi.mocked(getAheadCount).mockResolvedValue(1);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Push' as never);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(getRemotePushUrls).toHaveBeenCalledWith('/workspace/repo', 'my/fork');
    expect(pushBranch).toHaveBeenCalledWith('/workspace/repo', 'my/fork', 'feature', 'token', false, instance.url);
    expect(viewProvider.openCreatePullRequest).toHaveBeenCalledWith({
      instanceId: 'inst1',
      owner: 'owner',
      repo: 'repo',
      head: 'feature',
    });
  });

  it('aborts with a localized message when the upstream names no configured remote', async () => {
    // git knows the branch has an upstream but it cannot be attributed to a
    // configured remote: pushing would target an invented remote, so the flow
    // reports the real problem instead.
    setUpstream('ghost/feature');
    vi.mocked(resolveUpstreamRemote).mockResolvedValue(undefined);
    const viewProvider = createViewProvider();
    await createPrFromCurrentBranch(createConfig(), viewProvider);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      vscode.l10n.t(
        'The upstream branch "{0}" does not name a configured git remote in this repository, so the pull request head could not be resolved',
        'ghost/feature',
      ),
    );
    expect(pushBranch).not.toHaveBeenCalled();
    expect(getRemotePushUrls).not.toHaveBeenCalled();
    expect(viewProvider.openCreatePullRequest).not.toHaveBeenCalled();
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
    setUpstream('origin/feature');
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
