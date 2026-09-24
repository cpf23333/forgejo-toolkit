import { describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, reactive } from 'vue';
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

// The reactive proxy the view reads: mutating the raw mock object would not
// notify the watchers under test.
const state = useAppState() as unknown as {
  pullRequestDetails: { value: Map<string, unknown> };
  worktrees: { value: unknown[] };
  lastWorktreeCancelled: { value: unknown };
  lastWorktreeError: { value: unknown };
  openPrWorktree: ReturnType<typeof vi.fn>;
};

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

// Every PR route gets its own keep-alive entry in App.vue (the key is the full
// route path), so a PR the user navigated away from stays mounted but
// deactivated while another one is shown.
const Host = defineComponent({
  components: { PullRequestDetail },
  props: { show: { type: Boolean, default: true } },
  template: '<KeepAlive><PullRequestDetail v-if="show" /></KeepAlive>',
});

function mountHost(router: ReturnType<typeof createTestRouter>) {
  return mount(Host, {
    global: {
      plugins: [router, createTestI18n('en')],
      stubs: {
        AttachmentList: true,
        CollapsibleSection: true,
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
}

function worktreeButton(wrapper: ReturnType<typeof mountHost>) {
  // open / copy / worktree
  return wrapper.findAll('.actions .action-link')[2];
}

async function openPullRequestRoute(router: ReturnType<typeof createTestRouter>, index: number): Promise<void> {
  await router.push({
    name: 'pullRequestDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: String(index) },
  });
}

describe('PullRequestDetail worktree loading', () => {
  function worktreeButtonIn(wrapper: ReturnType<typeof mountHost>) {
    // open / copy / worktree
    return wrapper.findAll('.actions .action-link')[2];
  }

  it('keeps the spinner of another PR when a different PR is cancelled', async () => {
    state.openPrWorktree.mockClear();
    state.pullRequestDetails.value.clear();
    state.worktrees.value = [];
    state.lastWorktreeCancelled.value = undefined;
    state.lastWorktreeError.value = undefined;
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', '1'), pullRequestDetail(1));
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', '2'), pullRequestDetail(2));

    // PR 1's view is still waiting for its own reply when the user leaves it.
    const routerA = createTestRouter();
    await openPullRequestRoute(routerA, 1);
    const wrapperA = mountHost(routerA);
    await nextTick();
    await worktreeButtonIn(wrapperA).trigger('click');
    expect(state.openPrWorktree).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 1);
    expect(worktreeButtonIn(wrapperA).attributes('disabled')).toBeDefined();

    // PR 2's view starts its own open in the meantime.
    const routerB = createTestRouter();
    await openPullRequestRoute(routerB, 2);
    const wrapperB = mountHost(routerB);
    await nextTick();
    await worktreeButtonIn(wrapperB).trigger('click');
    expect(state.openPrWorktree).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 2);
    expect(worktreeButtonIn(wrapperB).attributes('disabled')).toBeDefined();

    // The host declines the confirmation for PR 1: the reply names a PR PR 2's
    // view never asked about, so its spinner must keep waiting for its own.
    state.lastWorktreeCancelled.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 1 };
    await nextTick();
    expect(worktreeButtonIn(wrapperB).attributes('disabled')).toBeDefined();

    // PR 2's own opened reply then ends its wait.
    state.worktrees.value = [
      ...state.worktrees.value,
      { id: 'wt-2', kind: 'pr', instanceId: 'inst-1', owner: 'owner', repo: 'repo', prIndex: 2 },
    ];
    await nextTick();
    expect(worktreeButtonIn(wrapperB).attributes('disabled')).toBeUndefined();
    expect(wrapperB.text()).toContain('Worktree opened');

    // PR 1's own cancel ended its wait while it was off screen.
    wrapperA.unmount();
    wrapperB.unmount();
  });

  it('stops the spinner for a result that belongs to a PR the view left behind', async () => {
    state.pullRequestDetails.value.clear();
    state.worktrees.value = [];
    state.lastWorktreeCancelled.value = undefined;
    state.lastWorktreeError.value = undefined;

    const router = createTestRouter();
    await openPullRequestRoute(router, 1);
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', '1'), pullRequestDetail(1));

    const wrapper = mountHost(router);
    await nextTick();
    expect(worktreeButton(wrapper).attributes('disabled')).toBeUndefined();

    await worktreeButton(wrapper).trigger('click');
    expect(state.openPrWorktree).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 1);
    expect(worktreeButton(wrapper).attributes('disabled')).toBeDefined();

    // The user opens another PR while the worktree is still being prepared.
    wrapper.setProps({ show: false });
    await nextTick();
    await openPullRequestRoute(router, 2);
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', '2'), pullRequestDetail(2));
    await nextTick();

    // The host fails the open for PR 1, which this (cached) view owns, not for
    // the PR the route currently points at.
    state.lastWorktreeError.value = {
      operation: 'open',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 1,
      error: 'worktree boom',
    };
    await nextTick();

    // Returning to PR 1, the button must not be stuck spinning for the session.
    await openPullRequestRoute(router, 1);
    wrapper.setProps({ show: true });
    await nextTick();

    expect(worktreeButton(wrapper).attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).toContain('worktree boom');
    wrapper.unmount();
  });

  it('clears the spinner and reports the error for the active PR', async () => {
    state.pullRequestDetails.value.clear();
    state.worktrees.value = [];
    state.lastWorktreeCancelled.value = undefined;
    state.lastWorktreeError.value = undefined;

    const router = createTestRouter();
    await openPullRequestRoute(router, 3);
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', '3'), pullRequestDetail(3));

    const wrapper = mountHost(router);
    await nextTick();
    await worktreeButton(wrapper).trigger('click');
    expect(worktreeButton(wrapper).attributes('disabled')).toBeDefined();

    state.lastWorktreeError.value = {
      operation: 'open',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 3,
      error: 'worktree boom',
    };
    await nextTick();

    expect(worktreeButton(wrapper).attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).toContain('worktree boom');
    wrapper.unmount();
  });
});
