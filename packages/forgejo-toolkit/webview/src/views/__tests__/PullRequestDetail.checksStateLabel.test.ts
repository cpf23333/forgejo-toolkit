import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      pullRequestDetails: { value: new Map<string, unknown>() },
      pullRequestFiles: { value: new Map<string, unknown>() },
      pullRequestComments: { value: new Map<string, unknown>() },
      pullRequestCommits: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      repoDetails: { value: new Map<string, unknown>() },
      repoIssues: { value: new Map<string, unknown[]>() },
      repoIssuesTotalCount: { value: new Map() },
      repoIssuesFetchedAt: { has: () => false },
      issueSubscriptions: { value: new Map<string, unknown>() },
      issueTrackedTimes: { value: new Map<string, unknown>() },
      issueDependencies: { value: new Map<string, unknown>() },
      issueReactions: { value: new Map<string, unknown>() },
      commentReactions: { value: new Map<string, unknown>() },
      userStopwatches: { value: new Map<string, unknown>() },
      worktrees: { value: [] as unknown[] },
      lastWorktreeCancelled: { value: undefined },
      lastWorktreeError: { value: undefined },
      lastSavedPullRequest: { value: undefined },
      supportsMultiDiff: { value: false },
      loadPullRequestDetail: vi.fn(),
      loadPullRequestFiles: vi.fn(),
      loadPullRequestComments: vi.fn(),
      loadPullRequestCommits: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadRepoIssues: vi.fn(),
      loadIssueSubscription: vi.fn(),
      loadIssueTrackedTimes: vi.fn(),
      loadUserStopwatches: vi.fn(),
      loadIssueDependencies: vi.fn(),
      loadIssueReactions: vi.fn(),
      openPrWorktree: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      openPullRequestDiff: vi.fn(),
      openSelectedPullRequestDiffs: vi.fn(),
      copyToClipboard: vi.fn(),
      mergePullRequest: vi.fn(),
      revertMergeCommit: vi.fn(),
      togglePullRequestState: vi.fn(),
      editPullRequest: vi.fn(),
      createIssueComment: vi.fn(),
      uploadIssueAttachment: vi.fn(),
      uploadIssueCommentAttachment: vi.fn(),
      deleteIssueAttachment: vi.fn(),
      changeIssueSubscription: vi.fn(),
      changeIssueReaction: vi.fn(),
      addIssueTime: vi.fn(),
      deleteIssueTime: vi.fn(),
      createIssueDependency: vi.fn(),
      removeIssueDependency: vi.fn(),
      updatePullRequestDueDate: vi.fn(),
      startIssueStopwatch: vi.fn(),
      stopIssueStopwatch: vi.fn(),
      renderMarkdown: vi.fn(async () => ''),
      showConfirm: vi.fn(async () => true),
    },
  };
});

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
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import type { Locale } from '../../i18n';
import en from '../../i18n/en.json';
import zh from '../../i18n/zh.json';

const state = useAppState() as unknown as Record<string, any>;

/**
 * The checks panel used to build its key inline —
 * `dashboard.detail.checksState.${statusChecks.state}` — and `state` is the
 * server's combined status passed straight through by the API client, not an
 * enum this webview controls. Any value the catalogs do not list therefore
 * printed the raw key in the UI. The merge-blocker line one screen below already
 * had the right mechanism (`statusStateLabel`, which falls back to the neutral
 * `unknown` wording when the lookup returns the key itself); these cases pin that
 * the panel goes through the same one.
 */
const KNOWN_STATES = ['success', 'pending', 'failure', 'error', 'warning', 'skipped', 'unknown'] as const;
const LOCALES = ['en', 'zh'] as const;

/** The wording each catalog defines, read from the catalogs themselves. */
function labels(locale: Locale): Record<string, string> {
  const catalog = locale === 'zh' ? zh : en;
  return catalog.dashboard.detail.checksState as Record<string, string>;
}

/** Every (locale, known state) pair, so both languages are pinned by one file. */
const KNOWN_CASES = LOCALES.flatMap((locale) => KNOWN_STATES.map((status) => ({ locale, status })));

async function mountView(locale: Locale) {
  const router = createTestRouter();
  await router.push({
    name: 'pullRequestDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '1' },
  });
  const wrapper = mount(PullRequestDetail, {
    global: {
      plugins: [router, createTestI18n(locale)],
      stubs: {
        AttachmentList: true,
        CommentTimeline: true,
        CommitDiffList: true,
        DateTimePicker: true,
        DiffFileList: true,
        EasyMdeEditor: true,
        MarkdownBody: true,
        ModalDialog: true,
        PendingAttachmentList: true,
        PullRequestForm: true,
        ReactionBar: true,
      },
    },
  });
  await nextTick();
  return wrapper;
}

/** Seeds one pull request whose combined status is `status`. */
function seed(status: string) {
  state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', 1), {
    number: 1,
    title: 'PR 1',
    state: 'open',
    user: { login: 'demo-user' },
    repository: { full_name: 'owner/repo' },
    base: { sha: 'base-sha' },
    head: { sha: 'head-sha' },
    merge_base: 'merge-base-sha',
    mergeable: true,
    labels: [],
    assignees: [],
    assets: [],
    statusChecks: { state: status, statuses: [] },
  });
}

describe('PullRequestDetail checks panel state wording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.pullRequestDetails.value.clear();
  });

  it.each(KNOWN_CASES)('shows the $locale wording for the known state "$status"', async ({ locale, status }) => {
    seed(status);

    const wrapper = await mountView(locale);

    expect(wrapper.get('.checks-summary').text()).toContain(labels(locale)[status]);
    // A missing key renders as the key itself, so this is what the case is for.
    expect(wrapper.text()).not.toMatch(/dashboard\.detail\.checksState\./);
    wrapper.unmount();
  });

  it.each(LOCALES)('falls back to the localized unknown wording for an unlisted state (%s)', async (locale) => {
    seed('expected');

    const wrapper = await mountView(locale);
    const summary = wrapper.get('.checks-summary');

    expect(summary.text()).toContain(labels(locale).unknown);
    expect(summary.text()).not.toContain('expected');
    expect(wrapper.text()).not.toMatch(/dashboard\.detail\.checksState\./);
    wrapper.unmount();
  });

  it('keeps the fallback for a state that is missing entirely', async () => {
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repo', 1), {
      number: 1,
      title: 'PR 1',
      state: 'open',
      user: { login: 'demo-user' },
      repository: { full_name: 'owner/repo' },
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      merge_base: 'merge-base-sha',
      mergeable: true,
      labels: [],
      assignees: [],
      assets: [],
      statusChecks: { statuses: [] },
    });

    const wrapper = await mountView('en');

    expect(wrapper.get('.checks-summary').text()).toContain('Unknown');
    expect(wrapper.text()).not.toMatch(/dashboard\.detail\.checksState\./);
    wrapper.unmount();
  });
});
