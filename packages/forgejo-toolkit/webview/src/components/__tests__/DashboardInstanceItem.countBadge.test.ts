import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    errors: new Map<string, string>(),
    loading: new Map<string, boolean>(),
    repositories: { value: new Map<string, unknown[]>() },
    myIssues: { value: new Map<string, unknown[]>() },
    myPullRequests: { value: new Map<string, unknown[]>() },
    // The TTL caches the badge used to be gated on. They are deliberately empty
    // here: the payload below is what the rows render, and it must be what the
    // badge follows.
    repositoriesCache: { has: () => false },
    myIssuesCache: { has: () => false },
    myPullRequestsCache: { has: () => false },
    loadRepositories: vi.fn(),
    loadMyIssues: vi.fn(),
    loadMyPullRequests: vi.fn(),
    openRepoDetail: vi.fn(),
    openIssueDetail: vi.fn(),
    openPullRequestDetail: vi.fn(),
    openExternal: vi.fn(),
    copyToClipboard: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', () => ({
  useAppState: () => stateMock,
}));

import DashboardInstanceItem from '../DashboardInstanceItem.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const instance = { id: 'inst-1', url: 'https://forgejo.example.com', name: 'demo', username: 'demo-user' };

const TreeItemStub = defineComponent({
  name: 'VscodeTreeItem',
  template: '<div class="tree-item"><slot /><slot name="description" /><slot name="decoration" /></div>',
});

function mountItem(activeTab: 'repositories' | 'issues' | 'pullRequests') {
  return mount(DashboardInstanceItem, {
    props: { instance, activeTab },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { 'vscode-tree-item': TreeItemStub },
    },
  });
}

function repo(id: number, name: string) {
  return {
    id,
    name,
    full_name: `owner/${name}`,
    html_url: `https://forgejo.example.com/owner/${name}`,
    owner: { login: 'owner' },
    default_branch: 'main',
    stars_count: 0,
    forks_count: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stateMock.errors.clear();
  stateMock.loading.clear();
  stateMock.repositories.value.clear();
  stateMock.myIssues.value.clear();
  stateMock.myPullRequests.value.clear();
});

/**
 * The count badge labels the rows the tab is showing. It was gated on the 30 s
 * TTL caches (`repositoriesCache.has(...)`) rather than on the payload those
 * rows come from, so once the cache expired a re-render dropped the count from a
 * row that still listed every repository — the badge and the list disagreed
 * about the same data.
 */
describe('DashboardInstanceItem count badge follows the shown payload', () => {
  it('keeps the count while the rows are still listed after the cache TTL expired', async () => {
    // The load landed: the payload slot holds the rows, and the TTL cache that
    // was written with them has since expired (it reports no entry).
    stateMock.repositories.value.set('inst-1', [repo(1, 'alpha'), repo(2, 'beta')]);

    const wrapper = mountItem('repositories');
    await nextTick();

    expect(wrapper.find('.badge').exists()).toBe(true);
    expect(wrapper.find('.badge').text()).toBe('2');
    expect(wrapper.text()).toContain('alpha');
    expect(wrapper.text()).toContain('beta');
    wrapper.unmount();
  });

  it('shows no count when the tab has no payload yet', async () => {
    const wrapper = mountItem('repositories');
    await nextTick();

    expect(wrapper.find('.badge').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows no count for a failed load, and the error instead', async () => {
    stateMock.errors.set('repos-inst-1', 'permission denied');

    const wrapper = mountItem('repositories');
    await nextTick();

    expect(wrapper.find('.badge').exists()).toBe(false);
    expect(wrapper.text()).toContain('Failed to load: permission denied');
    wrapper.unmount();
  });

  it('counts the issue payload the issues tab renders', async () => {
    stateMock.myIssues.value.set('inst-1', [
      { id: 1, number: 7, title: 'Broken build', state: 'open', html_url: 'https://forgejo.example.com/o/r/issues/7' },
    ]);

    const wrapper = mountItem('issues');
    await nextTick();

    expect(wrapper.find('.badge').text()).toBe('1');
    expect(wrapper.text()).toContain('Broken build');
    wrapper.unmount();
  });

  it('counts the pull request payload the pull requests tab renders', async () => {
    stateMock.myPullRequests.value.set('inst-1', [
      { id: 1, number: 3, title: 'Add feature', state: 'open', html_url: 'https://forgejo.example.com/o/r/pulls/3' },
    ]);

    const wrapper = mountItem('pullRequests');
    await nextTick();

    expect(wrapper.find('.badge').text()).toBe('1');
    expect(wrapper.text()).toContain('Add feature');
    wrapper.unmount();
  });
});
