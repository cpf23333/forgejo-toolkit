import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';

/**
 * The "summarize the discussion" entry point on the **issue detail page**
 * (`task-26`, `docs/design/notification-summary.md` §4).
 *
 * The run, the consent gate, the panel and the message all already exist for the
 * notification row; this page adds an entry point and nothing else. So the tests
 * here are about the entry point's own two rules: it is gated on the same
 * `forgejoToolkit.notificationSummary` switch (a missing value reading as off, like
 * the notification row), and it asks the host for **this page's** entity with
 * `type: 'issue'` — the last argument is what tells the host which subject it is
 * summarising, and only this page can supply it.
 *
 * The state is mocked, as in `IssueDetail.copyReference.test.ts`: the page is
 * mounted whole so the action's placement among the real sections is exercised, and
 * the composable is replaced because this test is about a dispatch, not about a
 * load.
 */

const { stateMock } = vi.hoisted(() => ({
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
    // The feature's own two: the switch the action is gated on, and the dispatch it
    // sends. `undefined` is the reading an older host produces.
    notificationSummary: { value: false } as { value: boolean | undefined },
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
    summarizeNotification: vi.fn(),
    toggleIssueState: vi.fn(),
    updateIssueDueDate: vi.fn(),
    uploadIssueAttachment: vi.fn(),
    uploadIssueCommentAttachment: vi.fn(),
    userStopwatches: { value: new Map() },
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '5' } }),
}));

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => parts.join('|');
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
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const DETAIL_KEY = 'inst-1|owner|repo|5';

async function mountView() {
  stateMock.issueDetails.value.set(DETAIL_KEY, {
    number: 5,
    title: 'an issue',
    user: { login: 'demo-user' },
    labels: [],
    assignees: [],
    assets: [],
  });
  const wrapper = mount(IssueDetail, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { CommentTimeline: true, EasyMdeEditor: true, AttachmentList: true },
    },
  });
  await nextTick();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  stateMock.issueDetails.value.clear();
  stateMock.notificationSummary.value = false;
});

describe('IssueDetail summarize action', () => {
  it('offers the action beside the timeline when the feature is on', async () => {
    stateMock.notificationSummary.value = true;
    const wrapper = await mountView();

    const action = wrapper.get('#issue-summary-button');
    expect(action.text()).toBe('Summarize discussion');
    // It belongs to the timeline section, not to the page header: the button is the
    // heading row's own action, above the comments it reads.
    expect(wrapper.get('.section-heading').find('#issue-summary-button').exists()).toBe(true);
    expect(wrapper.get('.section-heading').text()).toContain('Comments & Timeline');
    wrapper.unmount();
  });

  it('hides it, and dispatches nothing, while the feature is off or the host never said', async () => {
    const offWrapper = await mountView();
    expect(offWrapper.find('#issue-summary-button').exists()).toBe(false);
    // Rendering the page with the feature off asks the host for nothing at all.
    expect(stateMock.summarizeNotification).not.toHaveBeenCalled();
    offWrapper.unmount();

    stateMock.notificationSummary.value = undefined;
    const unknownWrapper = await mountView();
    expect(unknownWrapper.find('#issue-summary-button').exists()).toBe(false);
    expect(stateMock.summarizeNotification).not.toHaveBeenCalled();
    unknownWrapper.unmount();
  });

  it('asks the host for this issue, with type issue', async () => {
    stateMock.notificationSummary.value = true;
    const wrapper = await mountView();

    await wrapper.get('#issue-summary-button').trigger('click');

    expect(stateMock.summarizeNotification).toHaveBeenCalledTimes(1);
    expect(stateMock.summarizeNotification).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 5, 'issue');
    wrapper.unmount();
  });
});
