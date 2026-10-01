import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';

/**
 * The AI pre-review entry point on the pull request detail page.
 *
 * The feature reads **every changed file and the whole diff**, and its old entry
 * lived in a **file's** context menu, so the offer and the actual scope did not
 * match (see `docs/design/ai-prereview.md`). The decision was to move the entry
 * here and drop the context-menu contribution, which makes three things this
 * suite exists for:
 *
 * 1. the button says what it does — the label names the pull request as the
 *    scope, and the tooltip repeats it with the number of changed files whenever
 *    the view knows it, so "what am I about to send?" is answerable before the
 *    click;
 * 2. it offers nothing while `forgejoToolkit.aiPreReview` is off: the host sends
 *    that boolean in `initialState` and the webview renders it, exactly the way
 *    the debug switch is rendered;
 * 3. **rendering the page runs nothing.** The host coordinates are posted on the
 *    click and nowhere else, so merely opening the page asks no model anything.
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
      // The two fields this suite is about: the switch the host reported, and the
      // dispatch the button makes.
      aiPreReview: { value: false },
      startAiPreReview: vi.fn(),
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

const DETAIL_KEY = keyFor('inst-1', 'owner', 'repo', 1);
/** The changed-file list's own key: base is `merge_base`, head is the head sha. */
const FILES_KEY = keyFor('inst-1', 'owner', 'repo', 1, 'merge-base-sha', 'head-sha-1');

function pullRequestDetail(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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

/** The button, found by the label that names the scope. */
function aiPreReviewButton(wrapper: Awaited<ReturnType<typeof mountView>>) {
  return wrapper.findAll('.header-actions vscode-button').find((button) => button.text().includes('AI pre-review'));
}

describe('the AI pre-review button on the pull request detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.pullRequestDetails.value.clear();
    state.pullRequestFiles.value.clear();
    state.pullRequestComments.value.clear();
    state.pullRequestComments.value.set(DETAIL_KEY, []);
    state.pullRequestDetails.value.set(DETAIL_KEY, pullRequestDetail());
    state.aiPreReview.value = true;
  });

  it('offers a labelled, whole-pull-request action and posts the coordinates it shows', async () => {
    const wrapper = await mountView();

    const button = aiPreReviewButton(wrapper);
    expect(button).toBeDefined();
    // The label is the scope: what the maintainer objected to was an entry that
    // sat in one file's context menu while the run covered the whole pull
    // request, so the wording has to leave no doubt about what is reviewed.
    expect(button?.text()).toContain('AI pre-review (whole PR)');

    await button?.trigger('click');

    expect(state.startAiPreReview).toHaveBeenCalledTimes(1);
    expect(state.startAiPreReview).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 1);
    wrapper.unmount();
  });

  it('states the changed-file count in the tooltip once the view knows it', async () => {
    state.pullRequestFiles.value.set(FILES_KEY, [
      { filename: 'src/index.ts', status: 'modified' },
      { filename: 'src/other.ts', status: 'modified' },
      { filename: 'src/third.ts', status: 'added' },
    ]);

    const wrapper = await mountView();

    const tooltip = aiPreReviewButton(wrapper)?.attributes('title') ?? '';
    expect(tooltip).toContain('whole pull request');
    expect(tooltip).toContain('all 3 changed file(s)');
    wrapper.unmount();
  });

  it('falls back to the pull request’s own count while the file list is still loading', async () => {
    state.pullRequestDetails.value.set(DETAIL_KEY, pullRequestDetail({ changed_files: 5 }));

    const wrapper = await mountView();

    // The list has not answered, so the loaded count would be a "0" the view did
    // not measure; the server's own field is the best it has.
    expect(aiPreReviewButton(wrapper)?.attributes('title')).toContain('all 5 changed file(s)');
    wrapper.unmount();
  });

  it('claims no number it does not know', async () => {
    const wrapper = await mountView();

    const tooltip = aiPreReviewButton(wrapper)?.attributes('title') ?? '';
    // No file list and no server count: the sentence still states the scope, and
    // it does not invent a "0 changed files".
    expect(tooltip).toContain('whole pull request');
    expect(tooltip).not.toContain('changed file(s)');
    wrapper.unmount();
  });

  it('offers nothing while the feature switch is off', async () => {
    state.aiPreReview.value = false;

    const wrapper = await mountView();

    expect(aiPreReviewButton(wrapper)).toBeUndefined();
    // Nothing was dispatched by rendering either way.
    expect(state.startAiPreReview).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('sends nothing by merely rendering the page, switch on or off', async () => {
    const on = await mountView();
    expect(state.startAiPreReview).not.toHaveBeenCalled();
    on.unmount();

    state.aiPreReview.value = false;
    const off = await mountView();
    expect(state.startAiPreReview).not.toHaveBeenCalled();
    off.unmount();
  });
});
