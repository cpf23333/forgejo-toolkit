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
    // Also distinct: the detail key is built by the same `keyBuilder`, and the
    // dependency section's error must not be confused with the view's own.
    issueDependenciesKey: (...parts: unknown[]) => `deps|${keyFor(...parts)}`,
    issueReactionsKey: keyBuilder,
  };
});

import PullRequestDetail from '../PullRequestDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as Record<string, any>;

const SUBSCRIPTION_KEY = `subscription|${keyFor('inst-1', 'owner', 'repo', 1)}`;
const TIMES_KEY = `times|${keyFor('inst-1', 'owner', 'repo', 1)}`;
const DEPENDENCIES_KEY = `deps|${keyFor('inst-1', 'owner', 'repo', 1)}`;

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

  // The stopwatch list is instance-wide (`userStopwatchesKey`), so its failure is
  // not the tracked-times one: it used to be read by nothing, and the panel fell
  // back to an empty list — which is what "no timer is running" looks like. The
  // panel then offered Start and dropped the "running elsewhere" hint while a
  // timer really was running.
  it('says the timer state could not be read instead of offering Start', async () => {
    state.errors.set(keyFor('inst-1'), 'network down');

    const wrapper = await mountView();

    expect(wrapper.text()).toContain('Could not read the timer state: network down');
    expect(wrapper.find('.time-tracking-actions').exists()).toBe(false);
    wrapper.unmount();
  });

  it('offers the start action for a successful empty stopwatch load', async () => {
    state.userStopwatches.value.set(keyFor('inst-1'), []);

    const wrapper = await mountView();

    expect(wrapper.find('.time-tracking-actions').text()).toContain('Start timer');
    expect(wrapper.text()).not.toContain('Could not read the timer state');
    wrapper.unmount();
  });

  // Same shape as the issue detail view's dependency section (see
  // IssueDetail.dependencyErrors): the load and the add/remove changes share one
  // error key, and the change wording used to be gated on a non-empty list.
  it('names the change, not the load, for a failed add on a pull request with no dependencies', async () => {
    const wrapper = await mountView();

    (wrapper.vm as unknown as { selectedDependencyNumber: number }).selectedDependencyNumber = 7;
    (wrapper.vm as unknown as { addDependency: () => void }).addDependency();
    await nextTick();

    state.errors.set(DEPENDENCIES_KEY, 'the issue is already a dependency');
    await nextTick();

    expect(wrapper.text()).toContain('Failed to change dependencies: the issue is already a dependency');
    expect(wrapper.text()).not.toContain('Failed to load dependencies');
    wrapper.unmount();
  });

  it('keeps the load wording for a failed dependency load', async () => {
    state.errors.set(DEPENDENCIES_KEY, 'permission denied');

    const wrapper = await mountView();

    expect(wrapper.text()).toContain('Failed to load dependencies: permission denied');
    expect(wrapper.text()).not.toContain('Failed to change dependencies');
    wrapper.unmount();
  });
});

/**
 * `statusChecks.statuses[].target_url` is server data. Rendering it as the
 * anchor's `href` sent the click through the host (which allows http/https only)
 * but left middle-click and the context menu's "open link" following the raw
 * scheme — a `javascript:` target_url was one middle-click away from running.
 */
describe('PullRequestDetail status check links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.pullRequestDetails.value.clear();
    state.pullRequestComments.value.set(keyFor('inst-1', 'owner', 'repo', 1), []);
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', 1), {
      ...pullRequestDetail(1),
      statusChecks: {
        state: 'success',
        statuses: [
          {
            id: 1,
            context: 'ci/build',
            status: 'success',
            description: 'all good',
            target_url: 'https://ci.example.com/runs/1',
          },
        ],
      },
    });
  });

  it('asks the host to open a check instead of linking to its raw URL', async () => {
    const wrapper = await mountView();

    const row = wrapper.get('.checks-list .check-row');
    // No anchor and no href: the server's own scheme is never a navigation
    // target, only an argument to the host's allowlist.
    expect(row.element.tagName.toLowerCase()).toBe('button');
    expect(row.attributes('href')).toBeUndefined();

    await row.trigger('click');
    expect(state.openExternal).toHaveBeenCalledWith('https://ci.example.com/runs/1');
    wrapper.unmount();
  });

  it('keeps a check the server gave no URL for as plain text', async () => {
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', 1), {
      ...pullRequestDetail(1),
      statusChecks: { state: 'success', statuses: [{ id: 2, context: 'ci/docs', status: 'success' }] },
    });

    const wrapper = await mountView();

    const row = wrapper.get('.checks-list .check-row');
    expect(row.element.tagName.toLowerCase()).toBe('div');
    expect(row.text()).toContain('ci/docs');
    wrapper.unmount();
  });
});
