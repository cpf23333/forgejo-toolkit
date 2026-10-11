import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';

/**
 * The "summarize the discussion" entry point on the **pull request detail page**
 * (`task-26`, `docs/design/notification-summary.md` §4).
 *
 * This page is the one where placement is a decision rather than a formality: its
 * header already offers two AI actions — the whole-pull-request pre-review and the
 * description draft — so a third one up there would leave it unclear whether it
 * reads the diff or the discussion. The action therefore lives with the timeline
 * section, and these tests pin both the placement and the two rules the surface
 * owes: the same `forgejoToolkit.notificationSummary` gate as the notification row
 * (missing reads off), and the coordinates of **this** pull request with
 * `type: 'pull'`.
 */

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
      commentReactions: { value: new Map<string, unknown>() },
      userStopwatches: { value: new Map<string, unknown>() },
      worktrees: { value: [] as unknown[] },
      lastWorktreeCancelled: { value: undefined },
      lastWorktreeError: { value: undefined },
      lastSavedPullRequest: { value: undefined },
      supportsMultiDiff: { value: false },
      // The feature's own two: the switch the action is gated on, and the dispatch
      // it sends. `undefined` is the reading an older host produces.
      notificationSummary: { value: false } as { value: boolean | undefined },
      summarizeNotification: vi.fn(),
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

vi.mock('vue-router', () => ({
  useRoute: () => ({
    name: 'pullRequestDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '1' },
  }),
}));

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
    issueDependenciesKey: keyBuilder,
    issueReactionsKey: keyBuilder,
  };
});

import PullRequestDetail from '../PullRequestDetail.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const DETAIL_KEY = keyFor('inst-1', 'owner', 'repo', 1);

async function mountView() {
  stateMock.pullRequestDetails.value.set(DETAIL_KEY, {
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
  });
  const wrapper = mount(PullRequestDetail, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: {
        CommentTimeline: true,
        CommitDiffList: true,
        DateTimePicker: true,
        DiffFileList: true,
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

beforeEach(() => {
  vi.clearAllMocks();
  stateMock.errors.clear();
  stateMock.loading.clear();
  stateMock.pullRequestDetails.value.clear();
  stateMock.notificationSummary.value = false;
});

describe('PullRequestDetail summarize action', () => {
  it('offers the action beside the timeline when the feature is on, not in the header', async () => {
    stateMock.notificationSummary.value = true;
    const wrapper = await mountView();

    const action = wrapper.get('#pull-request-summary-button');
    expect(action.text()).toBe('Summarize discussion');
    expect(wrapper.get('.section-heading').find('#pull-request-summary-button').exists()).toBe(true);
    expect(wrapper.get('.section-heading').text()).toContain('Comments & Timeline');
    // The header keeps the two diff-level AI surfaces and this action is not one of
    // them: it is not inside the header the pre-review button lives in.
    expect(wrapper.find('.detail-header').exists()).toBe(true);
    expect(wrapper.find('.detail-header #pull-request-summary-button').exists()).toBe(false);
    wrapper.unmount();
  });

  it('hides it, and dispatches nothing, while the feature is off or the host never said', async () => {
    const offWrapper = await mountView();
    expect(offWrapper.find('#pull-request-summary-button').exists()).toBe(false);
    expect(stateMock.summarizeNotification).not.toHaveBeenCalled();
    offWrapper.unmount();

    stateMock.notificationSummary.value = undefined;
    const unknownWrapper = await mountView();
    expect(unknownWrapper.find('#pull-request-summary-button').exists()).toBe(false);
    expect(stateMock.summarizeNotification).not.toHaveBeenCalled();
    unknownWrapper.unmount();
  });

  it('asks the host for this pull request, with type pull', async () => {
    stateMock.notificationSummary.value = true;
    const wrapper = await mountView();

    await wrapper.get('#pull-request-summary-button').trigger('click');

    expect(stateMock.summarizeNotification).toHaveBeenCalledTimes(1);
    expect(stateMock.summarizeNotification).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 1, 'pull');
    wrapper.unmount();
  });
});
