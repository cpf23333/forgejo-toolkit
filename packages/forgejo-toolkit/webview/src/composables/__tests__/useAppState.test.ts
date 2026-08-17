import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import type {
  ForgejoActionRun,
  ForgejoBranch,
  ForgejoChangedFile,
  ForgejoCommit,
  ForgejoContentEntry,
  ForgejoIssue,
  ForgejoIssueDetail,
  ForgejoNotification,
  ForgejoPullRequest,
  ForgejoPullRequestCommit,
  ForgejoPullRequestDetail,
  ForgejoRelease,
  ForgejoRepoDetail,
  ForgejoRepository,
  ForgejoTag,
  ForgejoTimelineComment,
} from '../../types/api';

let messageHandlers: Array<(event: MessageEvent) => void> = [];
let vscodeApiMock: {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  messageHandlers = [];
  vscodeApiMock = {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
  (window as unknown as { acquireVsCodeApi: () => typeof vscodeApiMock }).acquireVsCodeApi = () => vscodeApiMock;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'message') {
      messageHandlers.push(listener as (event: MessageEvent) => void);
    }
  });
});

afterEach(() => {
  messageHandlers = [];
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

function vscodePostMessage() {
  return vscodeApiMock.postMessage;
}

async function createState() {
  vi.resetModules();
  const mod = await import('../../composables/useAppState');
  const router = createTestRouter();
  const i18n = createTestI18n();
  const wrapper = mount(
    {
      template: '<div></div>',
      setup() {
        const state = mod.useAppState();
        return { state };
      },
    },
    {
      global: {
        plugins: [router, i18n],
      },
    },
  );
  await flushPromises();
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, mod };
}

const fakeUser = {
  id: 1,
  login: 'user',
  full_name: 'User',
  email: 'user@example.com',
  avatar_url: 'https://example.com/avatar.png',
};

const fakeRepository: ForgejoRepository = {
  id: 1,
  name: 'repo',
  full_name: 'owner/repo',
  html_url: 'https://forgejo.example.com/owner/repo',
  private: false,
  description: 'A test repo',
  owner: fakeUser,
  default_branch: 'main',
  stars_count: 0,
  forks_count: 0,
  open_issues_count: 0,
};

const fakeRepoDetail: ForgejoRepoDetail = {
  repository: fakeRepository,
  empty: false,
  branches: ['main'],
  recentCommits: [],
};

const fakeIssue: ForgejoIssue = {
  id: 1,
  number: 1,
  title: 'Issue 1',
  state: 'open',
  html_url: 'https://forgejo.example.com/owner/repo/issues/1',
  user: fakeUser,
  body: 'body',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const fakeIssueDetail: ForgejoIssueDetail = {
  id: 1,
  number: 1,
  title: 'Issue 1',
  state: 'open',
  html_url: 'https://forgejo.example.com/owner/repo/issues/1',
  user: fakeUser,
  body: 'body',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const fakePullRequest: ForgejoPullRequest = {
  id: 2,
  number: 2,
  title: 'PR 1',
  state: 'open',
  html_url: 'https://forgejo.example.com/owner/repo/pulls/2',
  user: fakeUser,
  body: 'body',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const fakePullRequestDetail: ForgejoPullRequestDetail = {
  ...fakeIssueDetail,
  id: 2,
  number: 2,
};

const fakeContentEntry: ForgejoContentEntry = {
  name: 'README.md',
  path: 'README.md',
  type: 'file',
  sha: 'abc',
  size: 42,
};

const fakeCommit: ForgejoCommit = {
  sha: 'abc',
  commit: {
    message: 'init',
    author: { name: 'User', date: '2024-01-01T00:00:00Z' },
  },
  html_url: 'https://forgejo.example.com/owner/repo/commit/abc',
};

const fakeBranch: ForgejoBranch = { name: 'main' };
const fakeTag: ForgejoTag = { name: 'v1.0.0' };
const fakeRelease: ForgejoRelease = { id: 1, name: 'v1.0.0', tag_name: 'v1.0.0' };

const fakeActionRun: ForgejoActionRun = {
  id: 1,
  title: 'Build',
  status: 'success',
};

const fakeNotification: ForgejoNotification = {
  id: 1,
  unread: true,
  subject: { title: 'Mention' },
};

const fakeChangedFile: ForgejoChangedFile = {
  filename: 'src/index.ts',
  status: 'modified',
};

const fakeTimelineComment: ForgejoTimelineComment = {
  id: 1,
  type: 'comment',
  body: 'LGTM',
  user: fakeUser,
};

const fakePullRequestCommit: ForgejoPullRequestCommit = {
  ...fakeCommit,
};

describe('useAppState', () => {
  describe('initialState message', () => {
    it('sets instances, locale, debug, worktrees and worktree settings', async () => {
      const { state } = await createState();
      const instance = { id: 'inst-1', url: 'https://forgejo.example.com', token: 'token' };

      dispatchMessage({
        command: 'initialState',
        instances: [instance],
        locale: 'en',
        debug: true,
        worktrees: [],
        worktreeOpenMode: 'newWindow',
        worktreeCacheDirectory: '/tmp/wt',
        worktreeCacheDirectoryDefault: '/tmp/default',
      });
      await nextTick();

      expect(state.instances.value).toEqual([instance]);
      expect(state.locale.value).toBe('en');
      expect(state.debug.value).toBe(true);
      expect(state.worktreeOpenMode.value).toBe('newWindow');
      expect(state.worktreeCacheDirectory.value).toBe('/tmp/wt');
      expect(state.worktreeCacheDirectoryDefault.value).toBe('/tmp/default');
    });

    it('requests initial state on mount', async () => {
      await createState();

      expect(vscodePostMessage()).toHaveBeenCalledWith(expect.objectContaining({ command: 'getInitialState' }));
    });

    it('requests linked repository after receiving initial state', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      dispatchMessage({
        command: 'initialState',
        instances: [],
        locale: 'zh',
        debug: false,
        worktrees: [],
        worktreeOpenMode: 'ask',
        worktreeCacheDirectory: '',
        worktreeCacheDirectoryDefault: '',
      });
      await nextTick();

      expect(vscodePostMessage()).toHaveBeenCalledWith(expect.objectContaining({ command: 'getLinkedRepository' }));
      expect(state.locale.value).toBe('zh');
    });
  });

  describe('data message handlers', () => {
    it('repositories updates repositories Map', async () => {
      const { state } = await createState();
      dispatchMessage({
        command: 'repositories',
        instanceId: 'inst-1',
        repositories: [fakeRepository],
      });
      await nextTick();

      expect(state.repositories.value.get('inst-1')).toEqual([fakeRepository]);
      expect(state.repositoriesCache.has('inst-1')).toBe(true);
    });

    it('repoDetail updates repoDetails Map', async () => {
      const { state } = await createState();
      dispatchMessage({
        command: 'repoDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        detail: fakeRepoDetail,
      });
      await nextTick();

      expect(state.repoDetails.value.get('inst-1:owner/repo')).toEqual(fakeRepoDetail);
    });

    it('issueDetail updates issueDetails Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'issueDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 1,
        detail: fakeIssueDetail,
      });
      await nextTick();

      const key = mod.issueDetailKey('inst-1', 'owner', 'repo', 1);
      expect(state.issueDetails.value.get(key)).toEqual(fakeIssueDetail);
    });

    it('pullRequestDetail updates pullRequestDetails Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'pullRequestDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        detail: fakePullRequestDetail,
      });
      await nextTick();

      const key = mod.pullRequestDetailKey('inst-1', 'owner', 'repo', 2);
      expect(state.pullRequestDetails.value.get(key)).toEqual(fakePullRequestDetail);
    });

    it('repoContents updates repoContents Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'repoContents',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        path: '',
        entries: [fakeContentEntry],
      });
      await nextTick();

      const key = mod.repoContentsKey('inst-1', 'owner', 'repo', 'main', '');
      expect(state.repoContents.value.get(key)).toEqual([fakeContentEntry]);
    });

    it('repoIssues updates repoIssues Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'repoIssues',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        state: 'open',
        issues: [fakeIssue],
      });
      await nextTick();

      const key = mod.repoIssuesKey('inst-1', 'owner', 'repo', 'open');
      expect(state.repoIssues.value.get(key)).toEqual([fakeIssue]);
    });

    it('repoPullRequests updates repoPullRequests Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'repoPullRequests',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        state: 'open',
        pullRequests: [fakePullRequest],
      });
      await nextTick();

      const key = mod.repoPullRequestsKey('inst-1', 'owner', 'repo', 'open');
      expect(state.repoPullRequests.value.get(key)).toEqual([fakePullRequest]);
    });

    it('actionRuns updates actionRuns Map and total count', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 1,
        actionRuns: [fakeActionRun],
        totalCount: 5,
      });
      await nextTick();

      const key = mod.actionRunsKey('inst-1', 'owner', 'repo', 1);
      expect(state.actionRuns.value.get(key)).toEqual([fakeActionRun]);
      expect(state.actionRunTotalCount.value.get('inst-1:owner/repo')).toBe(5);
    });

    it('notifications updates notifications Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'notifications',
        instanceId: 'inst-1',
        notifications: [fakeNotification],
      });
      await nextTick();

      const key = mod.notificationsKey('inst-1');
      expect(state.notifications.value.get(key)).toEqual([fakeNotification]);
    });

    it('repoRefs updates repoRefs Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'repoRefs',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        branches: [fakeBranch],
        tags: [fakeTag],
        releases: [fakeRelease],
      });
      await nextTick();

      const key = mod.repoRefsKey('inst-1', 'owner', 'repo');
      expect(state.repoRefs.value.get(key)).toEqual({
        branches: [fakeBranch],
        tags: [fakeTag],
        releases: [fakeRelease],
      });
    });

    it('repoBranchCommits updates repoBranchCommits Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'repoBranchCommits',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        branch: 'main',
        commits: [fakeCommit],
      });
      await nextTick();

      const key = mod.repoBranchCommitsKey('inst-1', 'owner', 'repo', 'main');
      expect(state.repoBranchCommits.value.get(key)).toEqual([fakeCommit]);
    });

    it('pullRequestFiles updates pullRequestFiles Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'pullRequestFiles',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        files: [fakeChangedFile],
      });
      await nextTick();

      const key = mod.pullRequestFilesKey('inst-1', 'owner', 'repo', 2);
      expect(state.pullRequestFiles.value.get(key)).toEqual([fakeChangedFile]);
    });

    it('pullRequestCommentsAndTimeline updates pullRequestComments Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'pullRequestCommentsAndTimeline',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        comments: [fakeTimelineComment],
      });
      await nextTick();

      const key = mod.pullRequestCommentsKey('inst-1', 'owner', 'repo', 2);
      expect(state.pullRequestComments.value.get(key)).toEqual([fakeTimelineComment]);
    });

    it('pullRequestCommits updates pullRequestCommits Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'pullRequestCommits',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        commits: [fakePullRequestCommit],
      });
      await nextTick();

      const key = mod.pullRequestCommitsKey('inst-1', 'owner', 'repo', 2);
      expect(state.pullRequestCommits.value.get(key)).toEqual([fakePullRequestCommit]);
    });

    it('fileHistory updates fileHistories Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'fileHistory',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        path: 'README.md',
        ref: 'main',
        commits: [fakeCommit],
      });
      await nextTick();

      const key = mod.fileHistoryKey('inst-1', 'owner', 'repo', 'README.md', 'main');
      expect(state.fileHistories.value.get(key)).toEqual([fakeCommit]);
    });

    it('globalSearchResult updates globalSearchResults Map', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'globalSearchResult',
        instanceId: 'inst-1',
        scope: 'repositories',
        query: 'repo',
        state: 'all',
        repositories: [fakeRepository],
      });
      await nextTick();

      const key = mod.globalSearchKey('inst-1', 'repositories', 'repo', 'all');
      expect(state.globalSearchResults.value.get(key)).toEqual({
        repositories: [fakeRepository],
        issues: [],
        pullRequests: [],
      });
    });
  });

  describe('error message handlers', () => {
    it('sets errors Map when repository loading fails', async () => {
      const { state } = await createState();
      dispatchMessage({
        command: 'repositories',
        instanceId: 'inst-1',
        error: 'Network error',
      });
      await nextTick();

      expect(state.errors.get('repos-inst-1')).toBe('Network error');
    });

    it('sets errors Map when repoDetail loading fails', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'repoDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        error: 'Not found',
      });
      await nextTick();

      const key = mod.repoDetailKey('inst-1', 'owner', 'repo');
      expect(state.errors.get(key)).toBe('Not found');
    });
  });

  describe('action methods', () => {
    it('loadRepositories sends getRepositories command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepositories('inst-1');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getRepositories',
          instanceId: 'inst-1',
        }),
      );
    });

    it('loadRepoDetail sends getRepoDetail command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepoDetail('inst-1', 'owner', 'repo');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getRepoDetail',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
        }),
      );
    });

    it('loadIssueDetail sends getIssueDetail command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadIssueDetail('inst-1', 'owner', 'repo', 1);

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getIssueDetail',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          index: 1,
        }),
      );
    });

    it('loadPullRequestDetail sends getPullRequestDetail command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadPullRequestDetail('inst-1', 'owner', 'repo', 2);

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getPullRequestDetail',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          index: 2,
        }),
      );
    });

    it('loadRepoContents sends getRepoContents command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepoContents('inst-1', 'owner', 'repo', 'src', 'main');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getRepoContents',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          path: 'src',
          ref: 'main',
        }),
      );
    });

    it('loadRepoIssues sends getRepoIssues command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepoIssues('inst-1', 'owner', 'repo', 'open');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getRepoIssues',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          state: 'open',
        }),
      );
    });

    it('loadRepoPullRequests sends getRepoPullRequests command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepoPullRequests('inst-1', 'owner', 'repo', 'open');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getRepoPullRequests',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          state: 'open',
        }),
      );
    });

    it('loadActionRuns sends getActionRuns command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadActionRuns('inst-1', 'owner', 'repo', 1);

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getActionRuns',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          page: 1,
          limit: 30,
        }),
      );
    });

    it('loadNotifications sends getNotifications command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadNotifications('inst-1');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getNotifications',
          instanceId: 'inst-1',
          statusTypes: ['unread', 'pinned'],
          limit: 50,
        }),
      );
    });

    it('loadRepoRefs sends getRepoRefs command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepoRefs('inst-1', 'owner', 'repo');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getRepoRefs',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
        }),
      );
    });

    it('markNotificationRead sends markNotificationRead command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.markNotificationRead('inst-1', 42);

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'markNotificationRead',
          instanceId: 'inst-1',
          id: 42,
        }),
      );
    });

    it('markAllNotificationsRead sends markAllNotificationsRead command', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.markAllNotificationsRead('inst-1');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'markAllNotificationsRead',
          instanceId: 'inst-1',
        }),
      );
    });
  });

  describe('caching behavior', () => {
    it('loadRepositories only sends one message while loading', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepositories('inst-1');
      state.loadRepositories('inst-1');
      state.loadRepositories('inst-1');

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getRepositories', instanceId: 'inst-1' }),
      );
    });

    it('loadRepositories uses cache on repeat calls', async () => {
      const { state } = await createState();
      state.repositoriesCache.set('inst-1', [fakeRepository]);
      vscodePostMessage().mockClear();
      state.loadRepositories('inst-1');

      expect(vscodePostMessage()).not.toHaveBeenCalled();
    });

    it('loadRepoContents uses cache on repeat calls', async () => {
      const { state, mod } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepoContents('inst-1', 'owner', 'repo', '', 'main');
      dispatchMessage({
        command: 'repoContents',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        path: '',
        entries: [fakeContentEntry],
      });
      await nextTick();
      vscodePostMessage().mockClear();

      state.loadRepoContents('inst-1', 'owner', 'repo', '', 'main');

      expect(vscodePostMessage()).not.toHaveBeenCalled();
      const key = mod.repoContentsKey('inst-1', 'owner', 'repo', 'main', '');
      expect(state.repoContents.value.get(key)).toEqual([fakeContentEntry]);
    });

    it('loadRepoRefs uses cache on repeat calls', async () => {
      const { state, mod } = await createState();
      vscodePostMessage().mockClear();
      state.loadRepoRefs('inst-1', 'owner', 'repo');
      dispatchMessage({
        command: 'repoRefs',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        branches: [fakeBranch],
        tags: [fakeTag],
        releases: [fakeRelease],
      });
      await nextTick();
      vscodePostMessage().mockClear();

      state.loadRepoRefs('inst-1', 'owner', 'repo');

      expect(vscodePostMessage()).not.toHaveBeenCalled();
      const key = mod.repoRefsKey('inst-1', 'owner', 'repo');
      expect(state.repoRefs.value.get(key)).toEqual({
        branches: [fakeBranch],
        tags: [fakeTag],
        releases: [fakeRelease],
      });
    });
  });

  describe('promise resolution', () => {
    it('showInputBox resolves when showInputBoxResult arrives', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      const promise = state.showInputBox({ prompt: 'Enter name', value: 'default' });

      const calls = vscodePostMessage().mock.calls;
      const id = (calls[calls.length - 1][0] as { id: string }).id;

      dispatchMessage({ command: 'showInputBoxResult', id, value: 'typed' });

      await expect(promise).resolves.toBe('typed');
    });

    it('showConfirm resolves when showConfirmResult arrives', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      const promise = state.showConfirm('Are you sure?');

      const calls = vscodePostMessage().mock.calls;
      const id = (calls[calls.length - 1][0] as { id: string }).id;

      dispatchMessage({ command: 'showConfirmResult', id, confirmed: true });

      await expect(promise).resolves.toBe(true);
    });
  });
});
