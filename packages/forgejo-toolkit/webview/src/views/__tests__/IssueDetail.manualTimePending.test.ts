import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
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
      errors: new Map<string, string>(),
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
      loading: new Map<string, boolean>(),
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
    // Distinct from the detail key: the two share the `loading` map, and one key
    // for both would make a tracked-time request read as the whole view loading.
    issueTrackedTimesKey: (...parts: unknown[]) => `times|${keyFor(...parts)}`,
    userStopwatchesKey: keyBuilder,
    issueDependenciesKey: keyBuilder,
    issueReactionsKey: keyBuilder,
    issueStateKey: keyBuilder,
    issueDueDateKey: keyBuilder,
    startWorkKey: keyBuilder,
  };
});

import IssueDetail from '../IssueDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as typeof stateMock;
const DETAIL_KEY = keyFor('inst-1', 'owner', 'repo', 5);
const TIMES_KEY = `times|${keyFor('inst-1', 'owner', 'repo', 5)}`;

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" :value="modelValue" />',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: { assets: { type: Array, default: () => [] } },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

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

/**
 * The manual-time form shares its loading/error key with the other tracked-time
 * operations (stopwatch start/stop, delete, reset). A failed add left the
 * form's pending mark set, so the next settle of that key — say a successful
 * stopwatch stop — read as the add's success and cleared the values the user
 * had re-typed for the retry.
 */
describe('IssueDetail manual time pending mark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.userStopwatches.value.clear();
    state.issueDetails.value.clear();
    state.issueDetails.value.set(DETAIL_KEY, {
      number: 5,
      title: 'an issue',
      body: 'a body',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
    });
  });

  it('does not clear re-typed values when an unrelated time operation settles after a failed add', async () => {
    const wrapper = mountView();
    await nextTick();
    const fields = wrapper.findAll('.time-tracking-form vscode-textfield');
    (fields[1].element as HTMLInputElement).value = '30';
    await fields[1].trigger('input');
    await nextTick();

    const addButton = wrapper.find('.time-tracking-form vscode-button');
    await addButton.trigger('click');
    expect(state.addIssueTime).toHaveBeenCalledTimes(1);

    // The add failed: the values stay for a retry and the error is shown.
    state.loading.set(TIMES_KEY, true);
    await nextTick();
    state.errors.set(TIMES_KEY, 'add time failed');
    state.loading.set(TIMES_KEY, false);
    await nextTick();

    // The user adjusts the values for the retry...
    (fields[1].element as HTMLInputElement).value = '45';
    await fields[1].trigger('input');
    await nextTick();

    // ...and an unrelated operation on the same key (a stopwatch start/stop
    // reloads the tracked times) settles cleanly. That settle is not the failed
    // add's success: it must not clear what the user just typed.
    state.errors.delete(TIMES_KEY);
    state.loading.set(TIMES_KEY, true);
    await nextTick();
    state.loading.set(TIMES_KEY, false);
    await nextTick();

    await addButton.trigger('click');
    expect(state.addIssueTime).toHaveBeenNthCalledWith(2, 'inst-1', 'owner', 'repo', 5, 45 * 60);
    wrapper.unmount();
  });
});
