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

// The real element renders its description slot into a nested row the wrapper
// text does not reach; this stub flattens both slots so the assertions below
// see exactly what a user reads.
const TreeItemStub = defineComponent({
  name: 'VscodeTreeItem',
  template: '<div class="tree-item"><slot /><slot name="description" /></div>',
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

const ERROR_TEXT = 'Failed to load: permission denied';

/**
 * A failed load leaves the tab's payload unset, which is not the same as an
 * empty list: the error is already reported above, and showing "No
 * repositories" under it states as fact something the webview does not know.
 * The empty state is only for a successful load that returned nothing, and it
 * has to offer a next step instead of being a bare label.
 */
describe('DashboardInstanceItem empty states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.errors.clear();
    stateMock.loading.clear();
    stateMock.repositories.value.clear();
    stateMock.myIssues.value.clear();
    stateMock.myPullRequests.value.clear();
  });

  it('does not claim the repository list is empty when the load failed', async () => {
    stateMock.errors.set('repos-inst-1', 'permission denied');

    const wrapper = mountItem('repositories');
    await nextTick();

    expect(wrapper.text()).toContain(ERROR_TEXT);
    expect(wrapper.text()).not.toContain('No repositories');
    expect(wrapper.text()).not.toContain('Publish a local repository');
    wrapper.unmount();
  });

  it('does not claim the issue list is empty when the load failed', async () => {
    stateMock.errors.set('issues-inst-1-open', 'permission denied');

    const wrapper = mountItem('issues');
    await nextTick();

    expect(wrapper.text()).toContain(ERROR_TEXT);
    expect(wrapper.text()).not.toContain('No issues assigned to you');
    wrapper.unmount();
  });

  it('does not claim the pull request list is empty when the load failed', async () => {
    stateMock.errors.set('pulls-inst-1-open', 'permission denied');

    const wrapper = mountItem('pullRequests');
    await nextTick();

    expect(wrapper.text()).toContain(ERROR_TEXT);
    expect(wrapper.text()).not.toContain('No pull requests related to you');
    wrapper.unmount();
  });

  it('shows an empty state with a next step for a successful empty repository list', async () => {
    stateMock.repositories.value.set('inst-1', []);

    const wrapper = mountItem('repositories');
    await nextTick();

    expect(wrapper.text()).toContain('No repositories');
    expect(wrapper.text()).toContain('Publish to Forgejo');
    wrapper.unmount();
  });

  it('shows an empty state with a next step for a successful empty issue list', async () => {
    stateMock.myIssues.value.set('inst-1', []);

    const wrapper = mountItem('issues');
    await nextTick();

    expect(wrapper.text()).toContain('No issues assigned to you');
    expect(wrapper.text()).toContain('create an issue');
    wrapper.unmount();
  });

  it('shows an empty state with a next step for a successful empty pull request list', async () => {
    stateMock.myPullRequests.value.set('inst-1', []);

    const wrapper = mountItem('pullRequests');
    await nextTick();

    expect(wrapper.text()).toContain('No pull requests related to you');
    expect(wrapper.text()).toContain('Repositories tab');
    wrapper.unmount();
  });

  it('lists the repositories of a successful load instead of the empty state', async () => {
    stateMock.repositories.value.set('inst-1', [
      {
        id: 1,
        name: 'repo',
        full_name: 'owner/repo',
        html_url: 'https://forgejo.example.com/owner/repo',
        owner: { login: 'owner' },
        default_branch: 'main',
        stars_count: 0,
        forks_count: 0,
      },
    ]);

    const wrapper = mountItem('repositories');
    await nextTick();

    expect(wrapper.text()).toContain('repo');
    expect(wrapper.text()).not.toContain('No repositories');
    wrapper.unmount();
  });
});
