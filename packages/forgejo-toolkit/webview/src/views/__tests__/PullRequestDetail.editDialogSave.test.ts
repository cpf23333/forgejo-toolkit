import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

/**
 * The pull request half of "after a save the edit dialog says so".
 *
 * The issue and pull request edit dialogs are **two view components**, not one: each
 * owns its own `isEditing` and its own watcher, over `lastSavedIssue` and
 * `lastSavedPullRequest` respectively. What they share is the composable that produces
 * those signals, and that is where the defect and its fix live
 * (`useAppState`'s "the edit dialog's save signal") — so one fix covers both, and each
 * view half is pinned here and in `IssueDetail.editDialogSave.test.ts`.
 */

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      addIssueTime: vi.fn(),
      changeIssueReaction: vi.fn(),
      changeIssueSubscription: vi.fn(),
      commentReactions: { value: new Map() },
      copyToClipboard: vi.fn(),
      createIssueComment: vi.fn(),
      createIssueDependency: vi.fn(),
      deleteIssueAttachment: vi.fn(),
      deleteIssueTime: vi.fn(),
      editPullRequest: vi.fn(),
      errors: new Map(),
      instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
      issueDependencies: { value: new Map() },
      issueReactions: { value: new Map() },
      issueSubscriptions: { value: new Map() },
      issueTrackedTimes: { value: new Map() },
      lastSavedPullRequest: { value: undefined },
      lastWorktreeCancelled: { value: undefined },
      lastWorktreeError: { value: undefined },
      loadCommentReactions: vi.fn(),
      loadIssueDependencies: vi.fn(),
      loadIssueReactions: vi.fn(),
      loadIssueSubscription: vi.fn(),
      loadIssueTrackedTimes: vi.fn(),
      loadPullRequestComments: vi.fn(),
      loadPullRequestCommits: vi.fn(),
      loadPullRequestDetail: vi.fn(),
      loadPullRequestFiles: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoIssues: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadUserStopwatches: vi.fn(),
      loading: new Map(),
      mergePullRequest: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      openPrWorktree: vi.fn(),
      openPullRequestDiff: vi.fn(),
      openSelectedPullRequestDiffs: vi.fn(),
      aiPreReview: { value: false },
      prDescription: { value: false },
      pullRequestComments: { value: new Map() },
      pullRequestCommits: { value: new Map() },
      pullRequestDetails: { value: new Map() },
      pullRequestFiles: { value: new Map() },
      removeIssueDependency: vi.fn(),
      renderMarkdown: vi.fn(async () => ''),
      repoAssignees: { value: new Map() },
      repoDetails: { value: new Map() },
      repoIssues: { value: new Map() },
      repoIssuesTotalCount: { value: new Map() },
      repoIssuesFetchedAt: { has: () => false, set: () => {}, delete: () => {} },
      repoLabels: { value: new Map() },
      repoMilestones: { value: new Map() },
      revertMergeCommit: vi.fn(),
      showConfirm: vi.fn(async () => true),
      startIssueStopwatch: vi.fn(),
      stopIssueStopwatch: vi.fn(),
      supportsMultiDiff: { value: false },
      togglePullRequestState: vi.fn(),
      updatePullRequestDueDate: vi.fn(),
      uploadIssueAttachment: vi.fn(),
      uploadIssueCommentAttachment: vi.fn(),
      userStopwatches: { value: new Map() },
      worktrees: { value: [] },
    },
  };
});

vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  // A **reactive** route, because the rule under test is what happens when it moves:
  // this view is reused across pull request routes (`<keep-alive>` keys by component
  // type), so the identity it owns has to follow this route while it is the live one.
  const params = makeReactive({ instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: '5' });
  return {
    useRoute: () => ({ params, name: 'pullRequestDetail' }),
    __params: params,
  };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    // The detail key seeds the page; the **form** key is a different string in the real
    // module, and this file depends on that: an error on the edit form must not turn the
    // page into a "Failed to load" pane, which would unmount the dialog under test.
    pullRequestDetailKey: keyBuilder,
    pullRequestFormKey: (...parts: unknown[]) => `form|${keyFor(...parts)}`,
    pullRequestFilesKey: keyBuilder,
    pullRequestCommentsKey: keyBuilder,
    pullRequestCommitsKey: keyBuilder,
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
import * as routerModule from 'vue-router';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as Record<string, any>;

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  template: '<div class="editor-stub" />',
});

/**
 * The form is stubbed (the cancel suite's stub), and it exposes its own `error` prop so
 * this file can see that a failed save reached the form rather than the page.
 */
const PullRequestFormStub = defineComponent({
  name: 'PullRequestForm',
  props: {
    loading: { type: Boolean, default: false },
    mode: { type: String, default: 'edit' },
    error: { type: String, default: '' },
  },
  emits: ['submit', 'cancel', 'dirty'],
  template:
    '<form class="pull-request-form"><span class="form-error-stub">{{ error }}</span><slot name="extra" /></form>',
});

const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: {
    open: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    title: { type: String, default: '' },
    isDirty: { type: Boolean, default: false },
    confirmCloseIfDirty: { type: Boolean, default: false },
  },
  emits: ['close'],
  template: '<div class="modal-dialog-stub"><slot /></div>',
});

function mountView() {
  return mount(PullRequestDetail, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: {
        AttachmentList: true,
        CollapsibleSection: true,
        CommentTimeline: true,
        CommitDiffList: true,
        DateTimePicker: true,
        DiffFileList: true,
        EasyMdeEditor: EasyMdeEditorStub,
        MarkdownBody: true,
        ModalDialog: ModalDialogStub,
        PendingAttachmentList: true,
        PullRequestForm: PullRequestFormStub,
        ReactionBar: true,
      },
    },
  });
}

const detailKey = keyFor('inst-1', 'owner', 'repoA', 5);
/** The edit form's own key — the one an error from a failed save lands on. */
const formKey = `form|${detailKey}`;
/** The live route's params: moving them is what a navigation does to this view. */
const routeParams = (routerModule as unknown as { __params: Record<string, string> }).__params;

describe('the pull request edit dialog after a save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The route is the view's own again: a test that moved it (the identity rule) must
    // not leak that move into the next one.
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    routeParams.index = '5';
    state.errors.clear();
    state.loading.clear();
    state.pullRequestDetails.value.clear();
    state.lastSavedPullRequest.value = undefined;
    state.pullRequestDetails.value.set(detailKey, {
      number: 5,
      title: 'a pull request',
      state: 'open',
      user: { login: 'demo-user' },
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      labels: [],
      assignees: [],
      assets: [],
    });
  });

  it('closes when the host reports the save', async () => {
    const wrapper = mountView();
    await nextTick();
    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();
    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(true);

    await wrapper.findComponent(PullRequestFormStub).vm.$emit('submit', {
      title: 'edited title',
      body: 'edited body',
      base: 'main',
      labels: [],
      assignees: [],
    });
    await nextTick();
    expect(state.editPullRequest).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(true);

    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(false);
    wrapper.unmount();
  });

  it('stays open and shows why when the save failed', async () => {
    const wrapper = mountView();
    await nextTick();
    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();

    await wrapper.findComponent(PullRequestFormStub).vm.$emit('submit', {
      title: 'edited title',
      body: 'edited body',
      base: 'main',
      labels: [],
      assignees: [],
    });
    await nextTick();

    state.errors.set(formKey, 'API down');
    await nextTick();

    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(true);
    expect(wrapper.find('.form-error-stub').text()).toContain('API down');
    wrapper.unmount();
  });

  it('closes and re-reads the pull request on screen when the route moved before the save', async () => {
    // The same identity rule as the issue surface, which is where it was walked live:
    // `<keep-alive>` caches by component type, so **one** instance serves every pull
    // request route. A save dispatched after the route moved is a save of the pull
    // request now on screen, and its reply has to close the dialog and re-read that one.
    const wrapper = mountView();
    await nextTick();
    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();

    routeParams.repo = 'repoB';
    routeParams.index = '6';
    await nextTick();
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repoB', 6), {
      number: 6,
      title: 'the pull request on screen now',
      state: 'open',
      user: { login: 'demo-user' },
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      labels: [],
      assignees: [],
      assets: [],
    });
    await nextTick();
    await wrapper.findComponent(PullRequestFormStub).vm.$emit('submit', {
      title: 'edited title',
      body: 'edited body',
      base: 'main',
      labels: [],
      assignees: [],
    });
    await nextTick();
    expect(state.editPullRequest).toHaveBeenCalledTimes(1);

    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoB', index: 6 };
    await flushPromises();

    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(false);
    expect(state.loadPullRequestDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoB', 6, true);
    wrapper.unmount();
  });

  it('never applies the edit session’s marked deletions to the pull request the route moved to', async () => {
    // The marks belong to the session that made them: this instance was created for
    // `repoA#5`, the route moved to `repoB#6` where the reader opened an edit and marked
    // an attachment, and the route came back to #5. The report for #5 is owned, but #6's
    // mark must not be deleted from it.
    const wrapper = mountView();
    await nextTick();

    routeParams.repo = 'repoB';
    routeParams.index = '6';
    await nextTick();
    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();
    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    await nextTick();

    routeParams.repo = 'repoA';
    routeParams.index = '5';
    await nextTick();
    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls).toEqual([]);
    expect((wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds).toEqual([7]);
    wrapper.unmount();
  });
});
