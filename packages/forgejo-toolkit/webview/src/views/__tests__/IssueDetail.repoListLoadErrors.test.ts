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
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as typeof stateMock;
const DETAIL_KEY = keyFor('inst-1', 'owner', 'repo', 5);
const REPO_LIST_KEY = keyFor('inst-1', 'owner', 'repo');

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
 * The issue edit dialog's pickers are fed by `loadRepoLabels`/`assignees`/
 * `milestones`, whose failures land on their own keys. The dialog rendered empty
 * pickers for a failure — the same view as a repository that has none of them —
 * so the failure is surfaced at the control that depends on the list.
 */
describe('IssueDetail edit dialog repository list load errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
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

  it('names each list whose load failed inside the edit dialog', async () => {
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();

    state.errors.set(REPO_LIST_KEY, 'permission denied');
    await nextTick();

    const text = wrapper.find('.modal-dialog-stub').text();
    expect(text).toContain('Could not load labels: permission denied');
    expect(text).toContain('Could not load assignees: permission denied');
    expect(text).toContain('Could not load milestones: permission denied');
    wrapper.unmount();
  });

  it('keeps the pickers silent when the lists loaded', async () => {
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { openEdit: () => void }).openEdit();
    await nextTick();

    state.repoLabels.value.set(REPO_LIST_KEY, [{ id: 1, name: 'bug' }]);
    await nextTick();

    const text = wrapper.find('.modal-dialog-stub').text();
    expect(text).not.toContain('Could not load');
    expect(text).toContain('bug');
    wrapper.unmount();
  });
});
