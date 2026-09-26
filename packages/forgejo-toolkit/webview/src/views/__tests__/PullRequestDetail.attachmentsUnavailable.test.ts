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

const DETAIL_KEY = keyFor('inst-1', 'owner', 'repo', 1);

function pullRequestDetail(extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
}

async function mountView() {
  const router = createTestRouter();
  await router.push({
    name: 'pullRequestDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '1' },
  });
  // AttachmentList is left real: its own notice is what this test is about.
  const wrapper = mount(PullRequestDetail, {
    global: {
      plugins: [router, createTestI18n('en')],
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

function attachmentSection(wrapper: Awaited<ReturnType<typeof mountView>>) {
  return wrapper.findComponent({ name: 'AttachmentList' });
}

/**
 * The host may fail to load a PR's attachment list and reports it as
 * `attachmentsUnavailable` beside the `pullRequestDetail` reply. The detail then
 * reaches the view with an empty `assets` array, so the section used to hide
 * itself entirely — the user saw no attachment area and concluded their
 * attachment had been deleted. The view must pass the flag through so the list
 * can say the lookup failed.
 *
 * The host's own half may not be wired yet, so this test seeds the detail state
 * with the exact contract field it produces (`attachmentsUnavailable`).
 */
describe('PullRequestDetail attachment list availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.pullRequestDetails.value.clear();
    state.pullRequestComments.value.set(DETAIL_KEY, []);
  });

  it('tells the attachment list that the lookup failed', async () => {
    state.pullRequestDetails.value.set(DETAIL_KEY, pullRequestDetail({ assets: [], attachmentsUnavailable: true }));

    const wrapper = await mountView();
    const list = attachmentSection(wrapper);

    expect(list.exists()).toBe(true);
    expect(list.props('attachmentsUnavailable')).toBe(true);
    // An empty list is not the answer here, so the notice has to be on screen.
    expect(wrapper.find('.attachment-unavailable').text()).toContain('could not be loaded');
    wrapper.unmount();
  });

  it('does not claim a failure when the reply carries no flag', async () => {
    state.pullRequestDetails.value.set(DETAIL_KEY, pullRequestDetail());

    const wrapper = await mountView();
    const list = attachmentSection(wrapper);

    expect(list.exists()).toBe(true);
    expect(list.props('attachmentsUnavailable')).toBe(false);
    expect(wrapper.find('.attachment-unavailable').exists()).toBe(false);
    wrapper.unmount();
  });

  it('still lists the attachments when they loaded', async () => {
    state.pullRequestDetails.value.set(DETAIL_KEY, pullRequestDetail({ assets: [{ id: 9, name: 'shot.png' }] }));

    const wrapper = await mountView();

    expect(wrapper.find('.attachment-list').text()).toContain('shot.png');
    expect(wrapper.find('.attachment-unavailable').exists()).toBe(false);
    wrapper.unmount();
  });
});
