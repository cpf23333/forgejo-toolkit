import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

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
import { createTestI18n } from '../../__tests__/helpers/test-utils';

function mountView() {
  return mount(GlobalSearch, {
    global: { plugins: [createTestI18n('en')] },
  });
}

const SEARCH_PLACEHOLDER = 'Search across repositories, issues, and pull requests';

/**
 * The query box and the state filter both had no accessible name: the box was
 * named by its placeholder example alone and the filter only by a `<label for>`
 * next to it, neither of which a `vscode-*` control reads (see
 * `Settings.controlLabels.test.ts`). The box reuses the placeholder sentence as
 * its name; the filter reuses the visible `<label>`.
 */
describe('GlobalSearch form control accessible names', () => {
  it('names the query box and the state filter', () => {
    const wrapper = mountView();

    const input = wrapper.get('.search-input');
    expect(input.attributes('label')).toBe(SEARCH_PLACEHOLDER);
    expect(input.attributes('placeholder')).toBe(SEARCH_PLACEHOLDER);

    expect(wrapper.get('#state-filter').attributes('label')).toBe('State');
    expect(wrapper.get('label[for="state-filter"]').text()).toBe('State');

    for (const control of wrapper.findAll('vscode-single-select, vscode-textfield')) {
      expect(control.attributes('label'), control.html()).toBeTruthy();
    }

    wrapper.unmount();
  });
});
