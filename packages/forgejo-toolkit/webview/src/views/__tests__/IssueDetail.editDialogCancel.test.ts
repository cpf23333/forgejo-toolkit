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
      deleteIssue: vi.fn(),
      deleteIssueAttachment: vi.fn(),
      deleteIssueTime: vi.fn(),
      editIssue: vi.fn(),
      errors: new Map(),
      instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
      issueDependencies: { value: new Map() },
      issueDetails: { value: new Map() },
      issueReactions: { value: new Map() },
      issueSubscriptions: { value: new Map() },
      issueTrackedTimes: { value: new Map() },
      lastSavedIssue: { value: undefined },
      loadCommentReactions: vi.fn(),
      loadIssueDependencies: vi.fn(),
      loadIssueDetail: vi.fn(),
      loadIssueReactions: vi.fn(),
      loadIssueSubscription: vi.fn(),
      loadIssueTrackedTimes: vi.fn(),
      loadPullRequestComments: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoIssues: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadUserStopwatches: vi.fn(),
      loading: new Map(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      pullRequestComments: { value: new Map() },
      removeIssueDependency: vi.fn(),
      renderMarkdown: vi.fn(async () => ''),
      repoAssignees: { value: new Map() },
      repoIssues: { value: new Map() },
      repoIssuesTotalCount: { value: new Map() },
      repoIssuesFetchedAt: { has: () => false, set: () => {}, delete: () => {} },
      repoLabels: { value: new Map() },
      repoMilestones: { value: new Map() },
      showConfirm: vi.fn(async () => true),
      startIssueStopwatch: vi.fn(),
      startWorkOnIssue: vi.fn(),
      stopIssueStopwatch: vi.fn(),
      toggleIssueState: vi.fn(),
      updateIssueDueDate: vi.fn(),
      uploadIssueAttachment: vi.fn(),
      uploadIssueCommentAttachment: vi.fn(),
      userStopwatches: { value: new Map() },
    },
  };
});

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '5' } }),
}));

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    issueDetailKey: keyBuilder,
    issueFormKey: keyBuilder,
    issueCommentFormKey: keyBuilder,
    commentReactionsKey: keyBuilder,
    issueCommentEditFormKey: keyBuilder,
    issueCommentDeleteFormKey: keyBuilder,
    pullRequestCommentsKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    issueSubscriptionKey: keyBuilder,
    issueTrackedTimesKey: keyBuilder,
    userStopwatchesKey: keyBuilder,
    issueDependenciesKey: keyBuilder,
    issueReactionsKey: keyBuilder,
    issueStateKey: keyBuilder,
    issueDueDateKey: keyBuilder,
    startWorkKey: keyBuilder,
  };
});

import IssueDetail from '../IssueDetail.vue';
import IssueForm from '../../components/IssueForm.vue';
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

// jsdom's <dialog> has no showModal/close; the dialog's own state is what these
// tests exercise.
const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: { open: { type: Boolean, default: false } },
  template: '<div class="modal-dialog-stub"><slot /></div>',
});

function mountView() {
  return mount(IssueDetail, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: {
        EasyMdeEditor: EasyMdeEditorStub,
        AttachmentList: AttachmentListStub,
        ModalDialog: ModalDialogStub,
      },
    },
  });
}

/** The edit dialog's form: the comment box renders an editor of its own. */
function editForm(wrapper: ReturnType<typeof mountView>) {
  const form = wrapper.findAll('form').find((candidate) => candidate.classes().includes('issue-form'));
  expect(form, 'edit dialog form').toBeTruthy();
  return form!;
}

function marks(wrapper: ReturnType<typeof mountView>): number[] {
  return (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds;
}

/**
 * A save waits for in-flight image uploads before it dispatches the edit, which
 * takes seconds (or the request timeout). The dialog used to let the user Cancel
 * during that window, and the save then landed anyway — while `closeEdit` wiped
 * the attachments the user had marked for deletion, so the reply had nothing
 * left to delete and nothing reported it.
 */
describe('IssueDetail edit dialog save and cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.issueDetails.value.clear();
    state.lastSavedIssue.value = undefined;
    state.issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      body: 'original body',
      user: { login: 'demo-user' },
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
    const form = editForm(wrapper);
    await form.find('.pick-image').trigger('click');
    await nextTick();
    expect(state.uploadIssueAttachment).toHaveBeenCalledTimes(1);

    // Save, then Cancel while the save is still waiting for the upload. The
    // payload mirrors what IssueForm emits on submit.
    await wrapper.findComponent(IssueForm).vm.$emit('submit', {
      title: 'edited title',
      body: 'edited body',
      labels: [],
      assignees: [],
    });
    await nextTick();
    expect(state.editIssue).not.toHaveBeenCalled();
    wrapper.findComponent(IssueForm).vm.$emit('cancel');
    await nextTick();

    finishUpload?.({ id: 1, uuid: 'uuid-1' });
    await flushPromises();

    // The abandoned edit must not land after the user cancelled it.
    expect(state.editIssue).not.toHaveBeenCalled();
    expect(state.editIssue).toHaveBeenCalledTimes(0);
    wrapper.unmount();
  });

  it('keeps the marked deletions when the dialog is closed before the save reply lands', async () => {
    const wrapper = mountView();
    await nextTick();

    // The user marked an attachment for deletion and closed the dialog while the
    // save was in flight (its reply has not arrived yet).
    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    await nextTick();
    (wrapper.vm as unknown as { closeEdit: () => void }).closeEdit();
    await nextTick();

    // The save reply lands: the marked deletion still has to run.
    state.lastSavedIssue.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 5 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls.map((call: unknown[]) => call.slice(0, 5))).toEqual([
      ['inst-1', 'owner', 'repo', 5, 7],
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
    state.lastSavedIssue.value = undefined;
    await nextTick();

    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();

    expect(marks(wrapper)).toEqual([]);
    wrapper.unmount();
  });
});
