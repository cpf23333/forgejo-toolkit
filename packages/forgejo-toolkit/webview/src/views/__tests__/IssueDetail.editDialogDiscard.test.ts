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
import ModalDialog from '../../components/ModalDialog.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as Record<string, any>;

// The editor exposes the two things these tests need: a body the user can type
// into (which marks the form dirty) and the view's image picker, whose upload is
// left in flight by the state mock.
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
  template:
    '<div class="editor-stub"><textarea class="editor-body" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><button type="button" class="pick-image" @click="pickImage">pick</button></div>',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: { assets: { type: Array, default: () => [] } },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

function mountView() {
  return mount(IssueDetail, {
    global: {
      plugins: [createTestI18n('en')],
      // The real modal is mounted on purpose: Esc and × are what Cancel has to
      // match.
      stubs: { EasyMdeEditor: EasyMdeEditorStub, AttachmentList: AttachmentListStub },
    },
  });
}

function editDialog(wrapper: ReturnType<typeof mountView>) {
  return wrapper.findComponent(ModalDialog);
}

/** The edit dialog's form: the comment box renders an editor of its own. */
function editForm(wrapper: ReturnType<typeof mountView>) {
  const form = wrapper.findAll('form').find((candidate) => candidate.classes().includes('issue-form'));
  expect(form, 'edit dialog form').toBeTruthy();
  return form!;
}

function cancelButton(wrapper: ReturnType<typeof mountView>) {
  const button = editForm(wrapper)
    .findAll('vscode-button')
    .find((candidate) => candidate.text().trim() === 'Cancel');
  expect(button, 'Cancel button').toBeTruthy();
  return button!;
}

async function openEditDialog(wrapper: ReturnType<typeof mountView>) {
  (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
  await nextTick();
}

async function typeTitle(wrapper: ReturnType<typeof mountView>, value: string) {
  const field = editForm(wrapper).find('vscode-textfield');
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
  await nextTick();
}

/**
 * Esc and × asked before discarding a typed edit - the dialog publishes its dirty
 * state to the modal through `is-dirty` - but the form's Cancel button emitted
 * `close` directly and threw the edit away without a word. Cancel now routes
 * through the same `common.discardChangesConfirm` prompt, and declining keeps the
 * dialog open.
 */
describe('IssueDetail edit dialog Cancel discard confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.issueDetails.value.clear();
    state.lastSavedIssue.value = undefined;
    state.showConfirm.mockResolvedValue(true);
    state.issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      body: 'original body',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
      assets: [],
    });
    if (typeof HTMLDialogElement !== 'undefined') {
      HTMLDialogElement.prototype.showModal = vi.fn();
      HTMLDialogElement.prototype.close = vi.fn();
    }
  });

  it('asks before Cancel discards a typed edit and stays open when declined', async () => {
    state.showConfirm.mockResolvedValue(false);
    const wrapper = mountView();
    await nextTick();
    await openEditDialog(wrapper);
    await typeTitle(wrapper, 'a renamed issue');
    expect(editDialog(wrapper).props('isDirty')).toBe(true);

    await cancelButton(wrapper).trigger('click');
    await flushPromises();

    expect(state.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(editDialog(wrapper).props('open')).toBe(true);
    wrapper.unmount();
  });

  it('closes once the discard is confirmed', async () => {
    const wrapper = mountView();
    await nextTick();
    await openEditDialog(wrapper);
    await typeTitle(wrapper, 'a renamed issue');

    await cancelButton(wrapper).trigger('click');
    await flushPromises();

    expect(state.showConfirm).toHaveBeenCalledTimes(1);
    expect(editDialog(wrapper).props('open')).toBe(false);
    wrapper.unmount();
  });

  it('closes a clean dialog without asking', async () => {
    const wrapper = mountView();
    await nextTick();
    await openEditDialog(wrapper);

    await cancelButton(wrapper).trigger('click');
    await flushPromises();

    expect(state.showConfirm).not.toHaveBeenCalled();
    expect(editDialog(wrapper).props('open')).toBe(false);
    wrapper.unmount();
  });

  /**
   * Discarding has to discard. The dialog is a native `<dialog>`, so closing it
   * kept its content mounted and the form kept the abandoned draft: reopening the
   * dialog showed the typed title again, already dirty (so every later close
   * asked again), and Save re-applied what the user had just discarded.
   */
  it('reopens on the stored issue after a confirmed discard', async () => {
    const wrapper = mountView();
    await nextTick();
    await openEditDialog(wrapper);
    await typeTitle(wrapper, 'a renamed issue');
    expect(editDialog(wrapper).props('isDirty')).toBe(true);

    await cancelButton(wrapper).trigger('click');
    await flushPromises();
    expect(editDialog(wrapper).props('open')).toBe(false);

    await openEditDialog(wrapper);
    await flushPromises();

    // The form is seeded from the issue again, so the dialog is not dirty and
    // nothing of the discarded edit can be saved.
    expect(editForm(wrapper).find('vscode-textfield').attributes('value')).toBe('an issue');
    expect(editDialog(wrapper).props('isDirty')).toBe(false);

    // ...and the next close does not ask again.
    await cancelButton(wrapper).trigger('click');
    await flushPromises();
    expect(state.showConfirm).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  /**
   * An image upload in flight is unsaved work too: the editor inserts its
   * markdown only when the request returns. The dialog's `loading` deliberately
   * does not cover uploads any more (it used to trap the user in the dialog for
   * up to a minute), so without the upload marking the form dirty, closing
   * dropped the image without asking.
   */
  it('asks before an in-flight image upload is dropped and keeps the dialog open when declined', async () => {
    state.showConfirm.mockResolvedValue(false);
    state.uploadIssueAttachment.mockReturnValue(new Promise(() => {}));
    const wrapper = mountView();
    await nextTick();
    await openEditDialog(wrapper);

    await editForm(wrapper).find('.pick-image').trigger('click');
    await nextTick();
    expect(state.uploadIssueAttachment).toHaveBeenCalledTimes(1);

    // The upload marks the form dirty, which is what the modal's own Esc/× guard
    // reads.
    expect(editDialog(wrapper).props('isDirty')).toBe(true);
    expect(editDialog(wrapper).props('loading')).toBe(false);

    await wrapper.find('.modal-close').trigger('click');
    await flushPromises();

    expect(state.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(editDialog(wrapper).props('open')).toBe(true);
    wrapper.unmount();
  });
});
