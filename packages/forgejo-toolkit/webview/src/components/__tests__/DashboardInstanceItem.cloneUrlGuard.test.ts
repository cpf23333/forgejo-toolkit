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
import type { ForgejoInstance } from '../../types/instance';

// The real element renders its description/actions slots into a nested row the
// wrapper does not reach; this stub flattens them so the assertions below see
// exactly what a user does.
const TreeItemStub = defineComponent({
  name: 'VscodeTreeItem',
  template: '<div class="tree-item"><slot /><slot name="description" /><slot name="actions" /></div>',
});

const repo = {
  id: 1,
  name: 'repo',
  full_name: 'owner/repo',
  html_url: 'https://forgejo.example.com/owner/repo',
  owner: { login: 'owner' },
  default_branch: 'main',
  stars_count: 0,
  forks_count: 0,
};

function mountItem(instance: ForgejoInstance) {
  return mount(DashboardInstanceItem, {
    props: { instance, activeTab: 'repositories' },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { 'vscode-tree-item': TreeItemStub },
    },
  });
}

function copyButton(wrapper: ReturnType<typeof mountItem>) {
  return wrapper.find('button[aria-label="Copy Clone URL"]');
}

/**
 * The clone-URL button copied whatever `cloneUrl()` returned, and that is `''`
 * for a payload with a credential mask and no `functionalUrl` (a host build that
 * predates the field). Clicking it then wrote an empty clipboard while the host
 * toasted the success, so the action is hidden when there is nothing to copy.
 */
describe('DashboardInstanceItem clone URL copy guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.errors.clear();
    stateMock.loading.clear();
    stateMock.repositories.value.clear();
    stateMock.repositories.value.set('inst-1', [repo]);
  });

  it('offers the copy action for an instance with a functional URL', async () => {
    const wrapper = mountItem({
      id: 'inst-1',
      url: 'https://***@forgejo.example.com/',
      functionalUrl: 'https://forgejo.example.com/',
      name: 'demo',
      username: 'demo-user',
    });
    await nextTick();

    const button = copyButton(wrapper);
    expect(button.exists()).toBe(true);

    await button.trigger('click');
    expect(stateMock.copyToClipboard).toHaveBeenCalledWith('https://forgejo.example.com/owner/repo.git');
    wrapper.unmount();
  });

  it('hides the copy action when there is no usable URL to copy', async () => {
    // A mask and no functional twin: `functionalInstanceUrl` returns '' rather
    // than a URL git cannot use.
    const wrapper = mountItem({
      id: 'inst-1',
      url: 'https://***@forgejo.example.com/',
      name: 'demo',
      username: 'demo-user',
    });
    await nextTick();

    expect(copyButton(wrapper).exists()).toBe(false);
    expect(stateMock.copyToClipboard).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps the other row actions when the copy action is hidden', async () => {
    const wrapper = mountItem({
      id: 'inst-1',
      url: 'https://***@forgejo.example.com/',
      name: 'demo',
      username: 'demo-user',
    });
    await nextTick();

    // Only the copy action is withheld: the repository is still listed and can
    // still be opened.
    expect(wrapper.text()).toContain('repo');
    expect(wrapper.find('button[aria-label="Open in Browser"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
