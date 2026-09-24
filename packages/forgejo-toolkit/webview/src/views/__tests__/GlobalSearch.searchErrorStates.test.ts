import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    globalSearchResults: { value: new Map<string, unknown>() },
    locale: { value: 'en' },
    loadGlobalSearch: vi.fn(),
    openRepoDetail: vi.fn(),
    openIssueDetail: vi.fn(),
    openPullRequestDetail: vi.fn(),
    openExternal: vi.fn(),
    copyToClipboard: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    globalSearchKey: (instanceId: string, scope: string, query: string, stateFilter: string) =>
      `${instanceId}:global-search:${scope}:${stateFilter}:${query}`,
    GLOBAL_SEARCH_LIMIT: 20,
  };
});

import GlobalSearch from '../GlobalSearch.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const RESULT_KEY = 'inst-1:global-search:all:all:alpha';

function mountSearch() {
  return mount(GlobalSearch, {
    global: { plugins: [createTestI18n('en')] },
  });
}

async function searchFor(wrapper: VueWrapper, value: string) {
  const input = wrapper.find('.search-input');
  (input.element as HTMLInputElement).value = value;
  await input.trigger('input');
  await input.trigger('keydown', { key: 'Enter' });
  await nextTick();
}

function hasRetryControl(wrapper: VueWrapper): boolean {
  return wrapper.findAll('button').some((button) => button.attributes('aria-label') === 'Retry');
}

/**
 * The host answers a failed search with `{instanceId, scope, query, state, error}`
 * and no arrays, and the composable stores only the error. The view counted that
 * error as "the query was searched" and rendered "No results found." — a claim
 * that the item does not exist — while the per-instance error and its Retry live
 * in the results branch that the claim short-circuited.
 */
describe('GlobalSearch result-less states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.globalSearchResults.value.clear();
    stateMock.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }];
  });

  it('shows the error and its Retry when the query only failed', async () => {
    stateMock.errors.set(RESULT_KEY, 'instance unreachable');
    const wrapper = mountSearch();
    await searchFor(wrapper, 'alpha');

    expect(wrapper.text()).not.toContain('No results found.');
    expect(wrapper.text()).toContain('Failed to load: instance unreachable');
    expect(hasRetryControl(wrapper)).toBe(true);
    wrapper.unmount();
  });

  it('re-runs the failed query when the error row Retry is used', async () => {
    stateMock.errors.set(RESULT_KEY, 'instance unreachable');
    const wrapper = mountSearch();
    await searchFor(wrapper, 'alpha');
    stateMock.loadGlobalSearch.mockClear();

    await wrapper
      .findAll('button')
      .find((button) => button.attributes('aria-label') === 'Retry')!
      .trigger('click');
    await nextTick();

    expect(stateMock.loadGlobalSearch).toHaveBeenCalledWith('inst-1', 'all', 'alpha', 'all');
    wrapper.unmount();
  });

  it('shows the hits when the query answered with results', async () => {
    stateMock.globalSearchResults.value.set(RESULT_KEY, {
      repositories: [
        {
          id: 1,
          name: 'repo-one',
          full_name: 'owner/repo-one',
          owner: { login: 'owner' },
          html_url: 'https://forgejo.example.com/owner/repo-one',
        },
      ],
      issues: [],
      pullRequests: [],
    });
    const wrapper = mountSearch();
    await searchFor(wrapper, 'alpha');

    expect(wrapper.text()).toContain('owner/repo-one');
    expect(wrapper.text()).not.toContain('No results found.');
    wrapper.unmount();
  });

  it('says no results were found only when the query really answered empty', async () => {
    stateMock.globalSearchResults.value.set(RESULT_KEY, { repositories: [], issues: [], pullRequests: [] });
    const wrapper = mountSearch();
    await searchFor(wrapper, 'alpha');

    expect(wrapper.text()).toContain('No results found.');
    expect(wrapper.find('.error').exists()).toBe(false);
    wrapper.unmount();
  });
});
