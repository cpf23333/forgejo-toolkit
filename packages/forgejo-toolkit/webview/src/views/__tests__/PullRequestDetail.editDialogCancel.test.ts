import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

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

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: '5' } }),
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
    issueSubscriptionKey: keyBuilder,
    issueTrackedTimesKey: keyBuilder,
    userStopwatchesKey: keyBuilder,
    issueDependenciesKey: keyBuilder,
    issueReactionsKey: keyBuilder,
  };
});

import PullRequestDetail from '../PullRequestDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as Record<string, any>;

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  setup(props) {
    function pickImage() {
      props.uploadImage?.(
        new File(['x'], 'shot.png', { type: 'image/png' }),
        () => {},
        () => {},
      );
    }
    return { pickImage };
  },
  template: '<div class="editor-stub"><button type="button" class="pick-image" @click="pickImage">pick</button></div>',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: {
    assets: { type: Array, default: () => [] },
    pendingDeleteIds: { type: Array, default: () => [] },
  },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

// The form's own Cancel button is disabled by its `loading` prop; the stub keeps
// that binding observable while the submit/cancel events stay drivable. It also
// renders the editor with the upload handler the view gave the real form, so the
// edit dialog's image upload path is the one these tests drive (the comment form
// has an editor of its own, outside the dialog).
const PullRequestFormStub = defineComponent({
  name: 'PullRequestForm',
  components: { EasyMdeEditor: EasyMdeEditorStub },
  props: {
    loading: { type: Boolean, default: false },
    mode: { type: String, default: 'edit' },
    uploadImage: { type: Function, default: undefined },
  },
  emits: ['submit', 'cancel', 'dirty'],
  template: '<form class="pull-request-form"><EasyMdeEditor :upload-image="uploadImage" /><slot name="extra" /></form>',
});

// jsdom's <dialog> has no showModal/close; the dialog's own state is what these
// tests exercise.
const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: { open: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
  template: '<div class="modal-dialog-stub"><slot /></div>',
});

function mountView() {
  return mount(PullRequestDetail, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: {
        AttachmentList: AttachmentListStub,
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

function marks(wrapper: ReturnType<typeof mountView>): number[] {
  return (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds;
}

/**
 * The pull request edit dialog had the same Save-then-Cancel defect that was just
 * fixed in `IssueDetail.vue`: a save waits for in-flight image uploads before it
 * dispatches, and the user could cancel during that window - the edit landed
 * anyway, while `closeEdit` wiped the marked deletions the save reply still had
 * to apply.
 */
describe('PullRequestDetail edit dialog save and cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.pullRequestDetails.value.clear();
    state.lastSavedPullRequest.value = undefined;
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repoA', 5), {
      number: 5,
      title: 'a pull request',
      state: 'open',
      user: { login: 'demo-user' },
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      labels: [],
      assignees: [],
      assets: [{ id: 7, uuid: 'uuid-7' }],
    });
  });

  it('does not dispatch the edit when the dialog is cancelled while the upload is in flight', async () => {
    let finishUpload: ((attachment: { id: number; uuid: string }) => void) | undefined;
    state.uploadIssueAttachment.mockReturnValue(
      new Promise<{ id: number; uuid: string }>((resolve) => {
        finishUpload = resolve;
      }),
    );

    const wrapper = mountView();
    await nextTick();
    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();
    // The edit dialog's own editor: the view has a second editor for the comment
    // form, whose upload is tracked separately.
    const editor = wrapper.findComponent({ name: 'ModalDialog' }).findComponent({ name: 'EasyMdeEditor' });
    await editor.find('.pick-image').trigger('click');
    await nextTick();
    expect(state.uploadIssueAttachment).toHaveBeenCalledTimes(1);

    // Save, then Cancel while the save is still waiting for the upload.
    await wrapper.findComponent({ name: 'PullRequestForm' }).vm.$emit('submit', {
      title: 'edited title',
      body: 'edited body',
      base: 'main',
      assignees: [],
      labels: [],
    });
    await nextTick();
    expect(state.editPullRequest).not.toHaveBeenCalled();
    wrapper.findComponent({ name: 'PullRequestForm' }).vm.$emit('cancel');
    await nextTick();

    finishUpload?.({ id: 1, uuid: 'uuid-1' });
    await flushPromises();

    // The abandoned edit must not land after the user cancelled it.
    expect(state.editPullRequest).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps the marked deletions when the dialog is closed before the save reply lands', async () => {
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    await nextTick();
    (wrapper.vm as unknown as { closeEdit: () => void }).closeEdit();
    await nextTick();

    // The save reply lands: the marked deletion still has to run.
    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls.map((call: unknown[]) => call.slice(0, 5))).toEqual([
      ['inst-1', 'owner', 'repoA', 5, 7],
    ]);
    expect(marks(wrapper)).toEqual([]);
    wrapper.unmount();
  });

  it('starts a fresh edit session without the previous session’s marks', async () => {
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    await nextTick();
    (wrapper.vm as unknown as { closeEdit: () => void }).closeEdit();
    await nextTick();
    // A failed save produces no reply at all, so the marks of the abandoned
    // session must not carry over into the next one.
    state.lastSavedPullRequest.value = undefined;
    await nextTick();

    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();

    expect(marks(wrapper)).toEqual([]);
    wrapper.unmount();
  });
});
