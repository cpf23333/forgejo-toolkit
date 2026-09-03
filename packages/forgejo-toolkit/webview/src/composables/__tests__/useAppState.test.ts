import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import { routes } from '../../router';
import type {
  ForgejoActionRun,
  ForgejoBranch,
  ForgejoChangedFile,
  ForgejoCommit,
  ForgejoContentEntry,
  ForgejoIssue,
  ForgejoIssueDetail,
  ForgejoLabel,
  ForgejoMilestone,
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
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, mod, router };
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

const fakeLabel: ForgejoLabel = { id: 1, name: 'bug', color: 'ee0701' };
const fakeMilestone: ForgejoMilestone = { id: 1, title: 'v1.0' };

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

    it('pullRequestReviewSubmitted force-reloads the detail when it is loaded', async () => {
      const { state } = await createState();
      dispatchMessage({
        command: 'pullRequestDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        detail: fakePullRequestDetail,
      });
      await nextTick();
      vscodePostMessage().mockClear();

      dispatchMessage({
        command: 'pullRequestReviewSubmitted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
      });

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getPullRequestDetail', instanceId: 'inst-1', index: 2 }),
      );
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getPullRequestCommentsAndTimeline', instanceId: 'inst-1', index: 2 }),
      );
    });

    it('pullRequestReviewSubmitted is ignored when the detail was never loaded', async () => {
      await createState();
      vscodePostMessage().mockClear();

      dispatchMessage({
        command: 'pullRequestReviewSubmitted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
      });

      expect(vscodePostMessage()).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getPullRequestDetail' }),
      );
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

  describe('navigation on deletion', () => {
    it('route names used by deletion handlers exist in the routes table', () => {
      const names = routes.map((route) => route.name);
      expect(names).toContain('repoDetail');
      expect(names).toContain('issueDetail');
      expect(names).toContain('actionRunDetail');
    });

    it('actionRunDeleted navigates to repoDetail when viewing the deleted run', async () => {
      const { router } = await createState();
      await router.push({
        name: 'actionRunDetail',
        params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', runId: 7 },
      });

      dispatchMessage({
        command: 'actionRunDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        runId: 7,
      });
      await flushPromises();

      expect(router.currentRoute.value.name).toBe('repoDetail');
      expect(router.currentRoute.value.params).toMatchObject({ instanceId: 'inst-1', owner: 'owner', repo: 'repo' });
    });

    it('actionRunDeleted does not navigate when the user has moved elsewhere', async () => {
      const { router } = await createState();
      await router.push({
        name: 'actionRunDetail',
        params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', runId: 7 },
      });
      await router.push({ name: 'dashboard' });

      dispatchMessage({
        command: 'actionRunDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        runId: 7,
      });
      await flushPromises();

      expect(router.currentRoute.value.name).toBe('dashboard');
    });

    it('issueDeleted navigates back when viewing the deleted issue', async () => {
      const { router } = await createState();
      await router.push({ name: 'repoIssues', params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo' } });
      await router.push({
        name: 'issueDetail',
        params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 1 },
      });

      dispatchMessage({
        command: 'issueDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 1,
      });
      await flushPromises();

      expect(router.currentRoute.value.name).toBe('repoIssues');
    });

    it('issueDeleted does not navigate when the user has moved elsewhere', async () => {
      const { router } = await createState();
      await router.push({
        name: 'issueDetail',
        params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 1 },
      });
      await router.push({ name: 'dashboard' });

      dispatchMessage({
        command: 'issueDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 1,
      });
      await flushPromises();

      expect(router.currentRoute.value.name).toBe('dashboard');
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

    it('renderMarkdown serves identical repeat input from cache', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      const promise = state.renderMarkdown('inst-1', '**bold**', 'owner/repo');

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'renderMarkdown', instanceId: 'inst-1', text: '**bold**' }),
      );
      const calls = vscodePostMessage().mock.calls;
      const _requestId = (calls[calls.length - 1][0] as { _requestId: string })._requestId;
      dispatchMessage({ command: 'renderedMarkdown', _requestId, html: '<p><strong>bold</strong></p>' });
      await expect(promise).resolves.toBe('<p><strong>bold</strong></p>');
      vscodePostMessage().mockClear();

      await expect(state.renderMarkdown('inst-1', '**bold**', 'owner/repo')).resolves.toBe(
        '<p><strong>bold</strong></p>',
      );
      expect(vscodePostMessage()).not.toHaveBeenCalled();
    });

    it('renderMarkdown refetches when text or context differs', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      const promise = state.renderMarkdown('inst-1', '**bold**', 'owner/repo');
      const calls = vscodePostMessage().mock.calls;
      const _requestId = (calls[calls.length - 1][0] as { _requestId: string })._requestId;
      dispatchMessage({ command: 'renderedMarkdown', _requestId, html: '<p><strong>bold</strong></p>' });
      await promise;
      vscodePostMessage().mockClear();

      void state.renderMarkdown('inst-1', '*italic*', 'owner/repo');
      void state.renderMarkdown('inst-1', '**bold**', 'other/repo');

      expect(vscodePostMessage()).toHaveBeenCalledTimes(2);
    });

    it('loadIssueDetail only sends one message while loading', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadIssueDetail('inst-1', 'owner', 'repo', 1);
      state.loadIssueDetail('inst-1', 'owner', 'repo', 1);
      state.loadIssueDetail('inst-1', 'owner', 'repo', 1, true);

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getIssueDetail', instanceId: 'inst-1', index: 1 }),
      );
    });

    it('loadPullRequestDetail only sends one message while loading', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadPullRequestDetail('inst-1', 'owner', 'repo', 2);
      state.loadPullRequestDetail('inst-1', 'owner', 'repo', 2);

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getPullRequestDetail', instanceId: 'inst-1', index: 2 }),
      );
    });

    it('loadActionRun only sends one message while loading', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();
      state.loadActionRun('inst-1', 'owner', 'repo', 7);
      state.loadActionRun('inst-1', 'owner', 'repo', 7);

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getActionRun', instanceId: 'inst-1', runId: 7 }),
      );
    });

    it('pullRequestFilesKey differs by diff range', async () => {
      const { mod } = await createState();
      const withoutShas = mod.pullRequestFilesKey('inst-1', 'owner', 'repo', 2);
      const withShas = mod.pullRequestFilesKey('inst-1', 'owner', 'repo', 2, 'base1', 'head1');

      expect(withShas).not.toBe(withoutShas);
      expect(mod.pullRequestFilesKey('inst-1', 'owner', 'repo', 2, 'base2', 'head1')).not.toBe(withShas);
      expect(mod.pullRequestFilesKey('inst-1', 'owner', 'repo', 2, 'base1', 'head2')).not.toBe(withShas);
      expect(mod.pullRequestFilesKey('inst-1', 'owner', 'repo', 2, 'base1', 'head1')).toBe(withShas);
    });

    it('loadPullRequestFiles dedups in-flight calls and caches per diff range', async () => {
      const { state, mod } = await createState();
      vscodePostMessage().mockClear();
      state.loadPullRequestFiles('inst-1', 'owner', 'repo', 2, 'base1', 'head1');
      state.loadPullRequestFiles('inst-1', 'owner', 'repo', 2, 'base1', 'head1');

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getPullRequestFiles',
          instanceId: 'inst-1',
          index: 2,
          baseSha: 'base1',
          headSha: 'head1',
        }),
      );

      dispatchMessage({
        command: 'pullRequestFiles',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        baseSha: 'base1',
        headSha: 'head1',
        files: [fakeChangedFile],
      });
      await nextTick();

      const key = mod.pullRequestFilesKey('inst-1', 'owner', 'repo', 2, 'base1', 'head1');
      expect(state.pullRequestFiles.value.get(key)).toEqual([fakeChangedFile]);
      vscodePostMessage().mockClear();

      state.loadPullRequestFiles('inst-1', 'owner', 'repo', 2, 'base1', 'head1');
      expect(vscodePostMessage()).not.toHaveBeenCalled();

      state.loadPullRequestFiles('inst-1', 'owner', 'repo', 2, 'base1', 'head2');
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
    });

    it('repo metadata loaders use cache on repeat calls and refetch after expiry', async () => {
      const { state, mod } = await createState();
      vscodePostMessage().mockClear();

      state.loadRepoLabels('inst-1', 'owner', 'repo');
      state.loadRepoAssignees('inst-1', 'owner', 'repo');
      state.loadRepoMilestones('inst-1', 'owner', 'repo');
      state.loadRepoDetail('inst-1', 'owner', 'repo');
      expect(vscodePostMessage()).toHaveBeenCalledTimes(4);

      dispatchMessage({
        command: 'repoLabels',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        labels: [fakeLabel],
      });
      dispatchMessage({
        command: 'repoAssignees',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        assignees: ['user'],
      });
      dispatchMessage({
        command: 'repoMilestones',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        milestones: [fakeMilestone],
      });
      dispatchMessage({
        command: 'repoDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        detail: fakeRepoDetail,
      });
      await nextTick();

      const labelsKey = mod.repoLabelsKey('inst-1', 'owner', 'repo');
      const assigneesKey = mod.repoAssigneesKey('inst-1', 'owner', 'repo');
      const milestonesKey = mod.repoMilestonesKey('inst-1', 'owner', 'repo');
      const detailKey = mod.repoDetailKey('inst-1', 'owner', 'repo');
      expect(state.repoLabels.value.get(labelsKey)).toEqual([fakeLabel]);
      expect(state.repoAssignees.value.get(assigneesKey)).toEqual(['user']);
      expect(state.repoMilestones.value.get(milestonesKey)).toEqual([fakeMilestone]);
      expect(state.repoLabelsCache.has(labelsKey)).toBe(true);
      expect(state.repoAssigneesCache.has(assigneesKey)).toBe(true);
      expect(state.repoMilestonesCache.has(milestonesKey)).toBe(true);
      expect(state.repoDetailsCache.has(detailKey)).toBe(true);
      vscodePostMessage().mockClear();

      state.loadRepoLabels('inst-1', 'owner', 'repo');
      state.loadRepoAssignees('inst-1', 'owner', 'repo');
      state.loadRepoMilestones('inst-1', 'owner', 'repo');
      state.loadRepoDetail('inst-1', 'owner', 'repo');
      expect(vscodePostMessage()).not.toHaveBeenCalled();

      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(60_001);

        state.loadRepoLabels('inst-1', 'owner', 'repo');
        state.loadRepoAssignees('inst-1', 'owner', 'repo');
        state.loadRepoMilestones('inst-1', 'owner', 'repo');
        state.loadRepoDetail('inst-1', 'owner', 'repo');

        expect(vscodePostMessage()).toHaveBeenCalledTimes(4);
        expect(vscodePostMessage()).toHaveBeenCalledWith(
          expect.objectContaining({ command: 'getRepoLabels', instanceId: 'inst-1' }),
        );
        expect(vscodePostMessage()).toHaveBeenCalledWith(
          expect.objectContaining({ command: 'getRepoAssignees', instanceId: 'inst-1' }),
        );
        expect(vscodePostMessage()).toHaveBeenCalledWith(
          expect.objectContaining({ command: 'getRepoMilestones', instanceId: 'inst-1' }),
        );
        expect(vscodePostMessage()).toHaveBeenCalledWith(
          expect.objectContaining({ command: 'getRepoDetail', instanceId: 'inst-1' }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('loadRepoLabels with force refetches despite a fresh cache', async () => {
      const { state } = await createState();
      dispatchMessage({
        command: 'repoLabels',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        labels: [fakeLabel],
      });
      await nextTick();
      vscodePostMessage().mockClear();

      state.loadRepoLabels('inst-1', 'owner', 'repo');
      expect(vscodePostMessage()).not.toHaveBeenCalled();

      state.loadRepoLabels('inst-1', 'owner', 'repo', true);
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getRepoLabels', instanceId: 'inst-1', owner: 'owner', repo: 'repo' }),
      );
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

  describe('actionRunDeleted cleanup', () => {
    it('evicts the run job logs together with details, jobs and artifacts', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'actionRunJobs',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        runId: 7,
        jobs: [
          { id: 101, name: 'build', status: 'success' },
          { id: 102, name: 'test', status: 'failure' },
        ],
      });
      dispatchMessage({
        command: 'actionJobLog',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        jobId: 101,
        log: 'build log',
      });
      dispatchMessage({
        command: 'actionJobLog',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        jobId: 102,
        log: 'test log',
      });
      // A log for another run's job in the same repo must survive.
      dispatchMessage({
        command: 'actionJobLog',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        jobId: 999,
        log: 'other log',
      });
      await nextTick();

      dispatchMessage({ command: 'actionRunDeleted', instanceId: 'inst-1', owner: 'owner', repo: 'repo', runId: 7 });
      await nextTick();

      expect(state.actionJobLogs.value.get(mod.actionJobLogKey('inst-1', 'owner', 'repo', 101))).toBeUndefined();
      expect(state.actionJobLogs.value.get(mod.actionJobLogKey('inst-1', 'owner', 'repo', 102))).toBeUndefined();
      expect(state.actionJobLogs.value.get(mod.actionJobLogKey('inst-1', 'owner', 'repo', 999))).toBe('other log');
      expect(state.actionRunJobs.value.get(mod.actionRunJobsKey('inst-1', 'owner', 'repo', 7))).toBeUndefined();
    });
  });

  describe('single-slot request guards', () => {
    it('testConnection drops a superseded response and resends the latest intent', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.testConnection('https://a.example.com', 'token-a');
      state.testConnection('https://b.example.com', 'token-b');

      // Only the first request is in flight; the second is recorded as intent.
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'testConnection', url: 'https://a.example.com' }),
      );

      // The response to the superseded first request is dropped, and the
      // latest intent is sent instead.
      dispatchMessage({ command: 'testConnectionResult', success: true, username: 'user-a' });
      await nextTick();

      expect(state.testConnectionResult.value).toBeUndefined();
      expect(vscodePostMessage()).toHaveBeenCalledTimes(2);
      expect(vscodePostMessage()).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: 'testConnection', url: 'https://b.example.com', token: 'token-b' }),
      );

      // The response to the latest request lands normally.
      dispatchMessage({ command: 'testConnectionResult', success: true, username: 'user-b' });
      await nextTick();

      expect(state.testConnectionResult.value).toMatchObject({ success: true, username: 'user-b' });
    });

    it('testConnection applies the response when no newer request was issued', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.testConnection('https://a.example.com', 'token-a');
      dispatchMessage({ command: 'testConnectionResult', success: false, error: 'boom' });
      await nextTick();

      expect(state.testConnectionResult.value).toMatchObject({ success: false, error: 'boom' });
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
    });

    it('saveInstance/editInstance share one guarded slot', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.saveInstance('https://a.example.com', 'token-a');
      state.editInstance('inst-1', 'https://b.example.com', 'token-b');

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'saveInstance', url: 'https://a.example.com' }),
      );

      dispatchMessage({ command: 'saveInstanceResult', success: true });
      await nextTick();

      expect(state.saveInstanceResult.value).toBeUndefined();
      expect(vscodePostMessage()).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: 'editInstance', id: 'inst-1', url: 'https://b.example.com' }),
      );

      dispatchMessage({ command: 'saveInstanceResult', success: true });
      await nextTick();

      expect(state.saveInstanceResult.value).toMatchObject({ success: true });
    });

    it('previewImportInstances replays the latest intent after a superseded response', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.previewImportInstances();
      state.previewImportInstances();
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);

      dispatchMessage({ command: 'importInstancesPreview', instances: [], existingIds: [] });
      await nextTick();

      expect(state.importPreview.value).toBeUndefined();
      expect(vscodePostMessage()).toHaveBeenCalledTimes(2);
      expect(vscodePostMessage()).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: 'previewImportInstances' }),
      );

      dispatchMessage({
        command: 'importInstancesPreview',
        instances: [{ id: 'inst-2', url: 'https://forgejo.example.com', token: 't' }],
        existingIds: [],
      });
      await nextTick();

      expect(state.importPreview.value?.instances).toHaveLength(1);
    });
  });

  describe('loadNotifications intent replay', () => {
    it('re-issues the request with the latest filters after an in-flight response lands', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.loadNotifications('inst-1', ['unread', 'pinned']);
      state.loadNotifications('inst-1', ['unread', 'pinned'], ['issue']);

      // The second call while in flight only records the intent.
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);

      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();

      expect(vscodePostMessage()).toHaveBeenCalledTimes(2);
      expect(vscodePostMessage()).toHaveBeenLastCalledWith(
        expect.objectContaining({
          command: 'getNotifications',
          instanceId: 'inst-1',
          statusTypes: ['unread', 'pinned'],
          subjectType: ['issue'],
        }),
      );
    });

    it('does not re-issue when the filters did not change while in flight', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.loadNotifications('inst-1', ['unread', 'pinned'], ['issue']);
      state.loadNotifications('inst-1', ['unread', 'pinned'], ['issue']);
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);

      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [] });
      await nextTick();

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
    });
  });

  describe('bounded state maps', () => {
    it('globalSearchResults evicts the oldest entry beyond 50 entries', async () => {
      const { state, mod } = await createState();

      for (let i = 0; i < 55; i += 1) {
        dispatchMessage({
          command: 'globalSearchResult',
          instanceId: 'inst-1',
          scope: 'repositories',
          query: `query-${i}`,
          state: 'all',
          repositories: [],
        });
      }
      await nextTick();

      expect(state.globalSearchResults.value.size).toBe(50);
      expect(state.globalSearchResults.value.has(mod.globalSearchKey('inst-1', 'repositories', 'query-0', 'all'))).toBe(
        false,
      );
      expect(
        state.globalSearchResults.value.has(mod.globalSearchKey('inst-1', 'repositories', 'query-54', 'all')),
      ).toBe(true);
    });

    it('repoFileSearchResults evicts the oldest entry beyond 50 entries', async () => {
      const { state, mod } = await createState();

      for (let i = 0; i < 52; i += 1) {
        dispatchMessage({
          command: 'repoFilesSearchResult',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          ref: 'main',
          query: `q-${i}`,
          files: [],
        });
      }
      await nextTick();

      expect(state.repoFileSearchResults.value.size).toBe(50);
      expect(
        state.repoFileSearchResults.value.has(mod.repoFileSearchKey('inst-1', 'owner', 'repo', 'main', 'q-0')),
      ).toBe(false);
    });

    it('errors evicts the oldest entry beyond 500 entries', async () => {
      const { state, mod } = await createState();

      for (let i = 0; i < 505; i += 1) {
        dispatchMessage({
          command: 'repoDetail',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: `repo-${i}`,
          error: `error-${i}`,
        });
      }
      await nextTick();

      expect(state.errors.size).toBe(500);
      expect(state.errors.has(mod.repoDetailKey('inst-1', 'owner', 'repo-0'))).toBe(false);
      expect(state.errors.get(mod.repoDetailKey('inst-1', 'owner', 'repo-504'))).toBe('error-504');
    });
  });

  describe('loader error clearing', () => {
    it('starting a load clears a stale error for the same key', async () => {
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

      state.loadRepoDetail('inst-1', 'owner', 'repo', true);
      expect(state.errors.get(key)).toBeUndefined();
      expect(state.loading.get(key)).toBe(true);
    });

    it('loadIssueDetail clears a stale error on reload', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'issueDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 1,
        error: 'boom',
      });
      await nextTick();

      const key = mod.issueDetailKey('inst-1', 'owner', 'repo', 1);
      expect(state.errors.get(key)).toBe('boom');

      state.loadIssueDetail('inst-1', 'owner', 'repo', 1, true);
      expect(state.errors.get(key)).toBeUndefined();
    });
  });

  describe('my issues/pull requests state-scoped keys', () => {
    it('loadMyIssues keys loading and cache by state', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.loadMyIssues('inst-1', 'closed');
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getMyIssues', instanceId: 'inst-1', state: 'closed' }),
      );
      expect(state.loading.get('issues-inst-1-closed')).toBe(true);

      dispatchMessage({ command: 'myIssues', instanceId: 'inst-1', issues: [fakeIssue] });
      await nextTick();

      expect(state.loading.get('issues-inst-1-closed')).toBe(false);
      expect(state.myIssuesCache.has('inst-1:closed')).toBe(true);
      expect(state.myIssues.value.get('inst-1')).toEqual([fakeIssue]);

      // Cached state does not refetch.
      vscodePostMessage().mockClear();
      state.loadMyIssues('inst-1', 'closed');
      expect(vscodePostMessage()).not.toHaveBeenCalled();
    });

    it('loadMyPullRequests keys loading and cache by state', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.loadMyPullRequests('inst-1', 'open');
      expect(state.loading.get('pulls-inst-1-open')).toBe(true);

      dispatchMessage({ command: 'myPullRequests', instanceId: 'inst-1', pullRequests: [fakePullRequest] });
      await nextTick();

      expect(state.loading.get('pulls-inst-1-open')).toBe(false);
      expect(state.myPullRequestsCache.has('inst-1:open')).toBe(true);
    });
  });
});

describe('pending request timeout and host fallback', () => {
  function lastCreateIssueRequestId(): string {
    const call = vscodePostMessage()
      .mock.calls.map(([message]) => message as { command: string; _requestId?: string })
      .filter((message) => message.command === 'createIssue')
      .pop();
    expect(call?._requestId).toBeTruthy();
    return call?._requestId as string;
  }

  it('rejects a pending creation after the request timeout and clears its loading state', async () => {
    const { state, mod } = await createState();
    vi.useFakeTimers();
    try {
      const key = mod.issueFormKey('inst-1', 'owner', 'repo', 0);
      const promise = state.createIssue('inst-1', 'owner', 'repo', { title: 'hello', body: '' });
      expect(state.loading.get(key)).toBe(true);

      const assertion = expect(promise).rejects.toThrow(/timed out|超时/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      expect(state.loading.get(key)).toBe(false);
      expect(state.errors.get(key)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reject after a normal response even when the timeout elapses later', async () => {
    const { state } = await createState();
    vi.useFakeTimers();
    try {
      const promise = state.createIssue('inst-1', 'owner', 'repo', { title: 'hello', body: '' });
      const requestId = lastCreateIssueRequestId();
      dispatchMessage({
        command: 'issueCreated',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 1,
        item: fakeIssue,
        _requestId: requestId,
      });
      await expect(promise).resolves.toEqual(fakeIssue);
      // The timer must have been cleared: advancing past the timeout is a no-op.
      await vi.advanceTimersByTimeAsync(120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects the pending promise when the host sends a requestError fallback', async () => {
    const { state, mod } = await createState();
    const key = mod.issueFormKey('inst-1', 'owner', 'repo', 0);
    const promise = state.createIssue('inst-1', 'owner', 'repo', { title: 'hello', body: '' });
    expect(state.loading.get(key)).toBe(true);

    const requestId = lastCreateIssueRequestId();
    dispatchMessage({ command: 'requestError', _requestId: requestId, error: 'handler bailed out' });

    await expect(promise).rejects.toThrow('handler bailed out');
    expect(state.loading.get(key)).toBe(false);
    expect(state.errors.get(key)).toBe('handler bailed out');
  });

  it('ignores requestError messages for unknown request ids', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'requestError', _requestId: 'no-such-request', error: 'boom' });
    // No pending promise exists; nothing rejects, nothing throws.
    await nextTick();
    expect(state.errors.size).toBe(0);
  });
});

describe('single-slot request/response pairs', () => {
  it('testConnection forwards the editing instance id so the host can fall back to the stored token', async () => {
    const { state } = await createState();
    vscodePostMessage().mockClear();

    state.testConnection('https://forgejo.example.com', '', 'inst-1');

    expect(vscodePostMessage()).toHaveBeenCalledWith({
      command: 'testConnection',
      url: 'https://forgejo.example.com',
      token: '',
      instanceId: 'inst-1',
    });
  });

  it('frees the testConnection slot with a timeout error when the host never answers', async () => {
    const { state } = await createState();
    vscodePostMessage().mockClear();
    vi.useFakeTimers();
    try {
      state.testConnection('https://forgejo.example.com', 'tok');
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.testConnectionResult.value?.success).toBe(false);
      expect(state.testConnectionResult.value?.error).toBeTruthy();

      // The slot is free again: the next attempt is sent, not dropped.
      state.testConnection('https://forgejo.example.com', 'tok2');
      expect(vscodePostMessage()).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees the saveInstance slot with a timeout error when the host never answers', async () => {
    const { state } = await createState();
    vscodePostMessage().mockClear();
    vi.useFakeTimers();
    try {
      state.saveInstance('https://forgejo.example.com', 'tok');
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.saveInstanceResult.value?.success).toBe(false);
      expect(state.saveInstanceResult.value?.error).toBeTruthy();

      state.saveInstance('https://forgejo.example.com', 'tok2');
      expect(vscodePostMessage()).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a normal testConnection response clears the pending timeout', async () => {
    const { state } = await createState();
    vscodePostMessage().mockClear();
    vi.useFakeTimers();
    try {
      state.testConnection('https://forgejo.example.com', 'tok');
      dispatchMessage({ command: 'testConnectionResult', success: true, username: 'user' });
      expect(state.testConnectionResult.value).toMatchObject({ success: true, username: 'user' });
      // The timer must have been cleared: advancing past the timeout must not
      // overwrite the real result.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(state.testConnectionResult.value).toMatchObject({ success: true, username: 'user' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancelled import preview frees the slot without navigating to the preview', async () => {
    const { state } = await createState();
    vscodePostMessage().mockClear();

    state.previewImportInstances();
    expect(vscodePostMessage()).toHaveBeenCalledTimes(1);

    dispatchMessage({ command: 'importInstancesPreview', instances: [], existingIds: [], cancelled: true });
    await nextTick();
    expect(state.importPreview.value).toBeUndefined();

    // The slot is free again: the next import attempt is sent, not dropped.
    vscodePostMessage().mockClear();
    state.previewImportInstances();
    expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
  });
});

describe('worktreeError message', () => {
  it('records the error and operation for views to display', async () => {
    const { state } = await createState();

    dispatchMessage({
      command: 'worktreeError',
      error: 'fatal: removal failed',
      operation: 'remove',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 2,
    });
    await nextTick();

    expect(state.lastWorktreeError.value).toMatchObject({
      error: 'fatal: removal failed',
      operation: 'remove',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 2,
    });
  });
});
