import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, nextTick } from 'vue';
import RepoFileBrowser from '../RepoFileBrowser.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    repoContents: { value: new Map<string, unknown[]>() },
    repoFileSearchResults: { value: new Map<string, unknown[]>() },
    repoFileSearchTruncated: { value: new Map<string, boolean>() },
    loadRepoContents: vi.fn(),
    loadRepoFileSearch: vi.fn(),
    openRepoFile: vi.fn(),
    t: (key: string) => key,
  },
}));

vi.mock('../../composables/useAppState', async () => {
  // Wrap in reactive so the component's computed/watch observe Map mutations
  // the tests perform through useAppState().
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

// RepoFileBrowser lives inside RepoDetail, which App.vue renders under
// keep-alive. Simulate that: toggling `show` deactivates/activates the
// component instead of unmounting it.
const Host = defineComponent({
  props: {
    show: { type: Boolean, default: true },
    instanceId: { type: String, default: 'inst-1' },
  },
  setup(props) {
    return () =>
      h(KeepAlive, null, {
        default: () =>
          props.show
            ? h(RepoFileBrowser, {
                instanceId: props.instanceId,
                owner: 'owner',
                repo: 'repo',
                branches: ['main'],
                defaultBranch: 'main',
              })
            : h('div', 'placeholder'),
      });
  },
});

function mountHost() {
  return mount(Host, {
    global: {
      plugins: [createTestI18n('en')],
    },
  });
}

async function typeSearch(wrapper: ReturnType<typeof mountHost>, value: string) {
  const input = wrapper.find('vscode-textfield');
  expect(input.exists()).toBe(true);
  (input.element as unknown as { value: string }).value = value;
  await input.trigger('input');
}

describe('RepoFileBrowser debounced search under keep-alive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stateMock.loadRepoContents.mockClear();
    stateMock.loadRepoFileSearch.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the search after the debounce while active', async () => {
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');
    await vi.advanceTimersByTimeAsync(300);

    expect(stateMock.loadRepoFileSearch).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'main', 'foo');
  });

  it('drops the debounced search while deactivated and re-applies it on activation', async () => {
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');

    // Navigate away before the debounce fires: the timer callback must not
    // send a request (props now track the global route).
    await wrapper.setProps({ show: false });
    await wrapper.setProps({ instanceId: 'inst-2' });
    await vi.advanceTimersByTimeAsync(300);
    expect(stateMock.loadRepoFileSearch).not.toHaveBeenCalled();

    // Returning re-applies the dropped query with the current route's params.
    await wrapper.setProps({ show: true });
    expect(stateMock.loadRepoFileSearch).toHaveBeenCalledWith('inst-2', 'owner', 'repo', 'main', 'foo');
  });
});

describe('RepoFileBrowser truncated search', () => {
  beforeEach(() => {
    stateMock.loadRepoFileSearch.mockClear();
    stateMock.repoFileSearchResults.value.clear();
    stateMock.repoFileSearchTruncated.value.clear();
  });

  it('warns that matches may be missing when the tree could not be read fully', async () => {
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');
    const key = 'inst-1:owner/repo:main:search:foo';

    // Write through the reactive state the component reads: mutating the raw
    // Map behind it would not invalidate the already-evaluated computed.
    const state = useAppState() as unknown as {
      repoFileSearchResults: { value: Map<string, unknown[]> };
      repoFileSearchTruncated: { value: Map<string, boolean> };
    };
    state.repoFileSearchResults.value.set(key, [{ path: 'src/foo.ts', sha: 'sha-1' }]);
    state.repoFileSearchTruncated.value.set(key, true);
    await nextTick();

    expect(wrapper.text()).toContain('src/foo.ts');
    expect(wrapper.text()).toContain('dashboard.fileBrowser.searchTruncated');

    // A complete tree (or a fresh search) shows no hint.
    state.repoFileSearchTruncated.value.set(key, false);
    await nextTick();
    expect(wrapper.text()).not.toContain('dashboard.fileBrowser.searchTruncated');
  });
});
