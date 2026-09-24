import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';

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

/**
 * The icon-only "copy reference" button carried a `:title` but no accessible
 * name, so screen readers announced an unnamed button. Its pull-request twin
 * already had one; this pins the issue side to the same treatment (the icon
 * element carries no name of its own, so the button has to).
 */
describe('IssueDetail reference copy button', () => {
  function mountView() {
    stateMock.issueDetails.value.set('inst-1|owner|repo|5', {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
      assets: [],
    });
    return mount(IssueDetail, {
      global: {
        plugins: [createTestI18n('en')],
        stubs: { EasyMdeEditor: true, AttachmentList: true },
      },
    });
  }

  it('exposes an accessible name on the copy button', async () => {
    const wrapper = mountView();
    await nextTick();

    // The references panel is the only `.reference-row`; the button inside it
    // renders the icon alone.
    const copyButton = wrapper.get('.reference-row button');
    expect(copyButton.attributes('aria-label')).toBe('Copy Link');
    expect(copyButton.attributes('title')).toBe('Copy Link');
    expect(copyButton.text()).toBe('');

    await copyButton.trigger('click');
    expect(stateMock.copyToClipboard).toHaveBeenCalledWith('owner/repo#5');
    wrapper.unmount();
  });
});
