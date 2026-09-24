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
    // Distinct from the tracked-time key: the two panels share the `loading`
    // and `errors` maps, so one key for both would hide which panel is broken.
    issueSubscriptionKey: (...parts: unknown[]) => `subscription|${keyFor(...parts)}`,
    issueTrackedTimesKey: (...parts: unknown[]) => `times|${keyFor(...parts)}`,
    userStopwatchesKey: keyBuilder,
    issueDependenciesKey: keyBuilder,
    issueReactionsKey: keyBuilder,
  };
});

import PullRequestDetail from '../PullRequestDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as Record<string, any>;

const SUBSCRIPTION_KEY = `subscription|${keyFor('inst-1', 'owner', 'repo', 1)}`;
const TIMES_KEY = `times|${keyFor('inst-1', 'owner', 'repo', 1)}`;

function pullRequestDetail(index: number) {
  return {
    number: index,
    title: `PR ${index}`,
    state: 'open',
    user: { login: 'demo-user' },
    repository: { full_name: 'owner/repo' },
    base: { sha: 'base-sha' },
    head: { sha: `head-sha-${index}` },
    merge_base: 'merge-base-sha',
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
 * The subscription and time-tracking panels of a pull request behave exactly
 * like the issue ones: a failed subscription check used to leave a permanent
 * "Loading..." with no error, and a failed time-tracking request left no trace
 * while the manual form cleared itself before the server had answered.
 */
describe('PullRequestDetail sidebar panels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.issueSubscriptions.value.clear();
    state.issueTrackedTimes.value.clear();
    state.userStopwatches.value.clear();
    state.pullRequestDetails.value.clear();
    state.pullRequestComments.value.clear();
    state.pullRequestComments.value.set(keyFor('inst-1', 'owner', 'repo', 1), []);
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', 1), pullRequestDetail(1));
  });

  it('shows a failed subscription check and a retry instead of spinning forever', async () => {
    state.errors.set(SUBSCRIPTION_KEY, 'the check failed');

    const wrapper = await mountView();

    expect(wrapper.find('.subscription-error').text()).toContain('the check failed');
    expect(wrapper.find('.subscription-actions').exists()).toBe(false);

    await wrapper.find('.subscription-error vscode-button').trigger('click');
    expect(state.loadIssueSubscription).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 1, true);
    wrapper.unmount();
  });

  it('offers the subscribe action once the check answered', async () => {
    state.issueSubscriptions.value.set(SUBSCRIPTION_KEY, { subscribed: false });

    const wrapper = await mountView();

    expect(wrapper.find('.subscription-error').exists()).toBe(false);
    expect(wrapper.find('.subscription-actions').text()).toContain('Subscribe');
    wrapper.unmount();
  });

  it('shows a failed time-tracking request instead of dropping it', async () => {
    state.errors.set(TIMES_KEY, 'add time failed');

    const wrapper = await mountView();

    expect(wrapper.find('.time-tracking-error').text()).toContain('add time failed');
    wrapper.unmount();
  });

  it('keeps the typed time until the server accepts it', async () => {
    const wrapper = await mountView();
    const fields = wrapper.findAll('.time-tracking-form vscode-textfield');
    (fields[0].element as HTMLInputElement).value = '2';
    await fields[0].trigger('input');
    await nextTick();

    const addButton = wrapper.find('.time-tracking-form vscode-button');
    await addButton.trigger('click');
    expect(state.addIssueTime).toHaveBeenNthCalledWith(1, 'inst-1', 'owner', 'repo', 1, 7200);

    // Still in flight: the values are still in the form, so pressing Add again
    // re-sends the same time instead of doing nothing.
    await addButton.trigger('click');
    expect(state.addIssueTime).toHaveBeenNthCalledWith(2, 'inst-1', 'owner', 'repo', 1, 7200);

    // Accepted: the form clears.
    state.loading.set(TIMES_KEY, true);
    await nextTick();
    state.loading.set(TIMES_KEY, false);
    await nextTick();
    await addButton.trigger('click');
    expect(state.addIssueTime).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('keeps the typed time and reports the failure when the request fails', async () => {
    const wrapper = await mountView();
    const fields = wrapper.findAll('.time-tracking-form vscode-textfield');
    (fields[1].element as HTMLInputElement).value = '30';
    await fields[1].trigger('input');
    await nextTick();

    const addButton = wrapper.find('.time-tracking-form vscode-button');
    await addButton.trigger('click');

    state.loading.set(TIMES_KEY, true);
    await nextTick();
    state.errors.set(TIMES_KEY, 'add time failed');
    state.loading.set(TIMES_KEY, false);
    await nextTick();

    expect(wrapper.find('.time-tracking-error').text()).toContain('add time failed');
    // The values survived the failure, so the retry needs no retyping.
    await addButton.trigger('click');
    expect(state.addIssueTime).toHaveBeenNthCalledWith(2, 'inst-1', 'owner', 'repo', 1, 1800);
    wrapper.unmount();
  });
});
