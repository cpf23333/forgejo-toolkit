import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

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

const state = useAppState() as unknown as { repoDetails: { value: Map<string, unknown> } };

/**
 * The branch picker rendered an unnamed combobox: the `<h3>` next to it is a
 * sibling, not an associated label, so a screen reader announced a select
 * without a name. Every other select in scope passes `:label`, which is what
 * `vscode-single-select` turns into the control's own accessible name.
 */
describe('RepoDetail branch select accessible name', () => {
  it('labels the branch combobox with the section it belongs to', async () => {
    state.repoDetails.value.set(keyFor('inst-1', 'owner', 'repoA'), {
      empty: false,
      branches: ['main', 'dev'],
      recentCommits: [],
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
    });

    const wrapper = mount(RepoDetail, {
      global: {
        plugins: [createTestI18n('en')],
        stubs: {
          RepoActions: true,
          RepoFileBrowser: true,
          RepoRefs: true,
          ViewTabs: true,
          EasyMdeEditor: defineComponent({ template: '<div />' }),
        },
      },
    });
    await nextTick();

    const select = wrapper.get('.branch-select');
    expect(select.attributes('label')).toBe('Branches');
    // The neighbouring heading is not the association the control needs.
    expect(wrapper.get('section h3').text()).toBe('Branches');
    wrapper.unmount();
  });
});
