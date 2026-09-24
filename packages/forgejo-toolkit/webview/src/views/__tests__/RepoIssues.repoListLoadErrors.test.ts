import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoIssues: { value: new Map<string, unknown[]>() },
      repoDetails: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      repoRefs: { value: new Map<string, unknown>() },
      pendingNewIssue: { value: undefined },
      loadRepoIssues: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadRepoRefs: vi.fn(),
      changeRepoIssuesState: vi.fn(),
      consumePendingNewIssue: vi.fn(),
      createIssue: vi.fn(),
      editIssue: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      uploadIssueAttachment: vi.fn(),
    },
  };
});

vi.mock('vue-router', () => ({
  useRoute: () => ({
    path: '/repo/inst-1/owner/repoA/issues/open',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', state: 'open' },
  }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    issueFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoRefsKey: keyBuilder,
  };
});

import RepoIssues from '../RepoIssues.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as typeof stateMock;

// The edit/create dialog is rendered for real (`IssueForm` is not stubbed): the
// picker under test is the one the user sees inside it.
const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" :value="modelValue" />',
});

// jsdom's <dialog> has no showModal/close; these tests exercise what the dialog
// renders, not the element's own state.
const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: { open: { type: Boolean, default: false } },
  template: '<div class="modal-dialog-stub"><slot /></div>',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: { assets: { type: Array, default: () => [] }, allowUpload: { type: Boolean, default: false } },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

function mountView() {
  return mount(RepoIssues, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: {
        EasyMdeEditor: EasyMdeEditorStub,
        ModalDialog: ModalDialogStub,
        AttachmentList: AttachmentListStub,
      },
    },
  });
}

/** The create dialog's picker area, or the whole view when no dialog is open. */
function dialogText(wrapper: ReturnType<typeof mountView>): string {
  return wrapper.find('.modal-dialog-stub').text();
}

/**
 * The repository labels/assignees/milestones loads write their failures to the
 * `repoLabels` / `repoAssignees` / `repoMilestones` keys, and no view read them.
 * A failed load therefore rendered an empty picker — indistinguishable from "this
 * repository has none" — and the create/edit form silently offered no choice at
 * all.
 */
describe('RepoIssues repository list load errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.loading.clear();
    state.errors.clear();
    state.repoLabels.value.clear();
    state.repoAssignees.value.clear();
    state.repoMilestones.value.clear();
  });

  it('shows the labels load failure inside the create dialog', async () => {
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { openCreateIssue: () => void }).openCreateIssue();
    await nextTick();

    state.errors.set(keyFor('inst-1', 'owner', 'repoA'), 'permission denied');
    await nextTick();

    const text = dialogText(wrapper);
    expect(text).toContain('Could not load labels: permission denied');
    // The field is still there: hiding it is what read as "this repository has no
    // labels".
    expect(text).toContain('Labels');
    wrapper.unmount();
  });

  it('says nothing about a failed load when the lists loaded', async () => {
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { openCreateIssue: () => void }).openCreateIssue();
    await nextTick();

    state.repoLabels.value.set(keyFor('inst-1', 'owner', 'repoA'), [{ id: 1, name: 'bug' }]);
    await nextTick();

    const text = dialogText(wrapper);
    expect(text).not.toContain('Could not load');
    expect(text).toContain('bug');
    wrapper.unmount();
  });
});
