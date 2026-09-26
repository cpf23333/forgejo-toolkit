import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoIssues: { value: new Map<string, unknown[]>() },
      repoIssuesTotalCount: { value: new Map() },
      repoPullRequests: { value: new Map<string, unknown[]>() },
      repoPullRequestsTotalCount: { value: new Map() },
      repoDetails: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      repoRefs: { value: new Map<string, unknown>() },
      pendingNewIssue: { value: undefined },
      pendingCreatePr: { value: undefined },
      changeRepoIssuesState: vi.fn(),
      changeRepoPullRequestsState: vi.fn(),
      consumePendingNewIssue: vi.fn(),
      consumePendingCreatePr: vi.fn(),
      createIssue: vi.fn(),
      createPullRequest: vi.fn(),
      editIssue: vi.fn(),
      editPullRequest: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoIssues: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadRepoPullRequests: vi.fn(),
      loadRepoRefs: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      openPullRequestDetail: vi.fn(),
      uploadIssueAttachment: vi.fn(),
    },
  };
});

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/issues', params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', state: 'open' } }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    issueFormKey: keyBuilder,
    pullRequestFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    repoPullRequestsKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoRefsKey: keyBuilder,
  };
});

import RepoIssues from '../RepoIssues.vue';
import RepoPullRequests from '../RepoPullRequests.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * The issue and pull request lists debounce their search box by 300 ms. With
 * `keep-alive :max="10"` a view is unmounted when it is evicted, and the shell's
 * dashboard reopen remounts the current view in place (a key bump), so a timer
 * armed just before that still fired: it posted a search for a view that no
 * longer exists, with the params its closure captured.
 */
describe('repository list search debounce across unmount', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function mountList(component: typeof RepoIssues | typeof RepoPullRequests) {
    return mount(component, {
      global: {
        plugins: [createTestI18n('en')],
        stubs: { IssueForm: true, PullRequestForm: true, ModalDialog: true, AttachmentList: true },
      },
    });
  }

  async function typeSearch(wrapper: ReturnType<typeof mountList>, value: string) {
    const field = wrapper.get('.search-input');
    (field.element as unknown as { value: string }).value = value;
    await field.trigger('input');
    await nextTick();
  }

  /** Waits past the 300 ms debounce window. */
  async function pastDebounce() {
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  it('does not post a debounced issue search for an unmounted view', async () => {
    const wrapper = mountList(RepoIssues);
    await typeSearch(wrapper, 'memory leak');
    stateMock.loadRepoIssues.mockClear();

    wrapper.unmount();
    await pastDebounce();

    expect(stateMock.loadRepoIssues).not.toHaveBeenCalled();
  });

  it('does not post a debounced pull request search for an unmounted view', async () => {
    const wrapper = mountList(RepoPullRequests);
    await typeSearch(wrapper, 'memory leak');
    stateMock.loadRepoPullRequests.mockClear();

    wrapper.unmount();
    await pastDebounce();

    expect(stateMock.loadRepoPullRequests).not.toHaveBeenCalled();
  });

  it('still debounces the search of a mounted view', async () => {
    // The guard is the unmount, not the debounce: a live view keeps searching.
    const wrapper = mountList(RepoIssues);
    await typeSearch(wrapper, 'memory leak');
    stateMock.loadRepoIssues.mockClear();

    await pastDebounce();

    expect(stateMock.loadRepoIssues).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'open', 'memory leak');
    wrapper.unmount();
  });
});
