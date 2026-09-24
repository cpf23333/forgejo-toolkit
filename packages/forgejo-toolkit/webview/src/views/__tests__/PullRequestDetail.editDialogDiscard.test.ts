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
      pullRequestComments: { value: new Map() },
      pullRequestCommits: { value: new Map() },
      pullRequestDetails: { value: new Map() },
      pullRequestFiles: { value: new Map() },
      removeIssueDependency: vi.fn(),
      renderMarkdown: vi.fn(async () => ''),
      repoAssignees: { value: new Map() },
      repoDetails: { value: new Map() },
      repoIssues: { value: new Map() },
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
import ModalDialog from '../../components/ModalDialog.vue';
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
  return mount(PullRequestDetail, {
    global: {
      plugins: [createTestI18n('en')],
      // The real edit dialog and the real form are mounted on purpose: Esc/× and
      // the Cancel button are what these tests compare.
      stubs: {
        AttachmentList: AttachmentListStub,
        CollapsibleSection: true,
        CommentTimeline: true,
        CommitDiffList: true,
        DateTimePicker: true,
        DiffFileList: true,
        EasyMdeEditor: EasyMdeEditorStub,
        MarkdownBody: true,
        PendingAttachmentList: true,
        ReactionBar: true,
      },
    },
  });
}

function editDialog(wrapper: ReturnType<typeof mountView>) {
  return wrapper.findComponent(ModalDialog);
}

/** The edit dialog's form: the comment box renders a form of its own. */
function editForm(wrapper: ReturnType<typeof mountView>) {
  const form = wrapper.findAll('form').find((candidate) => candidate.classes().includes('pr-form'));
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
 * Esc and × asked before discarding a typed pull request edit - the dialog
 * publishes its dirty state to the modal through `is-dirty` - but the form's
 * Cancel button emitted `close` directly and threw the edit away without a word.
 * Cancel now routes through the same `common.discardChangesConfirm` prompt, and
 * declining keeps the dialog open.
 */
describe('PullRequestDetail edit dialog Cancel discard confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.pullRequestDetails.value.clear();
    state.lastSavedPullRequest.value = undefined;
    state.showConfirm.mockResolvedValue(true);
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repoA', 5), {
      number: 5,
      title: 'a pull request',
      state: 'open',
      body: 'original body',
      user: { login: 'demo-user' },
      base: { sha: 'base-sha', ref: 'main' },
      head: { sha: 'head-sha', ref: 'feature' },
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
    await typeTitle(wrapper, 'a renamed pull request');
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
    await typeTitle(wrapper, 'a renamed pull request');

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
  it('reopens on the stored pull request after a confirmed discard', async () => {
    const wrapper = mountView();
    await nextTick();
    await openEditDialog(wrapper);
    await typeTitle(wrapper, 'a renamed pull request');
    expect(editDialog(wrapper).props('isDirty')).toBe(true);

    await cancelButton(wrapper).trigger('click');
    await flushPromises();
    expect(editDialog(wrapper).props('open')).toBe(false);

    await openEditDialog(wrapper);
    await flushPromises();

    // The form is seeded from the pull request again, so the dialog is not dirty
    // and nothing of the discarded edit can be saved.
    expect(editForm(wrapper).find('vscode-textfield').attributes('value')).toBe('a pull request');
    expect(editDialog(wrapper).props('isDirty')).toBe(false);

    // ...and the next close does not ask again.
    await cancelButton(wrapper).trigger('click');
    await flushPromises();
    expect(state.showConfirm).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  /**
   * An image upload in flight is unsaved work too: the editor inserts its
   * markdown only when the request returns. `PullRequestForm`'s own dirty output
   * does not count it, so the dialog mirrors the upload here (like
   * `IssueForm` does for the issue dialogs) and closing during one asks.
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

    expect(editDialog(wrapper).props('isDirty')).toBe(true);
    expect(editDialog(wrapper).props('loading')).toBe(false);

    await wrapper.find('.modal-close').trigger('click');
    await flushPromises();

    expect(state.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(editDialog(wrapper).props('open')).toBe(true);
    wrapper.unmount();
  });
});
