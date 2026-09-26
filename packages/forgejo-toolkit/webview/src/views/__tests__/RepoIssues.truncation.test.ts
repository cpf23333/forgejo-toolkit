import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { LIST_ITEM_LIMIT } from '@cpf23333-forgejo-toolkit/shared/limits';

const { routeMock, stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    routeMock: { params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', state: 'open' } },
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoIssues: { value: new Map<string, unknown[]>() },
      repoIssuesTotalCount: { value: new Map<string, number>() },
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

vi.mock('vue-router', () => ({ useRoute: () => routeMock, useRouter: () => ({ push: vi.fn() }) }));

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

interface StateMaps {
  repoIssues: { value: Map<string, unknown[]> };
  repoIssuesTotalCount: { value: Map<string, number> };
}

const KEY = keyFor('inst-1', 'owner', 'repo', 'open', '');

function issues(length: number): unknown[] {
  return Array.from({ length }, (_, i) => ({
    id: i + 1,
    number: i + 1,
    title: `issue ${i + 1}`,
    state: 'open',
    user: { login: 'demo-user' },
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
  }));
}

function mountWith(items: unknown[], totalCount?: number) {
  const state = useAppState() as unknown as StateMaps;
  state.repoIssues.value.set(KEY, items);
  if (totalCount !== undefined) {
    state.repoIssuesTotalCount.value.set(KEY, totalCount);
  }
  return mount(RepoIssues, { global: { plugins: [createTestI18n('en')] } });
}

/**
 * The truncation notice used to key on the list length alone (`length >=
 * LIST_ITEM_LIMIT`), so exactly 500 issues always read as "may be incomplete".
 * With the server's `X-Total-Count` in the payload the notice is exact: a full
 * cap of rows whose total agrees is complete, and only a total above the
 * loaded count keeps the notice. Without a total the heuristic must not
 * change.
 */
describe('RepoIssues truncation notice', () => {
  beforeEach(() => {
    stateMock.repoIssues.value.clear();
    stateMock.repoIssuesTotalCount.value.clear();
    stateMock.loading.clear();
    stateMock.errors.clear();
  });

  it('stays hidden for a full cap of rows when the reported total agrees', async () => {
    const wrapper = mountWith(issues(LIST_ITEM_LIMIT), LIST_ITEM_LIMIT);
    await nextTick();
    expect(wrapper.find('.list-truncated').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows when the reported total exceeds the loaded rows', async () => {
    const wrapper = mountWith(issues(LIST_ITEM_LIMIT), LIST_ITEM_LIMIT + 1);
    await nextTick();
    expect(wrapper.find('.list-truncated').exists()).toBe(true);
    wrapper.unmount();
  });

  it('falls back to the length heuristic when no total was reported', async () => {
    // A capped list with no total may be incomplete: the notice stays.
    const capped = mountWith(issues(LIST_ITEM_LIMIT));
    await nextTick();
    expect(capped.find('.list-truncated').exists()).toBe(true);
    capped.unmount();

    stateMock.repoIssues.value.clear();

    // A short list never shows the notice, total or not.
    const short = mountWith(issues(3));
    await nextTick();
    expect(short.find('.list-truncated').exists()).toBe(false);
    short.unmount();
  });
});
