import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CreatePrStatusBarController, DEFAULT_BRANCH_CACHE_TTL_MS } from '../createPrStatusBar';
import { logger } from '../../logger';
import type { ConfigManager } from '../../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

vi.mock('../../worktree/gitOperations', () => ({
  clearLinkedRepositoryCache: vi.fn(),
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

import {
  clearLinkedRepositoryCache,
  detectLinkedRepository,
  getCurrentBranch,
  getGitHeadPath,
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
    getRepoPullRequests.mockResolvedValue({ items: [] });
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
    getRepoPullRequests.mockResolvedValue({
      items: [{ number: 7, head: { ref: 'feature', repo: { full_name: 'owner/repo' } } }],
    });
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
    getRepoPullRequests.mockResolvedValue({
      items: [{ number: 11, head: { ref: 'feature', repo: { full_name: 'contributor/repo' } } }],
    });
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request-create) Create PR');
  });

  it('matches an open PR via the head label fallback for the same owner', async () => {
    // head.repo is null when the fork was deleted; the label still identifies it.
    getRepoPullRequests.mockResolvedValue({
      items: [{ number: 9, head: { ref: 'feature', label: 'owner:feature', repo: null } }],
    });
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request) PR #9');
  });

  it('rejects the head label fallback when the label owner differs', async () => {
    getRepoPullRequests.mockResolvedValue({
      items: [{ number: 12, head: { ref: 'feature', label: 'contributor:feature', repo: null } }],
    });
    const item = createController();
    await controller!.refresh();
    expect(item.text).toBe('$(git-pull-request-create) Create PR');
  });

  it('matches the bare-branch label form for same-repository PRs', async () => {
    getRepoPullRequests.mockResolvedValue({
      items: [{ number: 13, head: { ref: 'feature', label: 'feature', repo: null } }],
    });
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

  it('re-reads the default branch once its cache entry expires', async () => {
    // A default branch renamed (or changed in the repository settings) while the
    // window stays open must not leave the button keyed to the old one forever.
    vi.useFakeTimers();
    try {
      createController();
      await controller!.refresh();
      await controller!.refresh();
      expect(getRepoDetail).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + DEFAULT_BRANCH_CACHE_TTL_MS + 1);
      await controller!.refresh();
      expect(getRepoDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops both per-repository caches when instances change', async () => {
    // An edited instance keeps its id, so the repository key is unchanged: the
    // caches have to be cleared explicitly or the button keeps answering with
    // the previous repository's default branch and open PRs.
    vi.useFakeTimers();
    try {
      let listener: (() => void) | undefined;
      const config = {
        getInstances: () => [instance],
        onInstancesChanged: (l: () => void) => {
          listener = l;
          return { dispose: () => {} };
        },
      } as unknown as ConfigManager;
      controller = new CreatePrStatusBarController(config);
      await controller.refresh();
      expect(getRepoDetail).toHaveBeenCalledTimes(1);
      expect(getRepoPullRequests).toHaveBeenCalledTimes(1);

      listener!();
      await controller.refresh();

      expect(getRepoDetail).toHaveBeenCalledTimes(2);
      expect(getRepoPullRequests).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  it('does not let a superseded refresh overwrite the open-PR cache', async () => {
    vi.useFakeTimers();
    try {
      let resolveSlow: (pulls: unknown) => void = () => undefined;
      getRepoPullRequests.mockImplementationOnce(
        () =>
          new Promise<unknown>((resolve) => {
            resolveSlow = resolve;
          }),
      );
      getRepoPullRequests.mockResolvedValue({
        items: [{ number: 7, head: { ref: 'feature', repo: { full_name: 'owner/repo' } } }],
      });

      const item = createController();
      const refreshA = controller!.refresh();
      // Let refresh A reach its still-pending pull-request lookup.
      await vi.advanceTimersByTimeAsync(0);
      expect(getRepoPullRequests).toHaveBeenCalledTimes(1);

      // Refresh B supersedes A and finds the PR that was just created.
      const refreshB = controller!.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(item.text).toBe('$(git-pull-request) PR #7');

      // A completes late with its older "no PR" answer. It must not repopulate
      // the cache that notifyPullRequestsChanged cleared.
      resolveSlow({ items: [] });
      await refreshA;
      await refreshB;

      getRepoPullRequests.mockClear();
      await controller!.refresh();
      expect(getRepoPullRequests).not.toHaveBeenCalled();
      expect(item.text).toBe('$(git-pull-request) PR #7');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a superseded refresh overwrite the default-branch cache', async () => {
    vi.useFakeTimers();
    try {
      let resolveSlow: (detail: unknown) => void = () => undefined;
      getRepoDetail.mockImplementationOnce(
        () =>
          new Promise<unknown>((resolve) => {
            resolveSlow = resolve;
          }),
      );
      getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
      getRepoPullRequests.mockResolvedValue({
        items: [{ number: 7, head: { ref: 'feature', repo: { full_name: 'owner/repo' } } }],
      });

      const item = createController();
      const refreshA = controller!.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(getRepoDetail).toHaveBeenCalledTimes(1);

      const refreshB = controller!.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(item.text).toBe('$(git-pull-request) PR #7');

      // A's older answer (the current branch as the default) would make every
      // later refresh treat the branch as the default and hide the button.
      resolveSlow({ repository: { default_branch: 'feature' } });
      await refreshA;
      await refreshB;

      await controller!.refresh();
      expect(item.hide).not.toHaveBeenCalled();
      expect(item.text).toBe('$(git-pull-request) PR #7');
    } finally {
      vi.useRealTimers();
    }
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

  it('uses a single open-PR request to answer the branch lookup', async () => {
    const item = createController();
    await controller!.refresh();

    // One request answers "is there a PR for this branch?"; paging through the
    // whole list (up to the 500-item cap) would issue up to 10 requests per
    // refresh for a status bar that only needs the first page.
    expect(getRepoPullRequests).toHaveBeenCalledTimes(1);
    expect(getRepoPullRequests).toHaveBeenCalledWith('owner', 'repo', 'open');
    expect(item.text).toBe('$(git-pull-request-create) Create PR');
  });

  it('keeps the PR number correct when the open-PR list spans several pages', async () => {
    // The branch's PR sits beyond the first server page; the count shown must
    // still be its real number rather than a first-page-only guess.
    const manyPulls = Array.from({ length: 120 }, (_unused, index) => ({
      number: index + 1,
      head: { ref: `other-${index}`, repo: { full_name: 'owner/repo' } },
    }));
    getRepoPullRequests.mockResolvedValue({
      items: [...manyPulls, { number: 987, head: { ref: 'feature', repo: { full_name: 'owner/repo' } } }],
    });

    const item = createController();
    await controller!.refresh();

    expect(item.text).toBe('$(git-pull-request) PR #987');
    expect(item.command).toEqual({
      command: 'forgejoToolkit.createPrFromCurrentBranch',
      title: 'Open Pull Request',
      arguments: [{ index: 987 }],
    });
  });

  it('still reports the create variant when the open-PR list is truncated at the shared cap', async () => {
    // No total reported, so isListTruncatedWithTotal falls back to the length
    // heuristic (LIST_ITEM_LIMIT = 500): a list at the cap may be missing the
    // branch's PR, and the controller must not throw or mis-attribute a number
    // from the rows it did receive.
    const cappedPulls = Array.from({ length: 500 }, (_unused, index) => ({
      number: index + 1,
      head: { ref: `other-${index}`, repo: { full_name: 'owner/repo' } },
    }));
    getRepoPullRequests.mockResolvedValue({ items: cappedPulls });

    const item = createController();
    await controller!.refresh();

    expect(item.text).toBe('$(git-pull-request-create) Create PR');
    expect(item.show).toHaveBeenCalled();
  });

  it('does not warn about a possible miss when the total says the capped list is whole', async () => {
    // Exactly LIST_ITEM_LIMIT open pull requests and a matching X-Total-Count:
    // the cap was reached but nothing was cut, so no "possible miss" is logged.
    const errorSpy = vi.spyOn(logger, 'error');
    const cappedPulls = Array.from({ length: 500 }, (_unused, index) => ({
      number: index + 1,
      head: { ref: `other-${index}`, repo: { full_name: 'owner/repo' } },
    }));
    getRepoPullRequests.mockResolvedValue({ items: cappedPulls, totalCount: 500 });

    const item = createController();
    await controller!.refresh();

    expect(item.text).toBe('$(git-pull-request-create) Create PR');
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('reached the 500-item cap'));
  });

  it('clears the linked repository detection cache when instances change', () => {
    // A token-only instance change keeps the same detection cache key, so the
    // controller must drop the shared cache explicitly on onInstancesChanged.
    let listener: (() => void) | undefined;
    const config = {
      getInstances: () => [instance],
      onInstancesChanged: (l: () => void) => {
        listener = l;
        return { dispose: () => {} };
      },
    } as unknown as ConfigManager;
    controller = new CreatePrStatusBarController(config);

    listener!();

    expect(vi.mocked(clearLinkedRepositoryCache)).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the active text editor changes', async () => {
    // Multi-repo workspaces attribute the linked repository to the active
    // editor, so switching editors must re-resolve it.
    vi.useFakeTimers();
    try {
      createController();
      await vi.advanceTimersByTimeAsync(1000); // constructor's initial refresh
      vi.mocked(detectLinkedRepository).mockClear();
      const handler = vi.mocked(vscode.window.onDidChangeActiveTextEditor).mock.calls.at(-1)![0] as () => void;
      handler();
      await vi.advanceTimersByTimeAsync(1000);
      expect(vi.mocked(detectLinkedRepository)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
