import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
      repoDetails: { value: new Map<string, unknown>() },
      repoBranchCommits: { value: new Map<string, unknown>() },
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      loadRepoDetail: vi.fn(),
      loadRepoBranchCommits: vi.fn(),
      previewReadme: vi.fn(),
      openExternal: vi.fn(),
      openRepoIssues: vi.fn(),
      openRepoPullRequests: vi.fn(),
      copyToClipboard: vi.fn(),
    },
  };
});

vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const params = makeReactive({ instanceId: 'inst-1', owner: 'owner', repo: 'repoA' });
  return { useRoute: () => ({ params }), useRouter: () => ({ push: vi.fn() }) };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    repoDetailKey: keyBuilder,
    repoBranchCommitsKey: keyBuilder,
  };
});

import RepoDetail from '../RepoDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as {
  repoDetails: { value: Map<string, unknown> };
  repoBranchCommits: { value: Map<string, unknown> };
  errors: Map<string, string>;
  loadRepoBranchCommits: ReturnType<typeof vi.fn>;
};

interface TestCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } };
}

const MAIN_COMMIT: TestCommit = {
  sha: 'a'.repeat(40),
  html_url: 'https://forgejo.example.com/owner/repoA/commit/main',
  commit: { message: 'MAIN BRANCH COMMIT', author: { name: 'main-author', date: '2024-01-01T00:00:00Z' } },
};

const DEV_COMMIT: TestCommit = {
  sha: 'b'.repeat(40),
  html_url: 'https://forgejo.example.com/owner/repoA/commit/dev',
  commit: { message: 'DEV BRANCH COMMIT', author: { name: 'dev-author', date: '2024-01-02T00:00:00Z' } },
};

function repoDetail(recentCommits: TestCommit[], branches: string[] = ['main', 'dev']) {
  return {
    empty: false,
    branches,
    recentCommits,
    repository: {
      full_name: 'owner/repoA',
      description: '',
      html_url: 'https://forgejo.example.com/owner/repoA',
      owner: { login: 'owner' },
      default_branch: 'main',
      stars_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      open_pr_counter: 0,
    },
  };
}

function mountView() {
  return mount(RepoDetail, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { RepoActions: true, RepoFileBrowser: true, RepoRefs: true, ViewTabs: true },
    },
  });
}

/** Drives the branch picker the way the `vscode-single-select` change event does. */
async function selectBranch(wrapper: ReturnType<typeof mountView>, branch: string) {
  const select = wrapper.find('.branch-select');
  (select.element as unknown as { value: string }).value = branch;
  await select.trigger('change');
  await nextTick();
}

describe('RepoDetail branch commits fallback', () => {
  beforeEach(() => {
    state.repoDetails.value.clear();
    state.repoBranchCommits.value.clear();
    state.errors.clear();
    state.loadRepoBranchCommits.mockClear();
    state.repoDetails.value.set(keyFor('inst-1', 'owner', 'repoA'), repoDetail([MAIN_COMMIT]));
  });

  it('shows the selected branch error instead of the default branch commits', async () => {
    const wrapper = mountView();
    await nextTick();

    // The default branch's commits come from the detail payload.
    expect(wrapper.text()).toContain('MAIN BRANCH COMMIT');

    await selectBranch(wrapper, 'dev');
    // The load for `dev` failed: the error is filed under the branch's key.
    state.errors.set(keyFor('inst-1', 'owner', 'repoA', 'dev'), 'boom');
    await nextTick();

    expect(wrapper.text()).toContain('boom');
    expect(wrapper.text()).not.toContain('MAIN BRANCH COMMIT');

    // Retry re-requests the selected branch's own commits (forced, so the
    // detail payload cannot be mistaken for a cached answer).
    const retry = wrapper.find('.error-state vscode-button');
    expect(retry.exists()).toBe(true);
    state.loadRepoBranchCommits.mockClear();
    await retry.trigger('click');
    expect(state.loadRepoBranchCommits).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 'dev', true);
    wrapper.unmount();
  });

  it('does not fall back to the default branch commits while another branch has none', async () => {
    const wrapper = mountView();
    await nextTick();

    await selectBranch(wrapper, 'dev');
    await nextTick();

    expect(wrapper.text()).not.toContain('MAIN BRANCH COMMIT');
    expect(wrapper.text()).toContain('No commits');
    wrapper.unmount();
  });

  it('still renders the default branch commits when the default branch is selected', async () => {
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.text()).toContain('MAIN BRANCH COMMIT');
    wrapper.unmount();
  });

  it('renders the branch payload when the selected branch loaded', async () => {
    state.repoBranchCommits.value.set(keyFor('inst-1', 'owner', 'repoA', 'dev'), [DEV_COMMIT]);
    const wrapper = mountView();
    await nextTick();

    await selectBranch(wrapper, 'dev');
    await nextTick();

    expect(wrapper.text()).toContain('DEV BRANCH COMMIT');
    expect(wrapper.text()).not.toContain('MAIN BRANCH COMMIT');
    wrapper.unmount();
  });
});
