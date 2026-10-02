import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      pullRequestDetails: { value: new Map<string, unknown>() },
      pullRequestFiles: { value: new Map<string, unknown>() },
      pullRequestComments: { value: new Map<string, unknown>() },
      pullRequestCommits: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      repoDetails: { value: new Map<string, unknown>() },
      repoIssues: { value: new Map<string, unknown[]>() },
      repoIssuesTotalCount: { value: new Map() },
      repoIssuesFetchedAt: { has: () => false },
      issueSubscriptions: { value: new Map<string, unknown>() },
      issueTrackedTimes: { value: new Map<string, unknown>() },
      issueDependencies: { value: new Map<string, unknown>() },
      issueReactions: { value: new Map<string, unknown>() },
      userStopwatches: { value: new Map<string, unknown>() },
      worktrees: { value: [] as unknown[] },
      lastWorktreeCancelled: { value: undefined },
      lastWorktreeError: { value: undefined },
      lastSavedPullRequest: { value: undefined },
      supportsMultiDiff: { value: false },
      loadPullRequestDetail: vi.fn(),
      loadPullRequestFiles: vi.fn(),
      loadPullRequestComments: vi.fn(),
      loadPullRequestCommits: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadRepoIssues: vi.fn(),
      loadIssueSubscription: vi.fn(),
      loadIssueTrackedTimes: vi.fn(),
      loadUserStopwatches: vi.fn(),
      loadIssueDependencies: vi.fn(),
      loadIssueReactions: vi.fn(),
      openPrWorktree: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      openPullRequestDiff: vi.fn(),
      openSelectedPullRequestDiffs: vi.fn(),
      copyToClipboard: vi.fn(),
      mergePullRequest: vi.fn(),
      revertMergeCommit: vi.fn(),
      togglePullRequestState: vi.fn(),
      editPullRequest: vi.fn(),
      createIssueComment: vi.fn(),
      uploadIssueAttachment: vi.fn(),
      uploadIssueCommentAttachment: vi.fn(),
      deleteIssueAttachment: vi.fn(),
      changeIssueSubscription: vi.fn(),
      changeIssueReaction: vi.fn(),
      addIssueTime: vi.fn(),
      deleteIssueTime: vi.fn(),
      createIssueDependency: vi.fn(),
      removeIssueDependency: vi.fn(),
      updatePullRequestDueDate: vi.fn(),
      startIssueStopwatch: vi.fn(),
      stopIssueStopwatch: vi.fn(),
      renderMarkdown: vi.fn(async () => ''),
      showConfirm: vi.fn(async () => true),
    },
  };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    pullRequestDetailKey: keyBuilder,
    pullRequestFilesKey: keyBuilder,
    pullRequestCommentsKey: keyBuilder,
    pullRequestCommitsKey: keyBuilder,
    pullRequestFormKey: keyBuilder,
    pullRequestStateKey: keyBuilder,
    pullRequestDueDateKey: keyBuilder,
    pullRequestMergeFormKey: keyBuilder,
    issueCommentFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    issueSubscriptionKey: (...parts: unknown[]) => `subscription|${keyFor(...parts)}`,
    issueTrackedTimesKey: (...parts: unknown[]) => `times|${keyFor(...parts)}`,
    userStopwatchesKey: keyBuilder,
    issueDependenciesKey: (...parts: unknown[]) => `deps|${keyFor(...parts)}`,
    issueReactionsKey: keyBuilder,
  };
});

import PullRequestDetail from '../PullRequestDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoPullRequestCommit } from '../../types/api';
import type { Locale } from '../../i18n';

const state = useAppState() as unknown as Record<string, any>;

const COMMITS_KEY = keyFor('inst-1', 'owner', 'repo', 1);
const DETAIL_KEY = keyFor('inst-1', 'owner', 'repo', 1);

/**
 * The commit section of the pull request detail view once the branch holds a
 * single commit.
 *
 * With one commit the whole-pull-request change tree *is* that commit's diff,
 * and the commit list rendered the same diff again — with a second copy of the
 * tree, inside a one-entry list — directly underneath it. The section states the
 * commit instead: one line with the count, the short sha (the link to the commit
 * on the web) and the subject. Two or more commits keep the list, where the
 * per-commit trees say something the change tree cannot.
 */
function pullRequestDetail() {
  return {
    number: 1,
    title: 'PR 1',
    state: 'open',
    user: { login: 'demo-user' },
    repository: { full_name: 'owner/repo' },
    base: { sha: 'base-sha' },
    head: { sha: 'head-sha-1' },
    merge_base: 'merge-base-sha',
    labels: [],
    assignees: [],
    assets: [],
  };
}

function commit(sha: string, subject: string): ForgejoPullRequestCommit {
  return {
    sha,
    commit: {
      message: `${subject}\n\nthe commit body, which is not part of the subject`,
      author: { name: 'demo-user', date: '2024-01-01T00:00:00Z' },
    },
    html_url: `https://forgejo.example.com/owner/repo/commit/${sha}`,
    files: [{ filename: 'src/a.ts', status: 'modified' }],
    parents: [{ sha: 'parent-sha' }],
  } as unknown as ForgejoPullRequestCommit;
}

async function mountView(locale: Locale = 'en') {
  const router = createTestRouter();
  await router.push({
    name: 'pullRequestDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '1' },
  });
  const wrapper = mount(PullRequestDetail, {
    global: {
      plugins: [router, createTestI18n(locale)],
      stubs: {
        AttachmentList: true,
        CommentTimeline: true,
        DateTimePicker: true,
        // The change tree and each commit's tree are the same component; a stub
        // that marks itself makes "how many trees are on screen" countable.
        DiffFileList: { template: '<div class="diff-tree-stub" />' },
        EasyMdeEditor: true,
        MarkdownBody: true,
        ModalDialog: true,
        PendingAttachmentList: true,
        PullRequestForm: true,
        ReactionBar: true,
      },
    },
  });
  await nextTick();
  return wrapper;
}

function setCommits(commits: ForgejoPullRequestCommit[]) {
  state.pullRequestCommits.value.set(COMMITS_KEY, commits);
}

describe('PullRequestDetail with a single commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.pullRequestCommits.value.clear();
    state.pullRequestDetails.value.clear();
    state.pullRequestComments.value.clear();
    state.pullRequestDetails.value.set(DETAIL_KEY, pullRequestDetail());
    state.pullRequestComments.value.set(keyFor('inst-1', 'owner', 'repo', 1), []);
  });

  it('states the commit on one line instead of listing it with its own tree', async () => {
    setCommits([commit('aaaaaaa1bbbbbbbb', 'the only commit')]);

    const wrapper = await mountView();
    const summary = wrapper.find('.commit-summary');

    expect(summary.exists()).toBe(true);
    expect(summary.text()).toBe('1 commit · aaaaaaa · the only commit');
    // The commit message's body is not the subject.
    expect(summary.text()).not.toContain('the commit body');

    // No commit list, so no second tree: the change tree above is the only one.
    expect(wrapper.findAll('.commit-item')).toHaveLength(0);
    expect(wrapper.findAll('.diff-tree-stub')).toHaveLength(1);
    wrapper.unmount();
  });

  it('links the summary sha to that commit, not to the pull request', async () => {
    setCommits([commit('aaaaaaa1bbbbbbbb', 'the only commit')]);

    const wrapper = await mountView();
    const sha = wrapper.get('.commit-summary-sha');

    expect(sha.text()).toBe('aaaaaaa');
    await sha.trigger('click');

    expect(state.openExternal).toHaveBeenCalledTimes(1);
    expect(state.openExternal).toHaveBeenCalledWith('https://forgejo.example.com/owner/repo/commit/aaaaaaa1bbbbbbbb');
    wrapper.unmount();
  });

  it('renders the summary line in the other language too', async () => {
    setCommits([commit('aaaaaaa1bbbbbbbb', 'the only commit')]);

    const wrapper = await mountView('zh');
    const summary = wrapper.find('.commit-summary');

    expect(summary.text()).toBe('1 个提交 · aaaaaaa · the only commit');
    wrapper.unmount();
  });

  it('keeps the list and its per-commit tree from two commits up', async () => {
    setCommits([commit('aaaaaaa1', 'first commit'), commit('bbbbbbb2', 'second commit')]);

    const wrapper = await mountView();

    expect(wrapper.find('.commit-summary').exists()).toBe(false);
    const items = wrapper.findAll('.commit-item');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain('first commit');
    expect(items[1].text()).toContain('second commit');
    // Only the change tree so far: a commit's tree appears when it is expanded,
    // exactly as before.
    expect(wrapper.findAll('.diff-tree-stub')).toHaveLength(1);

    await items[0].find('.commit-header').trigger('click');
    await nextTick();

    expect(wrapper.findAll('.diff-tree-stub')).toHaveLength(2);
    expect(wrapper.find('.commit-summary').exists()).toBe(false);
    wrapper.unmount();
  });

  it('claims no single commit when the branch has none', async () => {
    setCommits([]);

    const wrapper = await mountView();

    expect(wrapper.find('.commit-summary').exists()).toBe(false);
    expect(wrapper.findAll('.commit-item')).toHaveLength(0);
    expect(wrapper.findAll('.diff-tree-stub')).toHaveLength(1);
    wrapper.unmount();
  });
});
