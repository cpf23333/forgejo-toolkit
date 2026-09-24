import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { LIST_ITEM_LIMIT } from '@cpf23333-forgejo-toolkit/shared/limits';
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

    it('pullRequestDetail carries a failed attachment lookup onto the stored detail', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'pullRequestDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        // The host's own field, sitting beside `detail` rather than inside it.
        detail: { ...fakePullRequestDetail, assets: [] },
        attachmentsUnavailable: true,
      });
      await nextTick();

      const key = mod.pullRequestDetailKey('inst-1', 'owner', 'repo', 2);
      const stored = state.pullRequestDetails.value.get(key);
      // Without this the empty `assets` list reads as "this PR has no
      // attachments", which is the false conclusion the flag exists to prevent.
      expect(stored?.attachmentsUnavailable).toBe(true);

      // A later reply without the flag is a real answer and must clear it.
      dispatchMessage({
        command: 'pullRequestDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        detail: { ...fakePullRequestDetail, assets: [] },
      });
      await nextTick();
      expect(state.pullRequestDetails.value.get(key)?.attachmentsUnavailable).toBeUndefined();
    });

    it('pullRequestReviewSubmitted force-reloads the detail when it is loaded', async () => {
      await createState();
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

      const key = mod.actionRunsKey('inst-1', 'owner', 'repo');
      expect(state.actionRuns.value.get(key)).toEqual([fakeActionRun]);
      expect(state.actionRunTotalCount.value.get('inst-1:owner/repo')).toBe(5);
    });

    it('actionRuns appends later pages to the repo list instead of replacing it', async () => {
      const { state, mod } = await createState();
      const key = mod.actionRunsKey('inst-1', 'owner', 'repo');

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 1,
        actionRuns: [fakeActionRun],
        totalCount: 2,
      });
      await nextTick();

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 2,
        actionRuns: [{ ...fakeActionRun, id: 2, title: 'Test' }],
        totalCount: 2,
      });
      await nextTick();

      // Server order is preserved: page 1 first, then page 2.
      expect(state.actionRuns.value.get(key)).toEqual([fakeActionRun, { ...fakeActionRun, id: 2, title: 'Test' }]);
    });

    it('actionRuns keeps the loaded runs when a page past the end comes back empty', async () => {
      const { state, mod } = await createState();
      const key = mod.actionRunsKey('inst-1', 'owner', 'repo');

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 1,
        actionRuns: [fakeActionRun],
        totalCount: 1,
      });
      await nextTick();

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 2,
        actionRuns: [],
        totalCount: 1,
      });
      await nextTick();

      expect(state.actionRuns.value.get(key)).toEqual([fakeActionRun]);
      expect(state.actionRunsHasMore.value.get(key)).toBe(false);
    });

    it('actionRuns trusts the server total instead of treating a short page as the end', async () => {
      const { state, mod } = await createState();
      const key = mod.actionRunsKey('inst-1', 'owner', 'repo');
      const limit = mod.ACTION_RUNS_PAGE_LIMIT;
      const fullPage = Array.from({ length: limit }, (_, index) => ({
        ...fakeActionRun,
        id: index + 1,
      }));

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 1,
        actionRuns: fullPage,
        totalCount: limit + 2,
      });
      await nextTick();

      expect(state.actionRuns.value.get(key)).toHaveLength(limit);
      expect(state.actionRunsHasMore.value.get(key)).toBe(true);
      expect(state.actionRunsPage.value.get(key)).toBe(1);

      // A short page is not proof of the end: a server that clamps the page
      // size (`[api] MaxResponseItems`) returns short pages while its total
      // still reports more runs, so "Load more" must stay available.
      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 2,
        actionRuns: [{ ...fakeActionRun, id: 99 }],
        totalCount: limit + 2,
      });
      await nextTick();

      expect(state.actionRuns.value.get(key)).toHaveLength(limit + 1);
      expect(state.actionRunsPage.value.get(key)).toBe(2);
      expect(state.actionRunsHasMore.value.get(key)).toBe(true);

      // An empty page ends the list even though the total disagrees, and the
      // rows already loaded stay on screen.
      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 3,
        actionRuns: [],
        totalCount: limit + 2,
      });
      await nextTick();

      expect(state.actionRuns.value.get(key)).toHaveLength(limit + 1);
      expect(state.actionRunsHasMore.value.get(key)).toBe(false);
    });

    it('actionRuns ignores a page that does not follow the loaded ones', async () => {
      const { state, mod } = await createState();
      const key = mod.actionRunsKey('inst-1', 'owner', 'repo');
      const limit = mod.ACTION_RUNS_PAGE_LIMIT;
      const fullPage = Array.from({ length: limit }, (_, index) => ({ ...fakeActionRun, id: index + 1 }));

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 1,
        actionRuns: fullPage,
        totalCount: limit * 3,
      });
      await nextTick();

      // A late page-3 reply while page 2 is still missing must not append, or
      // page 2 would be skipped in the list.
      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 3,
        actionRuns: Array.from({ length: limit }, (_, index) => ({ ...fakeActionRun, id: limit * 2 + index + 1 })),
        totalCount: limit * 3,
      });
      await nextTick();

      expect(state.actionRuns.value.get(key)).toHaveLength(limit);
      expect(state.actionRunsPage.value.get(key)).toBe(1);
      expect(state.actionRunsHasMore.value.get(key)).toBe(true);
    });

    it('actionRuns keeps the total of a page that does not report one', async () => {
      const { state, mod } = await createState();
      const key = mod.actionRunsKey('inst-1', 'owner', 'repo');
      const totalKey = 'inst-1:owner/repo';

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
      expect(state.actionRunTotalCount.value.get(totalKey)).toBe(5);

      // A host build that omits the total on later pages must not shrink it to
      // the size of that page.
      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 2,
        actionRuns: [{ ...fakeActionRun, id: 2 }],
      });
      await nextTick();

      expect(state.actionRunTotalCount.value.get(totalKey)).toBe(5);
      expect(state.actionRuns.value.get(key)).toHaveLength(2);
    });

    it('actionRuns starts the list over on a page-1 refresh', async () => {
      const { state, mod } = await createState();
      const key = mod.actionRunsKey('inst-1', 'owner', 'repo');

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 1,
        actionRuns: [fakeActionRun],
        totalCount: 2,
      });
      await nextTick();
      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 2,
        actionRuns: [{ ...fakeActionRun, id: 2 }],
        totalCount: 2,
      });
      await nextTick();
      expect(state.actionRuns.value.get(key)).toHaveLength(2);

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 1,
        actionRuns: [{ ...fakeActionRun, id: 3 }],
        totalCount: 1,
      });
      await nextTick();

      expect(state.actionRuns.value.get(key)).toEqual([{ ...fakeActionRun, id: 3 }]);
    });

    it('actionRuns keeps repos apart so switching repos never mixes lists', async () => {
      const { state, mod } = await createState();

      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        page: 1,
        actionRuns: [fakeActionRun],
        totalCount: 1,
      });
      dispatchMessage({
        command: 'actionRuns',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'other',
        page: 1,
        actionRuns: [{ ...fakeActionRun, id: 7 }],
        totalCount: 1,
      });
      await nextTick();

      expect(state.actionRuns.value.get(mod.actionRunsKey('inst-1', 'owner', 'repo'))).toEqual([fakeActionRun]);
      expect(state.actionRuns.value.get(mod.actionRunsKey('inst-1', 'owner', 'other'))).toEqual([
        { ...fakeActionRun, id: 7 },
      ]);
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

    it('pullRequestCommentsAndTimeline keeps the per-comment attachment lookup failure', async () => {
      const { state, mod } = await createState();
      dispatchMessage({
        command: 'pullRequestCommentsAndTimeline',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        comments: [
          // The host's per-comment flag, on a comment whose list came back empty.
          { ...fakeTimelineComment, assets: [], attachmentsUnavailable: true },
          { ...fakeTimelineComment, id: 2, assets: [] },
        ],
      });
      await nextTick();

      const key = mod.pullRequestCommentsKey('inst-1', 'owner', 'repo', 2);
      const stored = state.pullRequestComments.value.get(key) ?? [];
      // Without the flag the two comments are indistinguishable (both have an
      // empty `assets` list), and the failed one reads as "no attachments".
      expect(stored[0]?.attachmentsUnavailable).toBe(true);
      expect(stored[1]?.attachmentsUnavailable).toBeUndefined();
    });

    it('an edit reply keeps the attachment lookup failure of the row it replaces', async () => {
      const { state, mod } = await createState();
      const key = mod.pullRequestCommentsKey('inst-1', 'owner', 'repo', 2);
      const commentId = fakeTimelineComment.id as number;
      dispatchMessage({
        command: 'pullRequestCommentsAndTimeline',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 2,
        comments: [{ ...fakeTimelineComment, assets: [], attachmentsUnavailable: true }],
      });
      await nextTick();

      // The host's edit reply carries the new body and no attachment listing.
      dispatchMessage({
        command: 'issueCommentEdited',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        commentId,
        comment: { ...fakeTimelineComment, body: 'edited' },
      });
      await nextTick();

      const stored = state.pullRequestComments.value.get(key) ?? [];
      // The row is rebuilt from the reply: unless the failure marker is carried
      // over with the assets, an empty list silently becomes "no attachments".
      expect(stored[0]?.body).toBe('edited');
      expect(stored[0]?.attachmentsUnavailable).toBe(true);
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

  describe('linkedRepository message', () => {
    const repoA = {
      instanceId: 'inst-1',
      owner: 'alice',
      repo: 'repo-a',
      localPath: '/ws/a',
      remoteUrl: 'https://forgejo.example.com/alice/repo-a.git',
    };
    const repoB = {
      instanceId: 'inst-1',
      owner: 'alice',
      repo: 'repo-b',
      localPath: '/ws/b',
      remoteUrl: 'https://forgejo.example.com/alice/repo-b.git',
    };

    it('stores the full list and the host-attributed repository', async () => {
      const { state } = await createState();
      dispatchMessage({ command: 'linkedRepository', linked: repoA, all: [repoA, repoB] });
      await nextTick();

      expect(state.linkedRepository.value).toEqual(repoA);
      expect(state.linkedRepositories.value).toHaveLength(2);
      expect(state.activeLinkedRepository.value).toEqual(repoA);
    });

    it('manual selection overrides the active repository', async () => {
      const { state } = await createState();
      dispatchMessage({ command: 'linkedRepository', linked: repoA, all: [repoA, repoB] });
      await nextTick();

      state.selectLinkedRepository('/ws/b');

      expect(state.activeLinkedRepository.value).toEqual(repoB);
    });

    it('falls back to host attribution when the selected repository disappears', async () => {
      const { state } = await createState();
      dispatchMessage({ command: 'linkedRepository', linked: repoA, all: [repoA, repoB] });
      await nextTick();
      state.selectLinkedRepository('/ws/b');

      dispatchMessage({ command: 'linkedRepository', linked: repoA, all: [repoA] });
      await nextTick();

      expect(state.activeLinkedRepository.value).toEqual(repoA);
    });

    it('derives the list from the attributed repository when all is absent', async () => {
      const { state } = await createState();
      dispatchMessage({ command: 'linkedRepository', linked: repoA });
      await nextTick();

      expect(state.linkedRepositories.value).toEqual([repoA]);
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
      // The handler does not await its router.push, and the repoDetail view is
      // lazy-loaded: the navigation only settles once the dynamic import has
      // resolved. That import is slow and bursty (the first run also has to
      // transform the view and its transitive imports), so poll generously
      // rather than assuming a previous test already paid for the chunk.
      await vi.waitFor(
        () => {
          expect(router.currentRoute.value.name).toBe('repoDetail');
        },
        { timeout: 10_000, interval: 20 },
      );

      expect(router.currentRoute.value.params).toMatchObject({ instanceId: 'inst-1', owner: 'owner', repo: 'repo' });
    }, 15_000);

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

    it('loadRepoIssues serves the cached list until the TTL expires, then refetches', async () => {
      const { state } = await createState();
      vi.useFakeTimers();
      try {
        state.loadRepoIssues('inst-1', 'owner', 'repo', 'open');
        dispatchMessage({
          command: 'repoIssues',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          state: 'open',
          issues: [fakeIssue],
        });
        await nextTick();

        // Fresh cache: no refetch.
        vscodePostMessage().mockClear();
        state.loadRepoIssues('inst-1', 'owner', 'repo', 'open');
        expect(vscodePostMessage()).not.toHaveBeenCalled();

        // After the TTL the stale list stays visible but a refetch fires.
        await vi.advanceTimersByTimeAsync(31_000);
        state.loadRepoIssues('inst-1', 'owner', 'repo', 'open');
        expect(vscodePostMessage()).toHaveBeenCalledWith(
          expect.objectContaining({ command: 'getRepoIssues', instanceId: 'inst-1' }),
        );
        expect(state.repoIssues.value.get('inst-1:owner/repo:issues:open')).toEqual([fakeIssue]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('loadRepoPullRequests serves the cached list until the TTL expires, then refetches', async () => {
      const { state } = await createState();
      vi.useFakeTimers();
      try {
        state.loadRepoPullRequests('inst-1', 'owner', 'repo', 'open');
        dispatchMessage({
          command: 'repoPullRequests',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          state: 'open',
          pullRequests: [fakePullRequest],
        });
        await nextTick();

        vscodePostMessage().mockClear();
        state.loadRepoPullRequests('inst-1', 'owner', 'repo', 'open');
        expect(vscodePostMessage()).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(31_000);
        state.loadRepoPullRequests('inst-1', 'owner', 'repo', 'open');
        expect(vscodePostMessage()).toHaveBeenCalledWith(
          expect.objectContaining({ command: 'getRepoPullRequests', instanceId: 'inst-1' }),
        );
        expect(state.repoPullRequests.value.get('inst-1:owner/repo:pulls:open')).toEqual([fakePullRequest]);
      } finally {
        vi.useRealTimers();
      }
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

    it('refreshData clears the instance caches and force-reloads the dashboard lists', async () => {
      const { state } = await createState();
      dispatchMessage({
        command: 'instances',
        data: [
          { id: 'inst-1', url: 'https://forgejo.example.com', name: 'user@forgejo.example.com', username: 'user' },
        ],
      });
      state.repositoriesCache.set('inst-1', [fakeRepository]);
      state.myIssuesCache.set('inst-1:open', []);
      state.myPullRequestsCache.set('inst-1:open', []);
      vscodePostMessage().mockClear();

      dispatchMessage({ command: 'refreshData' });

      expect(state.repositoriesCache.has('inst-1')).toBe(false);
      expect(state.myIssuesCache.has('inst-1:open')).toBe(false);
      expect(state.myPullRequestsCache.has('inst-1:open')).toBe(false);
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getRepositories', instanceId: 'inst-1' }),
      );
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getMyIssues', instanceId: 'inst-1', state: 'open' }),
      );
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getMyPullRequests', instanceId: 'inst-1', state: 'open' }),
      );
    });

    it('refreshData drops the repository-scoped caches and reloads their lists', async () => {
      const { state } = await createState();
      // The state is shared with the tests before this one, so the reply below
      // is what puts this test's own entry into the repository contents cache
      // (and clears any busy flag an earlier test left on the same slot).
      dispatchMessage({
        command: 'repoContents',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        path: '',
        entries: [fakeContentEntry],
      });
      dispatchMessage({
        command: 'repoIssues',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        state: 'open',
        issues: [fakeIssue],
      });
      await nextTick();

      // The contents are served from the cache before the refresh: the combined
      // load posts nothing when the entry it holds is still live.
      vscodePostMessage().mockClear();
      state.loadRepoContents('inst-1', 'owner', 'repo', '', 'main');
      expect(vscodePostMessage()).not.toHaveBeenCalled();

      dispatchMessage({
        command: 'instances',
        data: [
          { id: 'inst-1', url: 'https://forgejo.example.com', name: 'user@forgejo.example.com', username: 'user' },
        ],
      });
      await nextTick();
      vscodePostMessage().mockClear();

      dispatchMessage({ command: 'refreshData' });
      await nextTick();

      // The TTL caches no longer answer, so the loads go back to the host
      // instead of serving data that is up to a minute old. The contents call
      // is the combined load, so its post is what proves the cache is gone; the
      // issue list needs no call of its own — the refresh re-issues the held
      // list itself (see the replay test below).
      state.loadRepoContents('inst-1', 'owner', 'repo', '', 'main');

      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'getRepoContents',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          ref: 'main',
          path: '',
        }),
      );
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

    it('refreshData re-issues the held repository issue/PR list requests itself', async () => {
      const { state } = await createState();
      dispatchMessage({
        command: 'instances',
        data: [
          { id: 'inst-1', url: 'https://forgejo.example.com', name: 'user@forgejo.example.com', username: 'user' },
        ],
      });
      await nextTick();
      // Two repositories, each held on a different filter: the replay has to
      // carry the state (and the search query) of the list that is on screen,
      // not a fixed 'open' the view may never have asked for.
      dispatchMessage({
        command: 'repoIssues',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'alpha',
        state: 'closed',
        issues: [fakeIssue],
      });
      dispatchMessage({
        command: 'repoIssues',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'beta',
        state: 'open',
        query: 'flaky',
        issues: [fakeIssue],
      });
      dispatchMessage({
        command: 'repoPullRequests',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'alpha',
        state: 'all',
        pullRequests: [fakePullRequest],
      });
      await nextTick();
      vscodePostMessage().mockClear();

      dispatchMessage({ command: 'refreshData' });

      // The RepoIssues/RepoPullRequests views only re-issue a load when their
      // route params change or they are re-activated, so a refresh pressed while
      // one is open has to post these itself — otherwise the user is left on an
      // empty list with no request in flight.
      const posted = vscodePostMessage().mock.calls.map(([message]) => message);
      expect(posted).toContainEqual({
        command: 'getRepoIssues',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'alpha',
        state: 'closed',
        query: undefined,
      });
      expect(posted).toContainEqual({
        command: 'getRepoIssues',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'beta',
        state: 'open',
        query: 'flaky',
      });
      expect(posted).toContainEqual({
        command: 'getRepoPullRequests',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'alpha',
        state: 'all',
        query: undefined,
      });
      // The dropped payloads are what the re-issued requests replace.
      expect(state.repoIssues.value.size).toBe(0);
      expect(state.repoPullRequests.value.size).toBe(0);
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

    it('renderMarkdown deduplicates concurrent calls for the same cacheKey', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      const first = state.renderMarkdown('inst-1', '**bold**', 'owner/repo');
      const second = state.renderMarkdown('inst-1', '**bold**', 'owner/repo');
      const third = state.renderMarkdown('inst-1', '**bold**', 'owner/repo');

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      const calls = vscodePostMessage().mock.calls;
      const _requestId = (calls[calls.length - 1][0] as { _requestId: string })._requestId;
      dispatchMessage({ command: 'renderedMarkdown', _requestId, html: '<p><strong>bold</strong></p>' });

      await expect(first).resolves.toBe('<p><strong>bold</strong></p>');
      await expect(second).resolves.toBe('<p><strong>bold</strong></p>');
      await expect(third).resolves.toBe('<p><strong>bold</strong></p>');
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);

      // After the in-flight request settles, the cached value is served and
      // the dedup slot is free again for a later TTL-expired refetch.
      await expect(state.renderMarkdown('inst-1', '**bold**', 'owner/repo')).resolves.toBe(
        '<p><strong>bold</strong></p>',
      );
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
    });

    it('renderMarkdown deduplicates concurrent rejections across callers', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      const first = state.renderMarkdown('inst-1', '**bold**', 'owner/repo');
      const second = state.renderMarkdown('inst-1', '**bold**', 'owner/repo');

      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
      const calls = vscodePostMessage().mock.calls;
      const _requestId = (calls[calls.length - 1][0] as { _requestId: string })._requestId;
      dispatchMessage({ command: 'renderedMarkdown', _requestId, error: 'render failed' });

      await expect(first).rejects.toThrow('render failed');
      await expect(second).rejects.toThrow('render failed');

      // A failed request must not leave a stale in-flight entry behind.
      vscodePostMessage().mockClear();
      void state.renderMarkdown('inst-1', '**bold**', 'owner/repo');
      expect(vscodePostMessage()).toHaveBeenCalledTimes(1);
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

  describe('cancelled replies for host-declined destructive confirmations', () => {
    it('pullRequestMerged cancelled clears the spinner without marking the PR merged', async () => {
      const { state, mod } = await createState();
      const detailKey = mod.pullRequestDetailKey('inst-1', 'owner', 'repo', 5);
      state.pullRequestDetails.value.set(detailKey, { state: 'open', merged: false } as never);
      state.mergePullRequest('inst-1', 'owner', 'repo', 5, 'merge');
      const formKey = mod.pullRequestMergeFormKey('inst-1', 'owner', 'repo', 5);
      expect(state.loading.get(formKey)).toBe(true);

      dispatchMessage({
        command: 'pullRequestMerged',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 5,
        cancelled: true,
      });
      await nextTick();

      expect(state.loading.get(formKey)).toBe(false);
      expect(state.errors.get(formKey)).toBeUndefined();
      expect(state.pullRequestDetails.value.get(detailKey)).toMatchObject({ state: 'open', merged: false });
    });

    it('issueCommentDeleted cancelled clears the spinner and keeps the comment', async () => {
      const { state, mod } = await createState();
      const commentsKey = mod.pullRequestCommentsKey('inst-1', 'owner', 'repo', 5);
      state.pullRequestComments.value.set(commentsKey, [{ id: 7, body: 'keep me', type: 'comment' }] as never);
      state.deleteIssueComment('inst-1', 'owner', 'repo', 7);
      const formKey = mod.issueCommentDeleteFormKey('inst-1', 'owner', 'repo', 7);
      expect(state.loading.get(formKey)).toBe(true);

      dispatchMessage({
        command: 'issueCommentDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        commentId: 7,
        cancelled: true,
      });
      await nextTick();

      expect(state.loading.get(formKey)).toBe(false);
      expect(state.errors.get(formKey)).toBeUndefined();
      expect(state.pullRequestComments.value.get(commentsKey)).toHaveLength(1);
    });

    it('repoBranchDeleted cancelled does not reload the refs and sets no error', async () => {
      const { state, mod } = await createState();
      vscodePostMessage().mockClear();

      dispatchMessage({
        command: 'repoBranchDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        branch: 'feature',
        cancelled: true,
      });
      await nextTick();

      const key = mod.repoRefsKey('inst-1', 'owner', 'repo');
      expect(state.errors.get(key)).toBeUndefined();
      expect(
        vscodePostMessage().mock.calls.some((call) => (call[0] as { command: string }).command === 'getRepoRefs'),
      ).toBe(false);
    });

    it('actionRunDeleted cancelled keeps the cached run', async () => {
      const { state, mod } = await createState();
      const runKey = mod.actionRunKey('inst-1', 'owner', 'repo', 7);
      state.actionRunDetails.value.set(runKey, { id: 7, status: 'success' } as never);
      state.deleteActionRun('inst-1', 'owner', 'repo', 7);
      const deleteKey = mod.actionRunDeleteKey('inst-1', 'owner', 'repo', 7);
      expect(state.loading.get(deleteKey)).toBe(true);

      dispatchMessage({
        command: 'actionRunDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        runId: 7,
        cancelled: true,
      });
      await nextTick();

      expect(state.loading.get(deleteKey)).toBe(false);
      expect(state.errors.get(deleteKey)).toBeUndefined();
      expect(state.actionRunDetails.value.get(runKey)).toMatchObject({ id: 7 });
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
        tokenConflicts: [true],
      });
      await nextTick();

      expect(state.importPreview.value?.instances).toHaveLength(1);
      expect(state.importPreview.value?.tokenConflicts).toEqual([true]);
    });

    it('keeps the host error when the import preview file could not be read', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.previewImportInstances();
      dispatchMessage({
        command: 'importInstancesPreview',
        instances: [],
        existingIds: [],
        tokenConflicts: [],
        error: 'invalid password',
      });
      await nextTick();

      // The preview is empty because the read failed: the error must reach the
      // view so it cannot present an empty import as a success.
      expect(state.importPreview.value?.error).toBe('invalid password');
      expect(state.importPreview.value?.instances).toEqual([]);
    });

    it('leaves the preview error unset for a successful import preview', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.previewImportInstances();
      dispatchMessage({
        command: 'importInstancesPreview',
        instances: [{ id: 'inst-2', url: 'https://forgejo.example.com', token: '' }],
        existingIds: [],
      });
      await nextTick();

      expect(state.importPreview.value?.error).toBeUndefined();
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

  describe('notification paging', () => {
    const LIMIT = 50;
    const base = Date.UTC(2026, 8, 20, 12, 0, 0);

    // `offset` keeps a later page's timestamps older than the previous page's,
    // like the server's descending order.
    function page(count: number, firstId = 1, offset = 0) {
      return Array.from({ length: count }, (_, index) => ({
        id: firstId + index,
        unread: true,
        updated_at: new Date(base - (offset + index) * 60_000).toISOString(),
      }));
    }

    it('sends the next-page cursor instead of a page number', async () => {
      const { state, mod } = await createState();
      vscodePostMessage().mockClear();

      state.loadNotifications('inst-1', ['unread', 'pinned'], undefined, '2026-09-20T11:59:00.000Z');

      expect(vscodePostMessage()).toHaveBeenLastCalledWith(
        expect.objectContaining({
          command: 'getNotifications',
          limit: mod.NOTIFICATIONS_LIMIT,
          before: '2026-09-20T11:59:00.000Z',
        }),
      );
    });

    it('keeps the cursor of the loaded page and appends the next one', async () => {
      const { state, mod } = await createState();
      const key = mod.notificationsKey('inst-1');
      const first = page(LIMIT);
      const cursor = first[LIMIT - 1].updated_at;

      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: first });
      await nextTick();

      expect(state.notifications.value.get(key)).toHaveLength(LIMIT);
      expect(state.notificationsHasMore.value.get(key)).toBe(true);
      expect(state.notificationsBefore.value.get(key)).toBe(cursor);

      dispatchMessage({
        command: 'notifications',
        instanceId: 'inst-1',
        notifications: page(2, LIMIT + 1, LIMIT),
        before: cursor,
      });
      await nextTick();

      const list = state.notifications.value.get(key) ?? [];
      expect(list).toHaveLength(LIMIT + 2);
      expect(list[0].id).toBe(1);
      expect(list[LIMIT + 1].id).toBe(LIMIT + 2);
      // A short page keeps Load more available (the server may have clamped its
      // page size), while the cursor moves to the oldest entry so a later
      // refresh/load-more cannot re-request the same range.
      expect(state.notificationsHasMore.value.get(key)).toBe(true);
      expect(state.notificationsBefore.value.get(key)).toBe(page(2, LIMIT + 1, LIMIT)[1].updated_at);
    });

    it('drops entries that are already shown when appending', async () => {
      const { state, mod } = await createState();
      const key = mod.notificationsKey('inst-1');
      const first = page(LIMIT);
      const cursor = first[LIMIT - 1].updated_at;

      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: first });
      await nextTick();
      // Overlapping page (a thread was resurrected between requests).
      dispatchMessage({
        command: 'notifications',
        instanceId: 'inst-1',
        notifications: [first[LIMIT - 1], ...page(2, LIMIT + 1, LIMIT)],
        before: cursor,
      });
      await nextTick();

      expect(state.notifications.value.get(key)).toHaveLength(LIMIT + 2);
    });

    it('replaces the list and resets paging state on a fresh reply', async () => {
      const { state, mod } = await createState();
      const key = mod.notificationsKey('inst-1');

      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: page(LIMIT) });
      await nextTick();
      expect(state.notificationsHasMore.value.get(key)).toBe(true);

      // A filter reload carries no cursor: it starts the list over.
      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: page(1, 99) });
      await nextTick();

      expect(state.notifications.value.get(key)).toHaveLength(1);
      // Still a non-empty page: only an empty reply ends the list.
      expect(state.notificationsHasMore.value.get(key)).toBe(true);

      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [] });
      await nextTick();
      expect(state.notifications.value.get(key)).toHaveLength(0);
      expect(state.notificationsHasMore.value.get(key)).toBe(false);
    });
  });

  describe('notification page helpers', () => {
    it('merges pages without duplicating a thread id', async () => {
      const { mod } = await createState();
      const existing = [{ id: 1 }, { id: 2 }] as never;
      expect(mod.mergeNotificationPages(existing, [{ id: 2 }, { id: 3 }] as never).map((n) => n.id)).toEqual([1, 2, 3]);
      // Nothing new: the same array comes back so the view does not re-render.
      expect(mod.mergeNotificationPages(existing, [{ id: 1 }] as never)).toBe(existing);
    });

    it('takes the oldest timestamp as the cursor, whatever the server offset', async () => {
      const { mod } = await createState();
      expect(
        mod.oldestNotificationTimestamp([
          { id: 1, updated_at: '2026-09-20T14:00:00+02:00' },
          { id: 2, updated_at: '2026-09-20T11:30:00Z' },
          { id: 3, updated_at: 'not-a-date' },
          { id: 4 },
        ] as never),
      ).toBe('2026-09-20T11:30:00.000Z');
    });

    it('reports no cursor when nothing carries a usable timestamp', async () => {
      const { mod } = await createState();
      expect(mod.oldestNotificationTimestamp([{ id: 1 }] as never)).toBeUndefined();
      expect(mod.oldestNotificationTimestamp([])).toBeUndefined();
    });
  });

  describe('notification slots', () => {
    const instance = { id: 'inst-1', url: 'https://forgejo.example.com', token: 'token' };

    async function createStateWithInstance() {
      const { state, mod } = await createState();
      dispatchMessage({ command: 'initialState', instances: [instance] });
      await nextTick();
      return { state, mod };
    }

    it('polled notifications feed the unread badge without touching the filtered view slot', async () => {
      const { state, mod } = await createStateWithInstance();

      dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();

      expect(state.unreadNotificationCount.value).toBe(1);
      expect(state.notifications.value.get(mod.notificationsKey('inst-1'))).toBeUndefined();
    });

    it('a filtered view response does not move the unread badge', async () => {
      const { state, mod } = await createStateWithInstance();

      dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();
      // The user switches the view to read notifications: the view slot shows
      // the filtered (empty) list, but the badge must not drop to zero.
      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [] });
      await nextTick();

      expect(state.notifications.value.get(mod.notificationsKey('inst-1'))).toEqual([]);
      expect(state.unreadNotificationCount.value).toBe(1);
    });

    it('skips writing the stale response when replaying newer filters', async () => {
      const { state, mod } = await createStateWithInstance();
      vscodePostMessage().mockClear();

      state.loadNotifications('inst-1', ['unread', 'pinned']);
      state.loadNotifications('inst-1', ['unread', 'pinned'], ['issue']);
      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();

      expect(vscodePostMessage()).toHaveBeenCalledTimes(2);
      expect(state.notifications.value.get(mod.notificationsKey('inst-1'))).toBeUndefined();
    });

    it('marking a notification read in the view lowers the badge immediately', async () => {
      const { state } = await createStateWithInstance();

      dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();
      expect(state.unreadNotificationCount.value).toBe(1);

      dispatchMessage({ command: 'notificationMarkedRead', instanceId: 'inst-1', id: fakeNotification.id });
      await nextTick();
      expect(state.unreadNotificationCount.value).toBe(0);
    });

    it('the view unread count follows the loaded list while polling is off', async () => {
      const { state, mod } = await createStateWithInstance();

      // Polling disabled: the poller slot is empty, only the view list loaded.
      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();

      expect(state.notifications.value.get(mod.notificationsKey('inst-1'))).toEqual([fakeNotification]);
      expect(state.unreadNotificationCount.value).toBe(0);
      expect(state.unreadViewNotificationCount.value).toBe(1);
    });

    it('the view unread count drops when the list is marked read', async () => {
      const { state } = await createStateWithInstance();

      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();
      expect(state.unreadViewNotificationCount.value).toBe(1);

      dispatchMessage({ command: 'allNotificationsMarkedRead', instanceId: 'inst-1' });
      await nextTick();
      expect(state.unreadViewNotificationCount.value).toBe(0);
    });

    it('loads the unread list once for the badge when the poller never reports', async () => {
      const { state } = await createStateWithInstance();
      vscodePostMessage().mockClear();

      state.loadNotificationBadge('inst-1');
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getNotifications', instanceId: 'inst-1' }),
      );

      dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();

      // The requested page is the unfiltered `['unread', 'pinned']` list the
      // poller would have pushed, so it fills the badge slot as well.
      expect(state.polledNotifications.value.get('inst-1')).toEqual([fakeNotification]);
      expect(state.unreadNotificationCount.value).toBe(1);

      // One shot per instance: a later dashboard activation must not re-ask.
      vscodePostMessage().mockClear();
      state.loadNotificationBadge('inst-1');
      expect(vscodePostMessage()).not.toHaveBeenCalled();
    });

    it('leaves the badge to the poller once a poll has answered', async () => {
      const { state } = await createStateWithInstance();
      dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [fakeNotification] });
      await nextTick();
      vscodePostMessage().mockClear();

      state.loadNotificationBadge('inst-1');

      expect(vscodePostMessage()).not.toHaveBeenCalled();
      expect(state.unreadNotificationCount.value).toBe(1);
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

    it('repoFilesSearchResult records an incomplete tree for its own query', async () => {
      const { state, mod } = await createState();
      const truncatedKey = mod.repoFileSearchKey('inst-1', 'owner', 'repo', 'main', 'foo');
      const completeKey = mod.repoFileSearchKey('inst-1', 'owner', 'repo', 'main', 'bar');

      dispatchMessage({
        command: 'repoFilesSearchResult',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        query: 'foo',
        files: [{ path: 'src/foo.ts' }],
        truncated: true,
      });
      dispatchMessage({
        command: 'repoFilesSearchResult',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        query: 'bar',
        files: [],
      });
      await nextTick();

      // An incomplete result with no named cause keeps the conservative tree
      // wording rather than being dropped.
      expect(state.repoFileSearchTruncated.value.get(truncatedKey)).toBe('tree');
      // A reply without the flag is a complete tree, not a stale "truncated".
      expect(state.repoFileSearchTruncated.value.get(completeKey)).toBeUndefined();
    });

    it('repoFilesSearchResult carries which cap the host applied', async () => {
      const { state, mod } = await createState();
      const matchesKey = mod.repoFileSearchKey('inst-1', 'owner', 'repo', 'main', 'e');
      const treeKey = mod.repoFileSearchKey('inst-1', 'owner', 'repo', 'main', 'deep');

      dispatchMessage({
        command: 'repoFilesSearchResult',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        query: 'e',
        files: [{ path: 'src/e.ts' }],
        truncated: true,
        truncatedBy: 'matches',
      });
      dispatchMessage({
        command: 'repoFilesSearchResult',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        query: 'deep',
        files: [{ path: 'src/deep.ts' }],
        truncated: true,
        truncatedBy: 'tree',
      });
      await nextTick();

      // The cause reaches the view: "narrow the search" and "the tree could not
      // be read" are different claims and only the first is actionable.
      expect(state.repoFileSearchTruncated.value.get(matchesKey)).toBe('matches');
      expect(state.repoFileSearchTruncated.value.get(treeKey)).toBe('tree');
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

    it('payload maps evict the least recently written entry at the shared cap', async () => {
      const { state, mod } = await createState();

      for (let i = 0; i < 70; i += 1) {
        dispatchMessage({
          command: 'repoDetail',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: `repo-${i}`,
          detail: fakeRepoDetail,
        });
      }
      await nextTick();

      // Bounded like the response caches: a session cannot hold one entry per
      // repository/issue/query it ever visited.
      expect(state.repoDetails.value.size).toBe(64);
      expect(state.repoDetails.value.has(mod.repoDetailKey('inst-1', 'owner', 'repo-0'))).toBe(false);
      expect(state.repoDetails.value.has(mod.repoDetailKey('inst-1', 'owner', 'repo-69'))).toBe(true);
    });

    it('rewriting a payload slot moves it to the newest position instead of evicting it', async () => {
      const { state, mod } = await createState();

      for (let i = 0; i < 64; i += 1) {
        dispatchMessage({
          command: 'repoDetail',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: `repo-${i}`,
          detail: fakeRepoDetail,
        });
      }
      // Touch the oldest slot, then overflow the cap once.
      dispatchMessage({
        command: 'repoDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo-0',
        detail: fakeRepoDetail,
      });
      dispatchMessage({
        command: 'repoDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo-64',
        detail: fakeRepoDetail,
      });
      await nextTick();

      expect(state.repoDetails.value.has(mod.repoDetailKey('inst-1', 'owner', 'repo-0'))).toBe(true);
      // The next-oldest slot is the one that had to go.
      expect(state.repoDetails.value.has(mod.repoDetailKey('inst-1', 'owner', 'repo-1'))).toBe(false);
    });
  });

  describe('repository-scoped invalidation', () => {
    it('a saved issue invalidates only its own repository and lets the list refetch', async () => {
      const { state, mod } = await createState();
      for (const repo of ['alpha', 'beta']) {
        dispatchMessage({
          command: 'repoIssues',
          instanceId: 'inst-1',
          owner: 'owner',
          repo,
          state: 'open',
          issues: [fakeIssue],
        });
      }

      dispatchMessage({
        command: 'issueUpdated',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'alpha',
        index: 1,
        item: fakeIssue,
      });
      await nextTick();

      expect(state.repoIssues.value.has(mod.repoIssuesKey('inst-1', 'owner', 'alpha', 'open'))).toBe(false);
      // The other repository keeps its list: one save must not wipe every repo.
      expect(state.repoIssues.value.has(mod.repoIssuesKey('inst-1', 'owner', 'beta', 'open'))).toBe(true);

      // The fresh mark went with the list, so the next visit refetches instead
      // of serving the dropped slot as fresh for the rest of the TTL.
      vscodePostMessage().mockClear();
      state.loadRepoIssues('inst-1', 'owner', 'alpha', 'open');
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getRepoIssues', instanceId: 'inst-1', repo: 'alpha' }),
      );
    });

    it('a deleted issue invalidates only its own repository', async () => {
      const { state, mod } = await createState();
      for (const repo of ['alpha', 'beta']) {
        dispatchMessage({
          command: 'repoIssues',
          instanceId: 'inst-1',
          owner: 'owner',
          repo,
          state: 'open',
          issues: [fakeIssue],
        });
      }

      dispatchMessage({ command: 'issueDeleted', instanceId: 'inst-1', owner: 'owner', repo: 'alpha', index: 1 });
      await nextTick();

      expect(state.repoIssues.value.has(mod.repoIssuesKey('inst-1', 'owner', 'alpha', 'open'))).toBe(false);
      expect(state.repoIssues.value.has(mod.repoIssuesKey('inst-1', 'owner', 'beta', 'open'))).toBe(true);
    });

    it('navigating to another repository releases the one left behind', async () => {
      const { state, mod, router } = await createState();
      // The release is driven by the router hook the composable installs; it
      // only exists when a router was injected (see
      // useAppState.withoutRouter.test.ts), so assert it here too.
      await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'alpha' } });
      dispatchMessage({
        command: 'repoDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'alpha',
        detail: fakeRepoDetail,
      });
      dispatchMessage({
        command: 'repoIssues',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'alpha',
        state: 'open',
        issues: [fakeIssue],
      });
      // A repository whose name merely shares the prefix must survive the release.
      dispatchMessage({
        command: 'repoDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'alphabet',
        detail: fakeRepoDetail,
      });
      await nextTick();
      expect(state.repoDetails.value.has(mod.repoDetailKey('inst-1', 'owner', 'alpha'))).toBe(true);

      await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'beta' } });
      await nextTick();

      expect(state.repoDetails.value.has(mod.repoDetailKey('inst-1', 'owner', 'alpha'))).toBe(false);
      expect(state.repoIssues.value.has(mod.repoIssuesKey('inst-1', 'owner', 'alpha', 'open'))).toBe(false);
      expect(state.repoDetails.value.has(mod.repoDetailKey('inst-1', 'owner', 'alphabet'))).toBe(true);

      // The response caches are released with the payloads: a live cache entry
      // would otherwise answer the next visit with a hit whose payload is gone.
      vscodePostMessage().mockClear();
      state.loadRepoDetail('inst-1', 'owner', 'alpha');
      expect(vscodePostMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'getRepoDetail', instanceId: 'inst-1', repo: 'alpha' }),
      );
      // ... while `alphabet` still answers from its live cache entry.
      vscodePostMessage().mockClear();
      state.loadRepoDetail('inst-1', 'owner', 'alphabet');
      expect(vscodePostMessage()).not.toHaveBeenCalled();
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

      dispatchMessage({ command: 'myIssues', instanceId: 'inst-1', state: 'closed', issues: [fakeIssue] });
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

      dispatchMessage({
        command: 'myPullRequests',
        instanceId: 'inst-1',
        state: 'open',
        pullRequests: [fakePullRequest],
      });
      await nextTick();

      expect(state.loading.get('pulls-inst-1-open')).toBe(false);
      expect(state.myPullRequestsCache.has('inst-1:open')).toBe(true);
    });

    it('routes concurrent myIssues responses to the state echoed by the host', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.loadMyIssues('inst-1', 'open');
      state.loadMyIssues('inst-1', 'closed');
      expect(state.loading.get('issues-inst-1-open')).toBe(true);
      expect(state.loading.get('issues-inst-1-closed')).toBe(true);

      // Responses arriving out of order must still land in their own slots.
      dispatchMessage({ command: 'myIssues', instanceId: 'inst-1', state: 'closed', issues: [fakeIssue] });
      await nextTick();
      expect(state.loading.get('issues-inst-1-closed')).toBe(false);
      expect(state.loading.get('issues-inst-1-open')).toBe(true);
      expect(state.myIssuesCache.has('inst-1:closed')).toBe(true);
      expect(state.myIssuesCache.has('inst-1:open')).toBe(false);

      dispatchMessage({ command: 'myIssues', instanceId: 'inst-1', state: 'open', error: 'boom' });
      await nextTick();
      expect(state.loading.get('issues-inst-1-open')).toBe(false);
      expect(state.errors.get('issues-inst-1-open')).toBe('boom');
      expect(state.myIssuesCache.has('inst-1:open')).toBe(false);
      expect(state.myIssuesCache.has('inst-1:closed')).toBe(true);
    });

    it('routes concurrent myPullRequests responses to the state echoed by the host', async () => {
      const { state } = await createState();
      vscodePostMessage().mockClear();

      state.loadMyPullRequests('inst-1', 'open');
      state.loadMyPullRequests('inst-1', 'closed');
      dispatchMessage({
        command: 'myPullRequests',
        instanceId: 'inst-1',
        state: 'closed',
        pullRequests: [fakePullRequest],
      });
      await nextTick();

      expect(state.loading.get('pulls-inst-1-closed')).toBe(false);
      expect(state.loading.get('pulls-inst-1-open')).toBe(true);
      expect(state.myPullRequestsCache.has('inst-1:closed')).toBe(true);
      expect(state.myPullRequestsCache.has('inst-1:open')).toBe(false);
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

  it('drops a cancelled import result instead of reporting a failure', async () => {
    const { state } = await createState();

    dispatchMessage({ command: 'instancesImported', success: false, cancelled: true });
    await nextTick();

    // Views watch this ref to show success/error status; a cancel is neither.
    expect(state.importInstancesResult.value).toBeUndefined();

    // A real result afterwards still lands.
    dispatchMessage({ command: 'instancesImported', success: true, count: 2 });
    await nextTick();
    expect(state.importInstancesResult.value).toMatchObject({ success: true, count: 2 });
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

describe('openPullRequestDiff', () => {
  it('forwards previousFilename for renamed files to the host', async () => {
    const { state } = await createState();
    vscodePostMessage().mockClear();

    state.openPullRequestDiff('inst-1', 'owner', 'repo', 2, 'src/new.ts', 'renamed', 'base1', 'head1', 'src/old.ts');

    expect(vscodePostMessage()).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'openPullRequestDiff',
        filename: 'src/new.ts',
        previousFilename: 'src/old.ts',
      }),
    );
  });

  it('forwards previous_filename in selected diffs', async () => {
    const { state } = await createState();
    vscodePostMessage().mockClear();

    state.openSelectedPullRequestDiffs(
      'inst-1',
      'owner',
      'repo',
      2,
      [{ filename: 'src/new.ts', status: 'renamed', previous_filename: 'src/old.ts' }],
      'base1',
      'head1',
    );

    expect(vscodePostMessage()).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'openSelectedPullRequestDiffs',
        files: [{ filename: 'src/new.ts', status: 'renamed', previous_filename: 'src/old.ts' }],
      }),
    );
  });
});

describe('notification poll errors', () => {
  const instance = { id: 'inst-1', url: 'https://forgejo.example.com', token: 'token' };

  async function createStateWithInstance() {
    const { state, mod } = await createState();
    dispatchMessage({ command: 'initialState', instances: [instance] });
    await nextTick();
    return { state, mod };
  }

  it('stores poll failures per instance without clearing the last good snapshot', async () => {
    const { state } = await createStateWithInstance();

    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [fakeNotification] });
    await nextTick();
    expect(state.unreadNotificationCount.value).toBe(1);

    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', error: 'instance unreachable' });
    await nextTick();

    expect(state.notificationPollErrors.value.get('inst-1')).toBe('instance unreachable');
    // The previous snapshot must survive: a failed poll is not an empty inbox.
    expect(state.unreadNotificationCount.value).toBe(1);
  });

  it('clears the poll error on the next successful poll', async () => {
    const { state } = await createStateWithInstance();

    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', error: 'instance unreachable' });
    await nextTick();
    expect(state.notificationPollErrors.value.get('inst-1')).toBe('instance unreachable');

    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [] });
    await nextTick();
    expect(state.notificationPollErrors.value.has('inst-1')).toBe(false);
  });
});

describe('issue/pull state toggles', () => {
  it('toggleIssueState posts editIssue with the state_toggle marker and its own loading key', async () => {
    const { state, mod } = await createState();
    vscodePostMessage().mockClear();

    state.toggleIssueState('inst-1', 'owner', 'repo', 5, 'closed');

    expect(vscodePostMessage()).toHaveBeenCalledWith({
      command: 'editIssue',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 5,
      data: { state: 'closed', state_toggle: true },
    });
    expect(state.loading.get(mod.issueStateKey('inst-1', 'owner', 'repo', 5))).toBe(true);
    expect(state.loading.get(mod.issueFormKey('inst-1', 'owner', 'repo', 5))).toBeUndefined();
  });

  it('togglePullRequestState posts editPullRequest with the state_toggle marker and its own loading key', async () => {
    const { state, mod } = await createState();
    vscodePostMessage().mockClear();

    state.togglePullRequestState('inst-1', 'owner', 'repo', 7, 'closed');

    expect(vscodePostMessage()).toHaveBeenCalledWith({
      command: 'editPullRequest',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 7,
      data: { state: 'closed', state_toggle: true },
    });
    expect(state.loading.get(mod.pullRequestStateKey('inst-1', 'owner', 'repo', 7))).toBe(true);
  });

  it('routes issueUpdated errors for state toggles to the state key, not the form key', async () => {
    const { state, mod } = await createState();

    dispatchMessage({
      command: 'issueUpdated',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 5,
      error: 'boom',
      stateToggle: true,
    });
    await nextTick();

    expect(state.errors.get(mod.issueStateKey('inst-1', 'owner', 'repo', 5))).toBe('boom');
    expect(state.errors.get(mod.issueFormKey('inst-1', 'owner', 'repo', 5))).toBeUndefined();
    expect(state.loading.get(mod.issueStateKey('inst-1', 'owner', 'repo', 5))).toBe(false);
  });

  it('routes pullRequestUpdated errors for state toggles to the state key, not the form key', async () => {
    const { state, mod } = await createState();

    dispatchMessage({
      command: 'pullRequestUpdated',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 7,
      error: 'boom',
      stateToggle: true,
    });
    await nextTick();

    expect(state.errors.get(mod.pullRequestStateKey('inst-1', 'owner', 'repo', 7))).toBe('boom');
    expect(state.errors.get(mod.pullRequestFormKey('inst-1', 'owner', 'repo', 7))).toBeUndefined();
  });
});

describe('openNewIssue pending intent', () => {
  it('stores the prefill and navigates to the repo issues view', async () => {
    const { state, router } = await createState();

    dispatchMessage({
      command: 'openNewIssue',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      title: 'refactor this',
      body: 'https://forgejo.example.com/owner/repo/blob/abc/src/a.ts#L5',
    });
    // The router push lazy-loads the RepoIssues chunk; poll for the finished
    // navigation instead of assuming a previous test already cached the chunk.
    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('repoIssues');
    });

    expect(router.currentRoute.value.name).toBe('repoIssues');
    expect(router.currentRoute.value.params).toMatchObject({ instanceId: 'inst-1', owner: 'owner', repo: 'repo' });
    expect(state.pendingNewIssue.value).toMatchObject({ title: 'refactor this' });
  });

  it('consumePendingNewIssue returns the prefill once and only for the matching repo', async () => {
    const { state } = await createState();

    dispatchMessage({
      command: 'openNewIssue',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      title: 'refactor this',
      body: 'body',
    });
    await nextTick();

    expect(state.consumePendingNewIssue('inst-1', 'owner', 'other')).toBeUndefined();
    expect(state.pendingNewIssue.value).not.toBeNull();

    const pending = state.consumePendingNewIssue('inst-1', 'owner', 'repo');
    expect(pending).toMatchObject({ title: 'refactor this', body: 'body' });
    expect(state.pendingNewIssue.value).toBeNull();
  });
});

describe('startWorkOnIssue', () => {
  it('posts startWorkOnIssue, sets loading, and routes errors to the start-work key', async () => {
    const { state, mod } = await createState();
    const key = mod.startWorkKey('inst-1', 'owner', 'repo', 5);

    state.startWorkOnIssue('inst-1', 'owner', 'repo', 5, 'fix-bug');
    await nextTick();

    expect(vscodePostMessage()).toHaveBeenCalledWith({
      command: 'startWorkOnIssue',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 5,
      title: 'fix-bug',
    });
    expect(state.loading.get(key)).toBe(true);

    dispatchMessage({
      command: 'startWorkResult',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 5,
      error: 'fatal: could not fetch',
    });
    await nextTick();

    expect(state.loading.get(key)).toBe(false);
    expect(state.errors.get(key)).toBe('fatal: could not fetch');
  });

  it('clears the start-work error on success', async () => {
    const { state, mod } = await createState();
    const key = mod.startWorkKey('inst-1', 'owner', 'repo', 5);

    dispatchMessage({
      command: 'startWorkResult',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 5,
      error: 'previous failure',
    });
    await nextTick();
    expect(state.errors.get(key)).toBe('previous failure');

    dispatchMessage({
      command: 'startWorkResult',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 5,
    });
    await nextTick();

    expect(state.loading.get(key)).toBe(false);
    expect(state.errors.get(key)).toBeUndefined();
  });
});

describe('previewReadme', () => {
  it('sends the instance id so the host keys the preview document by it', async () => {
    const { state } = await createState();

    state.previewReadme('inst-2', 'owner', 'repo', '# hello');

    expect(vscodePostMessage()).toHaveBeenCalledWith({
      command: 'previewReadme',
      instanceId: 'inst-2',
      owner: 'owner',
      repo: 'repo',
      content: '# hello',
    });
  });
});

describe('delete requests answered with cancelled', () => {
  /** Request id of the last message of the given command posted to the host. */
  function lastRequestId(command: string): string {
    const calls = vscodePostMessage().mock.calls.map((call) => call[0] as { command: string; _requestId: string });
    const match = [...calls].reverse().find((message) => message.command === command);
    if (!match) {
      throw new Error(`no ${command} message was posted`);
    }
    return match._requestId;
  }

  it('reports a declined issue attachment delete as not deleted', async () => {
    const { state } = await createState();
    const pending = state.deleteIssueAttachment('inst-1', 'owner', 'repo', 2, 7);
    const requestId = lastRequestId('deleteIssueAttachment');

    dispatchMessage({
      command: 'issueAttachmentDeleted',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 2,
      attachmentId: 7,
      cancelled: true,
      _requestId: requestId,
    });

    await expect(pending).resolves.toBe(false);
  });

  it('reports a completed issue attachment delete as deleted', async () => {
    const { state } = await createState();
    const pending = state.deleteIssueAttachment('inst-1', 'owner', 'repo', 2, 7);
    const requestId = lastRequestId('deleteIssueAttachment');

    dispatchMessage({
      command: 'issueAttachmentDeleted',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 2,
      attachmentId: 7,
      _requestId: requestId,
    });

    await expect(pending).resolves.toBe(true);
  });

  it('reports a declined release attachment delete as not deleted', async () => {
    const { state } = await createState();
    const pending = state.deleteReleaseAttachment('inst-1', 'owner', 'repo', 3, 7);
    const requestId = lastRequestId('deleteReleaseAttachment');

    dispatchMessage({
      command: 'releaseAttachmentDeleted',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      id: 3,
      attachmentId: 7,
      cancelled: true,
      _requestId: requestId,
    });

    await expect(pending).resolves.toBe(false);
  });

  it('keeps an existing comment attachment when the delete was declined', async () => {
    const { state } = await createState();
    const key = 'inst-1:owner/repo#2';
    state.pullRequestComments.value.set(key, [{ id: 5, body: 'hi', assets: [{ id: 7, name: 'shot.png' }] } as never]);

    const pending = state.deleteIssueCommentAttachment('inst-1', 'owner', 'repo', 5, 7);
    const requestId = lastRequestId('deleteIssueCommentAttachment');
    dispatchMessage({
      command: 'issueCommentAttachmentDeleted',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      commentId: 5,
      attachmentId: 7,
      cancelled: true,
      _requestId: requestId,
    });

    await expect(pending).resolves.toBe(false);
    expect(state.pullRequestComments.value.get(key)?.[0].assets).toHaveLength(1);
  });

  it('clears the pending state of a declined stopwatch delete without reloading', async () => {
    const { state, mod } = await createState();
    const key = mod.issueTrackedTimesKey('inst-1', 'owner', 'repo', 2);
    state.loading.set(key, true);

    dispatchMessage({
      command: 'issueStopwatchChanged',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 2,
      action: 'delete',
      cancelled: true,
    });
    await nextTick();

    expect(state.loading.get(key)).toBe(false);
    expect(state.errors.get(key)).toBeUndefined();
    expect(vscodePostMessage()).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'getIssueTrackedTimes' }));
  });

  it('keeps the tracked times when the reset was declined', async () => {
    const { state, mod } = await createState();
    const key = mod.issueTrackedTimesKey('inst-1', 'owner', 'repo', 2);
    const times = [{ id: 1, time: 600, user_name: 'demo-user' }];
    state.issueTrackedTimes.value.set(key, times);
    state.loading.set(key, true);

    dispatchMessage({
      command: 'issueTimeReset',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 2,
      cancelled: true,
    });
    await nextTick();

    // Declining is not a reset: the list must not render as emptied.
    expect(state.loading.get(key)).toBe(false);
    expect(state.errors.get(key)).toBeUndefined();
    expect(state.issueTrackedTimes.value.get(key)).toEqual(times);
  });

  it('empties the tracked times when the reset is confirmed', async () => {
    const { state, mod } = await createState();
    const key = mod.issueTrackedTimesKey('inst-1', 'owner', 'repo', 2);
    state.issueTrackedTimes.value.set(key, [{ id: 1, time: 600, user_name: 'demo-user' }]);
    state.loading.set(key, true);

    dispatchMessage({ command: 'issueTimeReset', instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 2 });
    await nextTick();

    expect(state.issueTrackedTimes.value.get(key)).toEqual([]);
  });
});

describe('workflow dispatch cancellation', () => {
  it('records a declined dispatch so views do not wait for a run that never starts', async () => {
    const { state, mod } = await createState();
    const key = mod.dispatchWorkflowKey('inst-1', 'owner', 'repo', 'ci.yml');
    state.loading.set(key, true);
    vscodePostMessage().mockClear();

    dispatchMessage({
      command: 'actionRunDispatched',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      workflowfilename: 'ci.yml',
      cancelled: true,
    });
    await nextTick();

    expect(state.loading.get(key)).toBe(false);
    expect(state.errors.get(key)).toBeUndefined();
    expect(state.lastDispatchCancelled.value).toBe(key);
    // Nothing was dispatched, so nothing is refreshed either.
    expect(vscodePostMessage()).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'getActionRuns' }));

    // A later accepted dispatch clears the marker.
    dispatchMessage({
      command: 'actionRunDispatched',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      workflowfilename: 'ci.yml',
      accepted: true,
      run: { id: 5 },
    });
    await nextTick();

    expect(state.lastDispatchCancelled.value).toBeUndefined();
  });
});

describe('attachment upload reply', () => {
  it('keeps the server id so the delete path can address the attachment', async () => {
    const { state } = await createState();
    const file = new File(['data'], 'shot.png', { type: 'image/png' });
    const pending = state.uploadIssueAttachment('inst-1', 'owner', 'repo', 2, file);

    let requestId = '';
    await vi.waitFor(() => {
      const sent = vscodePostMessage()
        .mock.calls.map(([message]) => message as { command?: string; _requestId?: string })
        .reverse()
        .find((message) => message.command === 'createIssueAttachment');
      if (!sent?._requestId) {
        throw new Error('createIssueAttachment not sent yet');
      }
      requestId = sent._requestId;
    });

    dispatchMessage({
      command: 'issueAttachmentCreated',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 2,
      id: 42,
      uuid: 'uuid-1',
      name: 'shot.png',
      size: 4,
      browser_download_url: '/attachments/uuid-1',
      _requestId: requestId,
    });

    // The id is what IssueDetail's edit dialog hands to deleteIssueAttachment;
    // dropping it makes the delete button a silent no-op.
    await expect(pending).resolves.toMatchObject({ id: 42, uuid: 'uuid-1' });
  });
});

describe('comment reaction request throttling', () => {
  it('keeps at most four reaction requests in flight and releases the queue on reply', async () => {
    const { state } = await createState();
    for (const commentId of [1, 2, 3, 4, 5, 6]) {
      state.loadCommentReactions('inst-1', 'owner', 'repo', commentId);
    }
    const sentCommentIds = () =>
      vscodePostMessage()
        .mock.calls.map(([message]) => message as { command?: string; commentId?: number })
        .filter((message) => message.command === 'getCommentReactions')
        .map((message) => message.commentId);
    // Every rendered comment shows its counts, but a busy timeline must not fire one
    // request per comment at once.
    expect(sentCommentIds()).toEqual([1, 2, 3, 4]);
    dispatchMessage({
      command: 'commentReactions',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      commentId: 1,
      reactions: [],
    });
    expect(sentCommentIds()).toEqual([1, 2, 3, 4, 5]);
    // A failed request releases its slot too, or the queue would stall forever.
    dispatchMessage({
      command: 'commentReactions',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      commentId: 2,
      error: 'boom',
    });
    expect(sentCommentIds()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('comment reaction payloads', () => {
  // A timeline longer than the shared payload cap: every comment stays on
  // screen (the view renders the whole page), so none of their reactions may be
  // dropped just because the cap is reached.
  const TIMELINE_LENGTH = 70;

  function dispatchReaction(commentId: number, repo = 'repo', content = '+1') {
    dispatchMessage({
      command: 'commentReactions',
      instanceId: 'inst-1',
      owner: 'owner',
      repo,
      commentId,
      reactions: [{ content, user: fakeUser }],
    });
  }

  it('keeps every visible comment of an over-cap timeline', async () => {
    const { state, mod, router } = await createState();
    await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo' } });

    for (let commentId = 1; commentId <= TIMELINE_LENGTH; commentId += 1) {
      dispatchReaction(commentId);
    }
    await nextTick();

    // The shared cap would have dropped comments 1..6 (70 - 64) while their
    // rows were still rendered, leaving their reaction bars empty.
    expect(state.commentReactions.value.size).toBe(TIMELINE_LENGTH);
    expect(state.commentReactions.value.get(mod.commentReactionsKey('inst-1', 'owner', 'repo', 1))).toHaveLength(1);
    expect(state.commentReactions.value.get(mod.commentReactionsKey('inst-1', 'owner', 'repo', 70))).toHaveLength(1);
  });

  it('bounds the entries of a repository the user left behind', async () => {
    const { state, mod, router } = await createState();
    await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'alpha' } });
    await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'beta' } });

    // Ten comments of the repository the user is looking at.
    for (let commentId = 1; commentId <= 10; commentId += 1) {
      dispatchReaction(commentId, 'beta');
    }
    // More comments than the cap for the repository left behind: one entry per
    // rendered comment would otherwise pile up for every repository visited.
    for (let commentId = 1; commentId <= 70; commentId += 1) {
      dispatchReaction(commentId, 'alpha');
    }
    await nextTick();

    // Ten visible `beta` rows plus the cap's worth of `alpha`: the stale entries
    // replace each other instead of growing without bound.
    expect(state.commentReactions.value.size).toBe(10 + 64);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'alpha', 1))).toBe(false);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'alpha', 6))).toBe(false);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'alpha', 7))).toBe(true);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'alpha', 70))).toBe(true);
    // Never at the expense of a row the user can still see.
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'beta', 1))).toBe(true);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'beta', 10))).toBe(true);

    // Leaving the repository releases what it held; the repository left behind
    // earlier keeps its capped entries until the user returns to it (its rows
    // are re-fetched then, and a stale entry is rewritten in place).
    await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'gamma' } });
    await nextTick();
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'beta', 10))).toBe(false);
    expect(state.commentReactions.value.size).toBe(64);
  });

  it('keeps every entry while no repository is active', async () => {
    const { state, mod } = await createState();
    // No route was ever visited, so no repository is active and no entry can be
    // shown to have left the screen: none may be dropped on the cap's account.
    for (let commentId = 1; commentId <= TIMELINE_LENGTH; commentId += 1) {
      dispatchReaction(commentId, 'repo');
    }
    await nextTick();

    expect(state.commentReactions.value.size).toBe(TIMELINE_LENGTH);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', 1))).toBe(true);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', 70))).toBe(true);
  });

  it('caps the active repository at the rows a timeline can hold', async () => {
    const { state, mod, router } = await createState();
    await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo' } });

    // One more comment than the host can return for a timeline. A repository
    // the user stays on is the one case that could otherwise grow for as long
    // as the session lasts.
    const overCap = LIST_ITEM_LIMIT + 1;
    for (let commentId = 1; commentId <= overCap; commentId += 1) {
      dispatchReaction(commentId);
    }
    await nextTick();

    // The oldest write is the one evicted; the cap holds the rows the timeline
    // can still show.
    expect(state.commentReactions.value.size).toBe(LIST_ITEM_LIMIT);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', 1))).toBe(false);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', 2))).toBe(true);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', overCap))).toBe(true);
  });

  it('treats a rewritten key as the newest, as the other bounded maps do', async () => {
    const { state, mod, router } = await createState();
    await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo' } });

    const overCap = LIST_ITEM_LIMIT + 1;
    for (let commentId = 1; commentId <= overCap; commentId += 1) {
      dispatchReaction(commentId);
    }
    // Re-reading a comment's reactions is a rewrite, not a new slot: it must
    // move that comment back to the newest end instead of being evicted next.
    dispatchReaction(2);
    dispatchReaction(overCap + 1);
    await nextTick();

    expect(state.commentReactions.value.size).toBe(LIST_ITEM_LIMIT);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', 2))).toBe(true);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', 3))).toBe(false);
    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', overCap + 1))).toBe(
      true,
    );
  });

  it('charges each write to the cap of the scope it belongs to', async () => {
    const { state, mod, router } = await createState();
    await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'beta' } });

    // A timeline that fills the cap of the repository on screen: every one of
    // its rows is rendered by the view.
    for (let commentId = 1; commentId <= LIST_ITEM_LIMIT; commentId += 1) {
      dispatchReaction(commentId, 'beta');
    }
    // Interleaved reaction refreshes, for the repository left behind and for the
    // one on screen. Each is a new key at most in its own scope: nothing here
    // takes a slot from the other repository.
    dispatchReaction(1, 'alpha');
    dispatchReaction(LIST_ITEM_LIMIT, 'beta');
    dispatchReaction(2, 'alpha');
    dispatchReaction(LIST_ITEM_LIMIT - 1, 'beta');
    await nextTick();

    // Charging the alpha writes to beta's cap would evict beta's oldest rows
    // while the view still renders them.
    for (let commentId = 1; commentId <= LIST_ITEM_LIMIT; commentId += 1) {
      expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'beta', commentId))).toBe(
        true,
      );
    }
    expect([...state.commentReactions.value.keys()].filter((key) => key.includes('/alpha'))).toHaveLength(2);
  });

  it('does not drop a left-behind entry when the visible repository writes', async () => {
    const { state, mod, router } = await createState();
    await router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo: 'beta' } });

    // The repository the user left behind holds a full cap of its own...
    for (let commentId = 1; commentId <= 64; commentId += 1) {
      dispatchReaction(commentId, 'alpha');
    }
    // ...and a write for the repository on screen must not take a slot from it.
    dispatchReaction(1, 'beta');
    await nextTick();

    expect(state.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'alpha', 1))).toBe(true);
    expect([...state.commentReactions.value.keys()].filter((key) => key.includes('/alpha'))).toHaveLength(64);
  });
});

describe('notification paging boundary', () => {
  it('does not treat a short notification page as the end', async () => {
    const { state } = await createState();
    const page = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        unread: true,
        updated_at: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
        subject: { title: 'a notification', type: 'Issue' },
      }));

    // Three rows is a short page for the requested limit, but the server may have
    // clamped its own page size: ending the list here would hide notifications.
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: page(3) });
    await flushPromises();
    expect([...state.notificationsHasMore.value.values()]).toEqual([true]);

    // An empty page is the only proof that the list ended.
    dispatchMessage({
      command: 'notifications',
      instanceId: 'inst-1',
      notifications: [],
      before: '2026-01-01T00:00:00Z',
    });
    await flushPromises();
    expect([...state.notificationsHasMore.value.values()]).toEqual([false]);
  });
});
