import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CreatePrStatusBarController } from '../createPrStatusBar';
import type { ConfigManager } from '../../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

vi.mock('../../worktree/gitOperations', () => ({
  detectLinkedRepository: vi.fn(),
  getCurrentBranch: vi.fn(),
  getGitHeadPath: vi.fn(),
}));

const { getRepoDetail, getRepoPullRequests } = vi.hoisted(() => ({
  getRepoDetail: vi.fn(),
  getRepoPullRequests: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  ForgejoClient: class {
    getRepoDetail = getRepoDetail;
    getRepoPullRequests = getRepoPullRequests;
  },
}));

import { detectLinkedRepository, getCurrentBranch, getGitHeadPath } from '../../worktree/gitOperations';

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
    onInstancesChanged: () => ({ dispose: () => {} }),
  } as unknown as ConfigManager;
}

interface StatusBarItemMock {
  text: string;
  tooltip: unknown;
  command: unknown;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function lastStatusBarItem(): StatusBarItemMock {
  const results = vi.mocked(vscode.window.createStatusBarItem).mock.results;
  return results[results.length - 1].value as StatusBarItemMock;
}

describe('CreatePrStatusBarController', () => {
  let controller: CreatePrStatusBarController | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectLinkedRepository).mockResolvedValue(linked);
    vi.mocked(getCurrentBranch).mockResolvedValue('feature');
    vi.mocked(getGitHeadPath).mockResolvedValue('/workspace/repo/.git/HEAD');
    getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
    getRepoPullRequests.mockResolvedValue([]);
  });

  function createController(): StatusBarItemMock {
    controller = new CreatePrStatusBarController(createConfig());
    return lastStatusBarItem();
  }

  afterEach(() => {
    controller?.dispose();
    controller = undefined;
  });

  it('stays hidden when no repository is linked', async () => {
    vi.mocked(detectLinkedRepository).mockResolvedValue(undefined);
    const item = createController();
    await controller!.refresh();
    expect(item.hide).toHaveBeenCalled();
    expect(item.show).not.toHaveBeenCalled();
  });

  it('stays hidden when HEAD is detached', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue(undefined);
    const item = createController();
    await controller!.refresh();
    expect(item.hide).toHaveBeenCalled();
    expect(item.show).not.toHaveBeenCalled();
  });

  it('stays hidden on the default branch', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    const item = createController();
    await controller!.refresh();
    expect(item.hide).toHaveBeenCalled();
    expect(item.show).not.toHaveBeenCalled();
  });

  it('shows the create variant when no open PR exists for the branch', async () => {
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request-create) Create PR');
    expect(item.command).toBe('forgejoToolkit.createPrFromCurrentBranch');
    expect(item.show).toHaveBeenCalled();
  });

  it('shows the open-PR variant when an open PR matches head.ref in the same repository', async () => {
    getRepoPullRequests.mockResolvedValue([{ number: 7, head: { ref: 'feature', repo: { full_name: 'owner/repo' } } }]);
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request) PR #7');
    expect(item.command).toEqual({
      command: 'forgejoToolkit.createPrFromCurrentBranch',
      title: 'Open Pull Request',
      arguments: [{ index: 7 }],
    });
    expect(item.show).toHaveBeenCalled();
  });

  it('does not match an open PR from a fork with the same branch name', async () => {
    getRepoPullRequests.mockResolvedValue([
      { number: 11, head: { ref: 'feature', repo: { full_name: 'contributor/repo' } } },
    ]);
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request-create) Create PR');
  });

  it('matches an open PR via the head label fallback for the same owner', async () => {
    // head.repo is null when the fork was deleted; the label still identifies it.
    getRepoPullRequests.mockResolvedValue([
      { number: 9, head: { ref: 'feature', label: 'owner:feature', repo: null } },
    ]);
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request) PR #9');
  });

  it('rejects the head label fallback when the label owner differs', async () => {
    getRepoPullRequests.mockResolvedValue([
      { number: 12, head: { ref: 'feature', label: 'contributor:feature', repo: null } },
    ]);
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request-create) Create PR');
  });

  it('matches the bare-branch label form for same-repository PRs', async () => {
    getRepoPullRequests.mockResolvedValue([{ number: 13, head: { ref: 'feature', label: 'feature', repo: null } }]);
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request) PR #13');
  });

  it('does not show the item when the initial API call fails', async () => {
    getRepoDetail.mockRejectedValue(new Error('network error'));
    const item = createController();
    await controller!.refresh();
    expect(item.show).not.toHaveBeenCalled();
  });

  it('keeps the last known state when a later refresh fails', async () => {
    vi.useFakeTimers();
    try {
      const item = createController();
      await controller!.refresh();
      expect(item.show).toHaveBeenCalled();
      getRepoPullRequests.mockRejectedValue(new Error('network error'));
      vi.setSystemTime(Date.now() + 61_000);
      await controller!.refresh();
      expect(item.hide).not.toHaveBeenCalled();
      expect(item.text).toBe('$(git-pull-request-create) Create PR');
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches the default branch per repository', async () => {
    createController();
    await controller!.refresh();
    await controller!.refresh();
    expect(getRepoDetail).toHaveBeenCalledTimes(1);
  });

  it('caches the open-PR lookup until the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      createController();
      await controller!.refresh();
      await controller!.refresh();
      expect(getRepoPullRequests).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 61_000);
      await controller!.refresh();
      expect(getRepoPullRequests).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates the open-PR cache when pull requests change', async () => {
    createController();
    await controller!.refresh();
    expect(getRepoPullRequests).toHaveBeenCalledTimes(1);
    controller!.notifyPullRequestsChanged();
    await controller!.refresh();
    expect(getRepoPullRequests).toHaveBeenCalledTimes(2);
  });

  it('watches the resolved gitdir HEAD instead of <folder>/.git/HEAD', async () => {
    // Linked worktrees keep HEAD in the main repository's gitdir.
    vi.mocked(getGitHeadPath).mockResolvedValue('/main-repo/.git/worktrees/wt/HEAD');
    createController();
    await controller!.refresh();
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith({
      base: '/main-repo/.git/worktrees/wt',
      pattern: 'HEAD',
    });
  });
});
