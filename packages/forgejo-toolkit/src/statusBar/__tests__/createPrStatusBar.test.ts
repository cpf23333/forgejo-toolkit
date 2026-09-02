import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CreatePrStatusBarController } from '../createPrStatusBar';
import type { ConfigManager } from '../../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

vi.mock('../../worktree/gitOperations', () => ({
  detectLinkedRepository: vi.fn(),
  getCurrentBranch: vi.fn(),
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

import { detectLinkedRepository, getCurrentBranch } from '../../worktree/gitOperations';

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

  it('shows the open-PR variant when an open PR matches head.ref', async () => {
    getRepoPullRequests.mockResolvedValue([{ number: 7, head: { ref: 'feature' } }]);
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

  it('matches an open PR via the head label fallback', async () => {
    getRepoPullRequests.mockResolvedValue([{ number: 9, head: { label: 'contributor:feature' } }]);
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request) PR #9');
  });

  it('hides the item when the API call fails', async () => {
    getRepoDetail.mockRejectedValue(new Error('network error'));
    const item = createController();
    await controller!.refresh();
    expect(item.hide).toHaveBeenCalled();
    expect(item.show).not.toHaveBeenCalled();
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
});
