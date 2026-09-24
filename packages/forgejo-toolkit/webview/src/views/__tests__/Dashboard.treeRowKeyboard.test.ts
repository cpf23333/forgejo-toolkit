import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const repo = {
  id: 1,
  name: 'repo-one',
  full_name: 'owner/repo-one',
  owner: { login: 'owner' },
  default_branch: 'main',
  stars_count: 0,
  forks_count: 0,
  html_url: 'https://forgejo.example.com/owner/repo-one',
};

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
    dashboardActiveTab: { value: 'repositories' },
    setDashboardActiveTab: vi.fn(),
    activeLinkedRepository: { value: undefined },
    linkedRepositories: { value: [] },
    unreadNotificationCount: { value: 0 },
    selectLinkedRepository: vi.fn(),
    openLinkedRepositoryDetail: vi.fn(),
    openLinkedRepositoryIssues: vi.fn(),
    openLinkedRepositoryPullRequests: vi.fn(),
    loadNotificationBadge: vi.fn(),
    repositories: { value: new Map<string, unknown[]>() },
    repositoriesCache: new Map<string, unknown[]>(),
    myIssues: { value: new Map<string, unknown[]>() },
    myPullRequests: { value: new Map<string, unknown[]>() },
    myIssuesCache: new Map<string, unknown[]>(),
    myPullRequestsCache: new Map<string, unknown[]>(),
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
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

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return { useAppState: () => state };
});

import Dashboard from '../Dashboard.vue';
import { createTestI18n, createTestRouter } from '../../__tests__/helpers/test-utils';

function mountDashboard() {
  return mount(Dashboard, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ViewTabs: true },
    },
  });
}

/**
 * The dashboard's tree rows act on `@click.capture`, but `vscode-tree` consumes
 * Enter/Space on the tree item it focuses and never synthesizes a click: without
 * a capture-phase activation of its own, no repository, issue or pull request
 * could be opened from the keyboard (and a nested icon button could not run
 * either).
 */
describe('Dashboard tree rows activate from the keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.repositories.value.clear();
    stateMock.repositoriesCache.clear();
    stateMock.repositories.value.set('inst-1', [{ ...repo }]);
    stateMock.repositoriesCache.set('inst-1', [{ ...repo }]);
  });

  it('opens the focused repository on Enter and on Space', async () => {
    const wrapper = mountDashboard();
    await nextTick();

    const row = wrapper.get('[data-tree-row-action]');
    await row.trigger('keydown', { key: 'Enter' });
    expect(stateMock.openRepoDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repo-one');

    await row.trigger('keydown', { key: ' ' });
    expect(stateMock.openRepoDetail).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('keeps the key from reaching the tree own selection handling', async () => {
    const wrapper = mountDashboard();
    await nextTick();

    const tree = wrapper.get('vscode-tree').element;
    // Stands in for the tree's own bubble-phase keydown listener.
    const treeKeydown = vi.fn();
    tree.addEventListener('keydown', treeKeydown);

    await wrapper.get('[data-tree-row-action]').trigger('keydown', { key: 'Enter' });

    expect(treeKeydown).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('runs only the nested action button when the key targets it', async () => {
    const wrapper = mountDashboard();
    await nextTick();

    const actionButton = wrapper.get('[data-tree-row-action] .tree-actions button');
    await actionButton.trigger('keydown', { key: 'Enter' });

    expect(stateMock.openExternal).toHaveBeenCalledWith('https://forgejo.example.com/owner/repo-one');
    expect(stateMock.openRepoDetail).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('leaves arrow-key navigation to the tree', async () => {
    const wrapper = mountDashboard();
    await nextTick();

    await wrapper.get('[data-tree-row-action]').trigger('keydown', { key: 'ArrowDown' });

    expect(stateMock.openRepoDetail).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
