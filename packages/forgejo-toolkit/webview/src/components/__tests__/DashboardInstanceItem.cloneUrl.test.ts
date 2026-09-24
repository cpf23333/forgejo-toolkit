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

/**
 * The host masks credentials in `instance.url` before the webview ever sees it
 * (`https://***@forgejo.example.com/`), and the clone button used to build its
 * URL from that display value — so it copied
 * `https://***@forgejo.example.com//owner/repo.git`, which git cannot clone.
 * The functional twin (`functionalUrl`) is what the copy action must use.
 */
const INSTANCE = {
  id: 'inst-1',
  url: 'https://***@forgejo.example.com/',
  functionalUrl: 'https://forgejo.example.com/',
  name: 'demo',
  username: 'demo-user',
};

const REPO = {
  id: 1,
  name: 'repo',
  full_name: 'owner/repo',
  html_url: 'https://forgejo.example.com/owner/repo',
  owner: { login: 'owner' },
  default_branch: 'main',
  stars_count: 0,
  forks_count: 0,
};

const TreeItemStub = defineComponent({
  name: 'VscodeTreeItem',
  template: '<div class="tree-item"><slot /><slot name="description" /><slot name="actions" /></div>',
});

function mountItem() {
  return mount(DashboardInstanceItem, {
    props: { instance: INSTANCE, activeTab: 'repositories' as const },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { 'vscode-tree-item': TreeItemStub },
    },
  });
}

function cloneButton(wrapper: ReturnType<typeof mountItem>) {
  return wrapper.findAll('button[aria-label="Copy clone URL"]');
}

describe('DashboardInstanceItem clone URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.errors.clear();
    stateMock.loading.clear();
    stateMock.repositories.value.clear();
    stateMock.myIssues.value.clear();
    stateMock.myPullRequests.value.clear();
  });

  it('copies the credential-free clone URL, not the masked display value', async () => {
    stateMock.repositories.value.set('inst-1', [REPO]);
    const wrapper = mountItem();
    await nextTick();

    const buttons = cloneButton(wrapper);
    expect(buttons).toHaveLength(1);
    await buttons[0].trigger('click');
    await nextTick();

    expect(stateMock.copyToClipboard).toHaveBeenCalledWith('https://forgejo.example.com/owner/repo.git');
    expect(stateMock.copyToClipboard.mock.calls[0][0]).not.toContain('***');
    wrapper.unmount();
  });

  it('shows the masked URL as the instance label', async () => {
    const wrapper = mountItem();
    await nextTick();

    // The display value stays the masked one: this test pins the split, so a
    // later change that "simplifies" the clone URL back to `instance.url` shows
    // up as a failing assertion here.
    expect(wrapper.text()).toContain('https://***@forgejo.example.com/');
    wrapper.unmount();
  });
});
