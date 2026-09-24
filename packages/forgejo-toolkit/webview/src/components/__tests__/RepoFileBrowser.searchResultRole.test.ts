import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import RepoFileBrowser from '../RepoFileBrowser.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    repoContents: { value: new Map<string, unknown[]>() },
    repoFileSearchResults: { value: new Map<string, unknown[]>() },
    repoFileSearchTruncated: { value: new Map<string, 'matches' | 'tree'>() },
    loadRepoContents: vi.fn(),
    loadRepoFileSearch: vi.fn(),
    openRepoFile: vi.fn(),
    t: (key: string) => key,
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    repoContentsKey: (instanceId: string, owner: string, repo: string, ref: string, path: string) =>
      `${instanceId}:${owner}/${repo}:${ref}:${path}`,
    repoFileSearchKey: (instanceId: string, owner: string, repo: string, ref: string, query: string) =>
      `${instanceId}:${owner}/${repo}:${ref}:search:${query}`,
  };
});

import { useAppState } from '../../composables/useAppState';

const Host = defineComponent({
  setup() {
    return () =>
      h(RepoFileBrowser, {
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        branches: ['main'],
        defaultBranch: 'main',
      });
  },
});

const KEY = 'inst-1:owner/repo:main:search:foo';

function mountHost() {
  return mount(Host, { global: { plugins: [createTestI18n('en')] } });
}

async function search(wrapper: ReturnType<typeof mountHost>) {
  const input = wrapper.find('vscode-textfield');
  (input.element as unknown as { value: string }).value = 'foo';
  await input.trigger('input');
  const state = useAppState() as unknown as {
    repoFileSearchResults: { value: Map<string, unknown[]> };
  };
  state.repoFileSearchResults.value.set(KEY, [{ path: 'src/foo.ts', sha: 'sha-1' }]);
  await nextTick();
}

/**
 * A search result row was a focusable clickable `<li>` with no role: a screen
 * reader announced plain text in a list and gave no hint that Enter opens the
 * file. The row now carries a button role — on an inner target, so the `<li>`
 * itself stays a listitem and the `<ul>` keeps a valid child list.
 */
describe('RepoFileBrowser search result row role', () => {
  beforeEach(() => {
    stateMock.repoFileSearchResults.value.clear();
    stateMock.repoFileSearchTruncated.value.clear();
    stateMock.openRepoFile.mockClear();
  });

  it('reports each search result as a button that opens the file', async () => {
    const wrapper = mountHost();
    await search(wrapper);

    const row = wrapper.get('.search-result-item');
    // The list item keeps its list semantics …
    expect(row.element.tagName).toBe('LI');
    expect(row.attributes('role')).toBeUndefined();

    // … and the focusable target inside it is the button.
    const target = row.get('[role="button"]');
    expect(target.attributes('tabindex')).toBe('0');
    expect(target.text()).toContain('src/foo.ts');

    await target.trigger('click');
    expect(stateMock.openRepoFile).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'src/foo.ts', expect.any(String));

    wrapper.unmount();
  });

  it('opens the file from the keyboard on the same target', async () => {
    const wrapper = mountHost();
    await search(wrapper);

    const target = wrapper.get('[role="button"]');
    await target.trigger('keydown', { key: 'Enter' });
    await target.trigger('keydown', { key: ' ' });

    expect(stateMock.openRepoFile).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });
});
