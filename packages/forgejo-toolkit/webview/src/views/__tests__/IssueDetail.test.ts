import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';

const { routeMock, stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    routeMock: { params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '5' } },
    stateMock: {
      addIssueTime: vi.fn(),
      changeIssueReaction: vi.fn(),
      changeIssueSubscription: vi.fn(),
      copyToClipboard: vi.fn(),
      createIssueComment: vi.fn(),
      createIssueDependency: vi.fn(),
      deleteIssue: vi.fn(),
      deleteIssueAttachment: vi.fn(),
      deleteIssueTime: vi.fn(),
      editIssue: vi.fn(),
      errors: new Map(),
      instances: {
        value: [
          {
            id: 'inst-1',
            url: 'https://forgejo.example.com',
            username: 'demo-user',
            name: 'demo-user@forgejo.example.com',
          },
        ],
      },
      issueDependencies: { value: new Map() },
      issueDetails: { value: new Map() },
      issueReactions: { value: new Map() },
      issueSubscriptions: { value: new Map() },
      issueTrackedTimes: { value: new Map() },
      lastSavedIssue: { value: undefined },
      loadIssueDependencies: vi.fn(),
      loadIssueDetail: vi.fn(),
      loadIssueReactions: vi.fn(),
      loadIssueSubscription: vi.fn(),
      loadIssueTrackedTimes: vi.fn(),
      loadPullRequestComments: vi.fn(),
      loadCommentReactions: vi.fn(),
      commentReactions: { value: new Map() },
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
      renderMarkdown: vi.fn(),
      repoAssignees: { value: new Map() },
      repoIssues: { value: new Map() },
      repoIssuesFetchedAt: { has: () => false, set: () => {}, delete: () => {} },
      repoLabels: { value: new Map() },
      repoMilestones: { value: new Map() },
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

vi.mock('vue-router', () => ({ useRoute: () => routeMock }));

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keys = {
    issueDetailKey: (...parts: unknown[]) => keyFor(...parts),
    commentReactionsKey: (...parts: unknown[]) => keyFor(...parts),
    issueCommentEditFormKey: (...parts: unknown[]) => keyFor(...parts),
    issueFormKey: (...parts: unknown[]) => keyFor(...parts),
    issueCommentFormKey: (...parts: unknown[]) => keyFor(...parts),
    pullRequestCommentsKey: (...parts: unknown[]) => keyFor(...parts),
    repoLabelsKey: (...parts: unknown[]) => keyFor(...parts),
    repoAssigneesKey: (...parts: unknown[]) => keyFor(...parts),
    repoMilestonesKey: (...parts: unknown[]) => keyFor(...parts),
    repoIssuesKey: (...parts: unknown[]) => keyFor(...parts),
    issueSubscriptionKey: (...parts: unknown[]) => keyFor(...parts),
    issueTrackedTimesKey: (...parts: unknown[]) => keyFor(...parts),
    userStopwatchesKey: (...parts: unknown[]) => keyFor(...parts),
    issueDependenciesKey: (...parts: unknown[]) => keyFor(...parts),
    issueReactionsKey: (...parts: unknown[]) => keyFor(...parts),
    issueStateKey: (...parts: unknown[]) => keyFor(...parts),
    issueDueDateKey: (...parts: unknown[]) => keyFor(...parts),
    startWorkKey: (...parts: unknown[]) => keyFor(...parts),
  };
  return { useAppState: () => state, ...keys };
});

import IssueDetail from '../IssueDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

type TestState = Record<string, any>;
const appState = () => useAppState() as unknown as TestState;

function mountView() {
  return mount(IssueDetail, { global: { plugins: [createTestI18n('en')] } });
}

function trackedTimeDeleteButtons(wrapper: ReturnType<typeof mountView>) {
  return wrapper.findAll('.tracked-time-item [name="trash"]');
}

const TIMES_KEY = keyFor('inst-1', 'owner', 'repo', '5');
const STOPWATCH_KEY = keyFor('inst-1');

describe('IssueDetail tracked time panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState().issueTrackedTimes.value.clear();
    appState().userStopwatches.value.clear();
    appState().issueDetails.value.clear();
  });

  it('labels the sum as the issue total for the author and hides foreign rows', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    appState().issueTrackedTimes.value.set(TIMES_KEY, [{ id: 1, time: 600, user_name: 'demo-user' }]);
    const wrapper = mountView();
    await nextTick();
    expect(wrapper.text()).toContain('Total tracked time');
    // The only row belongs to the caller, so it keeps its delete button.
    expect(trackedTimeDeleteButtons(wrapper)).toHaveLength(1);
    wrapper.unmount();
  });

  it('calls the sum personal while only the viewer rows are visible', async () => {
    // The server narrows the list to the caller for non-writers, so the sum may be a
    // subset and must not be presented as the issue total.
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'someone-else' },
    });
    appState().issueTrackedTimes.value.set(TIMES_KEY, [{ id: 1, time: 600, user_name: 'demo-user' }]);
    const wrapper = mountView();
    await nextTick();
    expect(wrapper.text()).toContain('My tracked time');
    expect(wrapper.text()).not.toContain('Total tracked time');
    wrapper.unmount();
  });

  it('hides the delete button for a row belonging to somebody else', async () => {
    // Only the record owner (or a site admin) may delete, so the button is offered
    // for the viewer rows only.
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'someone-else' },
    });
    appState().issueTrackedTimes.value.set(TIMES_KEY, [
      { id: 1, time: 600, user_name: 'demo-user' },
      { id: 2, time: 900, user_name: 'other-user' },
    ]);
    const wrapper = mountView();
    await nextTick();
    expect(trackedTimeDeleteButtons(wrapper)).toHaveLength(1);
    wrapper.unmount();
  });
  it('warns that a timer running elsewhere would be ended', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    appState().userStopwatches.value.set(STOPWATCH_KEY, [
      { repo_owner_name: 'owner', repo_name: 'other-repo', issue_index: 9 },
    ]);
    const wrapper = mountView();
    await nextTick();
    expect(wrapper.text()).toContain('A timer is already running');
    wrapper.unmount();
  });

  it('says when the timeline was cut off at the cap', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    appState().pullRequestComments.value.set(
      keyFor('inst-1', 'owner', 'repo', 5),
      Array.from({ length: 500 }, (_, index) => ({
        id: index + 1,
        type: 'comment',
        body: 'a comment',
        created_at: '2026-01-01T00:00:00Z',
        user: { login: 'demo-user' },
      })),
    );
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.findAll('.list-truncated').length).toBeGreaterThan(0);
    wrapper.unmount();
  });
});
