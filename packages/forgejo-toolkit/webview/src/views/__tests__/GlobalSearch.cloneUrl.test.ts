import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    // `functionalUrl` is optional: a test below swaps in a payload from a host
    // build that predates the field.
    instances: {
      value: [
        {
          id: 'inst-1',
          // What the host sends: the display value keeps the credential mask.
          url: 'https://***@forgejo.example.com/',
          functionalUrl: 'https://forgejo.example.com/',
          username: 'demo-user',
        },
      ] as Array<{ id: string; url: string; functionalUrl?: string; username: string }>,
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

function mountSearch() {
  return mount(GlobalSearch, { global: { plugins: [createTestI18n('en')] } });
}

async function typeQuery(wrapper: VueWrapper, value: string) {
  const input = wrapper.find('.search-input');
  (input.element as HTMLInputElement).value = value;
  await input.trigger('input');
  await nextTick();
}

function seedResults() {
  stateMock.globalSearchResults.value.set('inst-1:global-search:all:all:alpha', {
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

function cloneButton(wrapper: VueWrapper) {
  const buttons = wrapper.findAll('button[aria-label="Copy clone URL"]');
  expect(buttons).toHaveLength(1);
  return buttons[0];
}

/**
 * The global search's copy-clone action built its URL from `instance.url`, which
 * is the *display* value: the host masks credentials in it
 * (`https://***@forgejo.example.com/`), so the button copied
 * `https://***@forgejo.example.com//owner/repo-one.git` — a URL git cannot clone.
 * It reads the credential-free twin instead.
 */
describe('GlobalSearch clone URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.globalSearchResults.value.clear();
    // A test below replaces the instance list with a legacy payload; every test
    // starts from the host's current one.
    stateMock.instances.value = [
      {
        id: 'inst-1',
        // What the host sends: the display value keeps the credential mask.
        url: 'https://***@forgejo.example.com/',
        functionalUrl: 'https://forgejo.example.com/',
        username: 'demo-user',
      },
    ];
  });

  it('copies the credential-free clone URL', async () => {
    seedResults();
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');

    await cloneButton(wrapper).trigger('click');
    await nextTick();

    expect(stateMock.copyToClipboard).toHaveBeenCalledWith('https://forgejo.example.com/owner/repo-one.git');
    expect(stateMock.copyToClipboard.mock.calls[0][0]).not.toContain('***');
    wrapper.unmount();
  });

  it('keeps the masked URL for the instance label', async () => {
    seedResults();
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');

    expect(wrapper.text()).toContain('https://***@forgejo.example.com/');
    wrapper.unmount();
  });

  it('does not offer the copy action when there is no usable URL to copy', async () => {
    // A payload from a host build that predates `functionalUrl`, with the display
    // value masked: the clone URL is '' and the button used to write an empty
    // clipboard while still reporting the copy as done.
    stateMock.instances.value = [{ id: 'inst-1', url: 'https://***@forgejo.example.com/', username: 'demo-user' }];
    seedResults();
    const wrapper = mountSearch();
    await typeQuery(wrapper, 'alpha');

    expect(wrapper.findAll('button[aria-label="Copy clone URL"]')).toHaveLength(0);
    expect(stateMock.copyToClipboard).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
