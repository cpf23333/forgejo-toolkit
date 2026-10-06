import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

/**
 * The issue detail page's triage surface: the control's visibility, the suggestions
 * it displays, and the one path that can lead to a write.
 *
 * The host owns the model, the prompt scope and the consent question, so everything
 * asserted here is the page's own half — and the important half is what it does
 * **not** do: applying opens the existing edit form, and the save is the only call
 * that reaches `editIssue`.
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
      issueTrackedTimes: { value: new Map() },
      issueTriage: { value: false },
      issueTriageLabelsAvailable: { value: true },
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

// jsdom's <dialog> has no showModal/close; the dialog's own state is what this suite
// exercises, and the form inside it has to stay mounted to be found.
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

/** The issue the view renders: authored by the current user, so it can be managed. */
function seedDetail(): void {
  state.issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
    number: 5,
    title: 'an issue',
    body: 'original body',
    user: { login: 'demo-user' },
    labels: [],
    assignees: [],
    assets: [],
  });
}

const SUGGESTIONS = {
  labels: [{ id: 11, name: 'bug', color: 'ff0000' }],
  dropped: [{ reason: 'label-not-in-repository', count: 2 }],
  servedBy: 'transport=vscode.lm, provider="copilot", model=GPT-4o',
  scope: 'issue-only',
};

describe('IssueDetail label suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.issueDetails.value.clear();
    state.lastSavedIssue.value = undefined;
    state.issueTriage.value = false;
    state.issueTriageLabelsAvailable.value = true;
    seedDetail();
  });

  it('offers the control only while the host reports the feature on', async () => {
    const off = mountView();
    await nextTick();
    expect(off.find('#issue-triage-button').exists()).toBe(false);
    off.unmount();

    state.issueTriage.value = true;
    const on = mountView();
    await nextTick();
    expect(on.find('#issue-triage-button').exists()).toBe(true);
    on.unmount();
  });

  it('offers nothing at all for a repository that declares no label', async () => {
    // §3.2: the host reads the repository's label list when the issue view opens and
    // pushes the answer, and the page must not offer an action whose only outcome would
    // be the run's own refusal. An *unknown* answer keeps offering it — a missing value
    // is not evidence that there is nothing to suggest.
    state.issueTriage.value = true;
    state.issueTriageLabelsAvailable.value = false;
    const hidden = mountView();
    await nextTick();
    expect(hidden.find('#issue-triage-button').exists()).toBe(false);
    hidden.unmount();

    state.issueTriageLabelsAvailable.value = undefined;
    const unknown = mountView();
    await nextTick();
    expect(unknown.find('#issue-triage-button').exists()).toBe(true);
    unknown.unmount();
  });

  it('asks the host for suggestions and shows every one of them unticked', async () => {
    state.issueTriage.value = true;
    state.suggestIssueTriage.mockResolvedValue(SUGGESTIONS);
    const wrapper = mountView();
    await nextTick();

    await wrapper.find('#issue-triage-button').trigger('click');
    await flushPromises();
    await nextTick();

    expect(state.suggestIssueTriage).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 5);
    const boxes = wrapper.findAll('.triage-item input[type="checkbox"]');
    expect(boxes).toHaveLength(1);
    expect(boxes.every((box) => (box.element as HTMLInputElement).checked)).toBe(false);
    expect(wrapper.text()).toContain('bug');
    // What the run refused is stated, not hidden.
    expect(wrapper.text()).toContain('no label this repository has goes by that name');
    wrapper.unmount();
  });

  it('reports the host sentence when the run fails, and shows nothing else', async () => {
    state.issueTriage.value = true;
    state.suggestIssueTriage.mockRejectedValue(new Error('the repository labels could not be read'));
    const wrapper = mountView();
    await nextTick();

    await wrapper.find('#issue-triage-button').trigger('click');
    await flushPromises();
    await nextTick();

    expect(wrapper.text()).toContain('the repository labels could not be read');
    expect(wrapper.find('.triage-item').exists()).toBe(false);
    wrapper.unmount();
  });

  it('seeds the edit form with the ticked labels, and the save is the only write', async () => {
    state.issueTriage.value = true;
    state.suggestIssueTriage.mockResolvedValue(SUGGESTIONS);
    const wrapper = mountView();
    await nextTick();
    await wrapper.find('#issue-triage-button').trigger('click');
    await flushPromises();
    await nextTick();

    const labelBox = wrapper.findAll('.triage-item input[type="checkbox"]')[0];
    (labelBox.element as HTMLInputElement).checked = true;
    await labelBox.trigger('change');

    await wrapper.find('#apply-triage-suggestions').trigger('click');
    await nextTick();

    const form = wrapper.findComponent(IssueForm);
    expect(form.props('initialLabelIds')).toEqual([11]);
    // The assignee field is untouched: this feature says nothing about who should own
    // the issue, so the form starts from the issue's own assignees and no seed.
    expect(form.props('initialAssignees')).toEqual([]);
    // Applying opened the form; nothing has been written.
    expect(state.editIssue).not.toHaveBeenCalled();

    form.vm.$emit('submit', { title: 'an issue', body: 'original body', labels: [11], assignees: [] });
    await flushPromises();

    // One write, through the existing edit path, with what the form held.
    expect(state.editIssue).toHaveBeenCalledTimes(1);
    expect(state.editIssue.mock.calls[0]?.slice(0, 4)).toEqual(['inst-1', 'owner', 'repo', 5]);
    expect(state.editIssue.mock.calls[0]?.[4]).toMatchObject({ labels: [11], assignees: [] });
    wrapper.unmount();
  });

  it('drops the suggestions without opening anything when dismissed', async () => {
    state.issueTriage.value = true;
    state.suggestIssueTriage.mockResolvedValue(SUGGESTIONS);
    const wrapper = mountView();
    await nextTick();
    await wrapper.find('#issue-triage-button').trigger('click');
    await flushPromises();
    await nextTick();

    await wrapper
      .findAll('vscode-button')
      .find((button) => button.text().includes('Dismiss'))
      ?.trigger('click');
    await nextTick();

    expect(wrapper.find('.triage-item').exists()).toBe(false);
    expect(state.editIssue).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
