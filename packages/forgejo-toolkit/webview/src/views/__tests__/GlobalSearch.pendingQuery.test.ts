import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: {
      value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }],
    },
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
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

function mountSearch() {
  return mount(GlobalSearch, {
    global: { plugins: [createTestI18n('en')] },
  });
}

async function typeQuery(wrapper: VueWrapper, value: string) {
  const input = wrapper.find('.search-input');
  (input.element as HTMLInputElement).value = value;
  await input.trigger('input');
  await nextTick();
}

async function pressEnter(wrapper: VueWrapper) {
  await wrapper.find('.search-input').trigger('keydown', { key: 'Enter' });
  await nextTick();
}

function seedResults() {
  const state = useAppState() as unknown as { globalSearchResults: { value: Map<string, unknown> } };
  state.globalSearchResults.value.set('inst-1:global-search:all:all:alpha', {
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
}

/**
 * Results are keyed by the query text, but a search only runs on Enter/Search.
 * Deriving the rendered hits from the live input therefore blanked the panel on
 * the first keystroke of an edit: every branch was false for the not-yet-run
 * query and an empty results container replaced the hits. The view now shows
 * the last search's results (with a note that the text has changed) until a new
 * search runs.
 */
describe('GlobalSearch results while the query text is edited', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.globalSearchResults.value.clear();
    stateMock.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }];
  });

  it('keeps showing the previous hits when the query text is edited', async () => {
    seedResults();
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');
    expect(wrapper.text()).toContain('owner/repo-one');

    // Editing the text does not run a search…
    await typeQuery(wrapper, 'alphax');
    expect(stateMock.loadGlobalSearch).not.toHaveBeenCalled();

    // …so the hits of the last search must stay on screen.
    expect(wrapper.text()).toContain('owner/repo-one');
    wrapper.unmount();
  });

  it('says the edited query has not been searched yet', async () => {
    seedResults();
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');
    await typeQuery(wrapper, 'alphax');

    expect(wrapper.text()).toContain('Not searched yet');
    wrapper.unmount();
  });

  it('offers the same note instead of an empty results panel before the first search', async () => {
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');

    expect(wrapper.find('.results').exists()).toBe(false);
    expect(wrapper.text()).toContain('Not searched yet');
    wrapper.unmount();
  });

  it('replaces the stale hits once the new search runs', async () => {
    seedResults();
    // The composable marks the dispatched query as loading; without that the
    // view cannot tell "running" apart from "never searched".
    stateMock.loadGlobalSearch.mockImplementation(
      (instanceId: string, scope: string, query: string, stateFilter: string) => {
        stateMock.loading.set(`${instanceId}:global-search:${scope}:${stateFilter}:${query}`, true);
      },
    );
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');

    await typeQuery(wrapper, 'alphax');
    await pressEnter(wrapper);

    expect(stateMock.loadGlobalSearch).toHaveBeenCalledWith('inst-1', 'all', 'alphax', 'all');
    // The stale hits are keyed to the old query, so they are gone immediately,
    // and the new query is no longer "not searched yet".
    expect(wrapper.text()).not.toContain('owner/repo-one');
    expect(wrapper.text()).not.toContain('Not searched yet');
    wrapper.unmount();
  });

  it('returns to the hint when the input is cleared', async () => {
    seedResults();
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');
    expect(wrapper.text()).toContain('owner/repo-one');

    await typeQuery(wrapper, '');

    expect(wrapper.text()).not.toContain('owner/repo-one');
    expect(wrapper.text()).toContain('Enter a keyword and press Enter or click Search.');
    wrapper.unmount();
  });
});
