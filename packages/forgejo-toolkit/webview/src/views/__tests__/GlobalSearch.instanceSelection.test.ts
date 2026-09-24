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
  // Wrap in reactive so the component observes the same state object the test
  // writes through `useAppState()`.
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

type TestState = {
  instances: { value: Array<{ id: string; url: string; username: string }> };
};

function state(): TestState {
  return useAppState() as unknown as TestState;
}

function mountSearch() {
  return mount(GlobalSearch, {
    global: { plugins: [createTestI18n('en')] },
  });
}

function instanceCheckboxes(wrapper: VueWrapper) {
  return wrapper.findAll('.instance-checkbox');
}

async function selectInstances(wrapper: VueWrapper, checked: boolean) {
  // The first checkbox is "All instances"; the write-only computed behind it
  // seeds every instance, exactly like the user toggling it.
  const allInstances = instanceCheckboxes(wrapper)[0];
  (allInstances.element as HTMLInputElement).checked = checked;
  await allInstances.trigger('change');
  await nextTick();
}

async function typeQuery(wrapper: VueWrapper, value: string) {
  const input = wrapper.find('.search-input');
  (input.element as HTMLInputElement).value = value;
  await input.trigger('input');
  await nextTick();
}

/**
 * Deselecting every instance leaves nothing to search, but the view used to
 * fall through to its results branch and render a completely blank panel: no
 * explanation and no way to tell whether the search had run. It now says that
 * at least one instance must be selected.
 */
describe('GlobalSearch instance selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.globalSearchResults.value.clear();
    state().instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }];
  });

  it('seeds every configured instance as selected', async () => {
    const wrapper = mountSearch();
    await nextTick();

    // "All instances" plus one checkbox per configured instance.
    expect(instanceCheckboxes(wrapper)).toHaveLength(2);
    expect(wrapper.text()).toContain('https://forgejo.example.com');
    wrapper.unmount();
  });

  it('asks for an instance instead of showing a blank panel once all instances are unchecked', async () => {
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');
    await selectInstances(wrapper, false);

    expect(wrapper.text()).toContain('Select at least one instance to search.');
    expect(wrapper.find('.results').exists()).toBe(false);
    wrapper.unmount();
  });

  it('asks for an instance even before a query is typed', async () => {
    const wrapper = mountSearch();
    await selectInstances(wrapper, false);

    expect(wrapper.text()).toContain('Select at least one instance to search.');
    expect(wrapper.text()).not.toContain('Enter a keyword and press Enter or click Search.');
    wrapper.unmount();
  });

  it('still points at Settings when no instance is configured at all', async () => {
    state().instances.value = [];
    const wrapper = mountSearch();
    await nextTick();

    expect(wrapper.text()).toContain('No Forgejo instances configured. Add an instance in Settings first.');
    expect(wrapper.text()).not.toContain('Select at least one instance to search.');
    wrapper.unmount();
  });
});
