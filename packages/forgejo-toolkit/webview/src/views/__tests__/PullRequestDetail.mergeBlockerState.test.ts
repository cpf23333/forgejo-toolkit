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
      commentReactions: { value: new Map<string, unknown>() },
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
    issueSubscriptionKey: keyBuilder,
    issueTrackedTimesKey: keyBuilder,
    userStopwatchesKey: keyBuilder,
    issueDependenciesKey: keyBuilder,
    issueReactionsKey: keyBuilder,
  };
});

import PullRequestDetail from '../PullRequestDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as Record<string, any>;

function pullRequestDetail(mergeBlockers: unknown[]) {
  return {
    number: 1,
    title: 'PR 1',
    state: 'open',
    user: { login: 'demo-user' },
    repository: { full_name: 'owner/repo' },
    base: { sha: 'base-sha' },
    head: { sha: 'head-sha' },
    merge_base: 'merge-base-sha',
    mergeable: false,
    mergeBlockers,
    labels: [],
    assignees: [],
    assets: [],
  };
}

async function mountView() {
  const router = createTestRouter();
  await router.push({
    name: 'pullRequestDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '1' },
  });
  const wrapper = mount(PullRequestDetail, {
    global: {
      plugins: [router, createTestI18n('en')],
      stubs: {
        AttachmentList: true,
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

/**
 * The merge blocker line printed the raw Forgejo status enum (`failure`,
 * `pending`, `warning`) while the checks panel one screen above translated the
 * very same values through `dashboard.detail.checksState.*`, so one state read
 * differently depending on where the user looked.
 */
describe('PullRequestDetail merge blocker state wording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.pullRequestDetails.value.clear();
  });

  function seed(mergeBlockers: unknown[]) {
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', 1), pullRequestDetail(mergeBlockers));
  }

  it('shows the localized state instead of the raw enum', async () => {
    seed([{ type: 'required_status_checks', statusState: 'failure' }]);

    const wrapper = await mountView();
    const blocker = wrapper.find('.merge-status.blocked');

    expect(blocker.text()).toContain('Required status checks have not passed');
    expect(blocker.text()).toContain('Failed');
    expect(blocker.text()).not.toContain('failure');
    wrapper.unmount();
  });

  it('says the state could not be read instead of printing a dash', async () => {
    // The sibling host fix drops this blocker when the probe failed; if the path
    // still occurs, an absent state must not render as a bare "-".
    seed([{ type: 'required_status_checks' }]);

    const wrapper = await mountView();
    const blocker = wrapper.find('.merge-status.blocked');

    expect(blocker.text()).toContain('the check state could not be read');
    expect(blocker.text()).not.toContain('-');
    wrapper.unmount();
  });

  it('falls back to the neutral wording for a state it has no label for', async () => {
    seed([{ type: 'required_status_checks', statusState: 'queued' }]);

    const wrapper = await mountView();
    const blocker = wrapper.find('.merge-status.blocked');

    expect(blocker.text()).toContain('Unknown');
    expect(blocker.text()).not.toContain('queued');
    wrapper.unmount();
  });

  it('still translates the other blockers', async () => {
    seed([{ type: 'required_approvals', requiredApprovals: 2 }]);

    const wrapper = await mountView();

    expect(wrapper.find('.merge-status.blocked').text()).toContain('2 approval(s) required');
    wrapper.unmount();
  });
});
