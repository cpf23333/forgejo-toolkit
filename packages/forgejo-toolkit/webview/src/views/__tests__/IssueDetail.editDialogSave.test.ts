import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

/**
 * What the issue edit dialog does once the host answers a save.
 *
 * The outcome of an edit is a fact the reader must be able to see: a save that worked
 * closes the dialog it was made in, and a save that failed keeps what was typed and
 * says why (`docs/architecture/state-management.md`). Neither half was pinned before
 * 2026-10-06, which is how "the dialog stays open with no error" shipped: the close hung
 * on a shared ref that a success reply only updated when it happened to carry the parsed
 * issue.
 *
 * The host's own reply branch is covered where the fix lives
 * (`useAppState`'s "the edit dialog's save signal"); this file covers the view half —
 * the watcher that closes on that signal, the ownership guard that keeps a save of
 * *another* issue from closing this dialog, and the failure arm that must never be
 * silent.
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
      issueTriage: { value: false },
      issueTriageLabelsAvailable: { value: true },
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
      suggestIssueTriage: vi.fn(),
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
    // The detail key is what the view seeds `issueDetails`/`errors` with for the page
    // itself; the **form** key is a different string in the real module, and this file
    // depends on that: an error on the edit form must not turn the page into a
    // "Failed to load" pane (which would unmount the dialog under test).
    issueDetailKey: keyBuilder,
    issueFormKey: (...parts: unknown[]) => `form|${keyFor(...parts)}`,
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
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" />',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: { assets: { type: Array, default: () => [] } },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

// jsdom's `<dialog>` has no showModal/close, so the stub exposes the `open` prop this
// file asserts on (the real component turns it into showModal()/close()).
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

const detailKey = keyFor('inst-1', 'owner', 'repo', 5);
/** The edit form's own key — the one an error from a failed save lands on. */
const formKey = `form|${detailKey}`;

/** The edit dialog's own form (the comment box renders an editor of its own). */
function editForm(wrapper: ReturnType<typeof mountView>) {
  const form = wrapper.findAll('form').find((candidate) => candidate.classes().includes('issue-form'));
  expect(form, 'edit dialog form').toBeTruthy();
  return form!;
}

/** Type a title into the form, the way the reader does. */
async function typeTitle(wrapper: ReturnType<typeof mountView>, title: string): Promise<void> {
  const input = editForm(wrapper).find('input');
  (input.element as HTMLInputElement).value = title;
  await input.trigger('input');
  await nextTick();
}

describe('the issue edit dialog after a save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.issueDetails.value.clear();
    state.lastSavedIssue.value = undefined;
    state.issueDetails.value.set(detailKey, {
      number: 5,
      title: 'an issue',
      body: 'original body',
      user: { login: 'demo-user' },
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

    // The reader edits and saves. The form dispatches the edit; the dialog stays open
    // until the host answers.
    await typeTitle(wrapper, 'edited title');
    await wrapper.findComponent(IssueForm).vm.$emit('submit', {
      title: 'edited title',
      body: 'original body',
      labels: [],
      assignees: [],
    });
    await nextTick();
    expect(state.editIssue).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(true);

    // The host accepted the edit: this is the reply's report, and the dialog closes.
    state.lastSavedIssue.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 5 };
    await flushPromises();

    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(false);
    wrapper.unmount();
  });

  it('stays open with what was typed, and shows why, when the save failed', async () => {
    const wrapper = mountView();
    await nextTick();
    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();

    await typeTitle(wrapper, 'edited title');
    await wrapper.findComponent(IssueForm).vm.$emit('submit', {
      title: 'edited title',
      body: 'original body',
      labels: [],
      assignees: [],
    });
    await nextTick();

    // The host refused it: the error lands on this form's own key and the save report
    // never arrives.
    state.errors.set(formKey, 'API down');
    await nextTick();

    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(true);
    // Nothing the reader typed was thrown away, and the reason is on screen.
    expect((editForm(wrapper).find('input').element as HTMLInputElement).value).toBe('edited title');
    expect(wrapper.text()).toContain('API down');
    wrapper.unmount();
  });

  it('does not close for a save that belongs to another issue', async () => {
    // Several detail views stay cached; `lastSavedIssue` is one shared slot. A save of
    // issue #6 must not close the dialog of issue #5.
    const wrapper = mountView();
    await nextTick();
    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();

    state.lastSavedIssue.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 6 };
    await flushPromises();

    expect(wrapper.findComponent(ModalDialogStub).props('open')).toBe(true);
    wrapper.unmount();
  });
});
