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
const STOPWATCHES_KEY = keyFor('inst-1');

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
 * `getUserStopwatches` answers on the instance-wide `userStopwatchesKey`, and its
 * failure was read by nothing. After a failure the time-tracking area fell back
 * to an empty stopwatch list, which is exactly what "no timer is running" looks
 * like: it offered "Start timer" and dropped the "a timer is running elsewhere"
 * hint while one really was running, inviting a second start (which ends the
 * first). The area now says the state could not be read and offers no start/stop
 * until it can.
 */
describe('IssueDetail stopwatch load error', () => {
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

  it('says the timer state could not be read instead of claiming no timer is running', async () => {
    state.errors.set(STOPWATCHES_KEY, 'network down');

    const wrapper = mountView();
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('Could not read the timer state: network down');
    // The false state: an unknown stopwatch list must not be presented as "no
    // timer is running here".
    expect(text).not.toContain('Start timer');
    wrapper.unmount();
  });

  it('keeps the start control for a successful empty load', async () => {
    state.userStopwatches.value.set(STOPWATCHES_KEY, []);

    const wrapper = mountView();
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('Start timer');
    expect(text).not.toContain('Could not read the timer state');
    wrapper.unmount();
  });

  it('keeps showing the timer running elsewhere for a successful load', async () => {
    state.userStopwatches.value.set(STOPWATCHES_KEY, [
      { id: 1, repo_owner_name: 'owner', repo_name: 'other-repo', issue_index: 9 },
    ]);

    const wrapper = mountView();
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('A timer is already running on other-repo#9');
    expect(text).toContain('Start timer');
    expect(text).not.toContain('Could not read the timer state');
    wrapper.unmount();
  });
});
