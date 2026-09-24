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
    // The cause of an incomplete search result, not a boolean: the wording
    // differs between a capped match list and an unreadable tree.
    repoFileSearchTruncated: { value: new Map<string, 'matches' | 'tree'>() },
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
    branches: { type: Array as unknown as () => string[], default: () => ['main'] },
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
                branches: props.branches,
                defaultBranch: 'main',
              })
            : h('div', 'placeholder'),
      });
  },
});

function mountHost(props: Record<string, unknown> = {}) {
  return mount(Host, {
    props,
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
  const KEY = 'inst-1:owner/repo:main:search:foo';

  beforeEach(() => {
    stateMock.loadRepoFileSearch.mockClear();
    stateMock.repoFileSearchResults.value.clear();
    stateMock.repoFileSearchTruncated.value.clear();
  });

  function setTruncated(cause: 'matches' | 'tree' | undefined) {
    const state = useAppState() as unknown as {
      repoFileSearchResults: { value: Map<string, unknown[]> };
      repoFileSearchTruncated: { value: Map<string, 'matches' | 'tree'> };
    };
    // Write through the reactive state the component reads: mutating the raw
    // Map behind it would not invalidate the already-evaluated computed.
    state.repoFileSearchResults.value.set(KEY, [{ path: 'src/foo.ts', sha: 'sha-1' }]);
    if (cause === undefined) {
      state.repoFileSearchTruncated.value.delete(KEY);
    } else {
      state.repoFileSearchTruncated.value.set(KEY, cause);
    }
  }

  it('names the capped match list, not an unreadable tree, when matches were capped', async () => {
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');
    setTruncated('matches');
    await nextTick();

    expect(wrapper.text()).toContain('src/foo.ts');
    // The common case: a perfectly readable tree with more than the cap worth of
    // matches. "The tree is too large to read" is false here and nothing the
    // user can act on; the cap itself is the cause.
    expect(wrapper.text()).toContain('dashboard.fileBrowser.searchTruncatedByMatches');
    // The hint is exactly the capped-matches sentence: `searchTruncated` is a
    // prefix of `searchTruncatedByMatches`, so a substring check cannot tell the
    // two apart.
    expect(wrapper.get('.tree-status').text()).toBe('dashboard.fileBrowser.searchTruncatedByMatches');

    wrapper.unmount();
  });

  it('keeps the tree wording when the tree itself could not be read', async () => {
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');
    setTruncated('tree');
    await nextTick();

    expect(wrapper.get('.tree-status').text()).toBe('dashboard.fileBrowser.searchTruncated');
    expect(wrapper.text()).not.toContain('dashboard.fileBrowser.searchTruncatedByMatches');

    wrapper.unmount();
  });

  it('falls back to the default wording when truncatedBy is absent', async () => {
    // What a reply without `truncatedBy` stores (hand-built payloads): the hint
    // must default to today's tree wording instead of disappearing or rendering a
    // raw key. `useAppState` maps a bare `truncated: true` to `'tree'`; this is
    // the defensive default in the view for any other writer.
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');
    const state = useAppState() as unknown as {
      repoFileSearchResults: { value: Map<string, unknown[]> };
      repoFileSearchTruncated: { value: Map<string, string> };
    };
    state.repoFileSearchResults.value.set(KEY, [{ path: 'src/foo.ts', sha: 'sha-1' }]);
    // A value the union does not know about stands in for an absent/unknown cause.
    state.repoFileSearchTruncated.value.set(KEY, 'unexpected');
    await nextTick();

    expect(wrapper.get('.tree-status').text()).toBe('dashboard.fileBrowser.searchTruncated');

    wrapper.unmount();
  });

  it('shows no hint for a complete result', async () => {
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');
    setTruncated(undefined);
    await nextTick();

    expect(wrapper.text()).toContain('src/foo.ts');
    expect(wrapper.find('.tree-status').exists()).toBe(false);

    wrapper.unmount();
  });
});

/**
 * `vscode-tree-item` is a custom element: every entry costs a host element and a
 * shadow root even while a collapsed branch hides it with CSS, and the host
 * reply for a directory is uncapped. A directory with thousands of entries used
 * to mount one element per entry in a single render, which froze the panel.
 */
describe('RepoFileBrowser directory entry cap', () => {
  const ROOT_KEY = 'inst-1:owner/repo:main:';
  const CAP = 200;

  beforeEach(() => {
    stateMock.loadRepoContents.mockClear();
    stateMock.repoContents.value.clear();
  });

  function setRootEntries(count: number) {
    const state = useAppState() as unknown as { repoContents: { value: Map<string, unknown[]> } };
    state.repoContents.value.set(
      ROOT_KEY,
      Array.from({ length: count }, (_, i) => ({
        name: `file-${i}.ts`,
        path: `file-${i}.ts`,
        type: 'file',
        size: 1,
        sha: `sha-${i}`,
      })),
    );
  }

  it('mounts one batch of rows for a huge directory and keeps the rest reachable', async () => {
    setRootEntries(5000);
    const wrapper = mountHost();
    await nextTick();

    // 5k entries must not become 5k custom elements in one render.
    const rows = wrapper.findAll('vscode-tree-item');
    expect(rows.length).toBe(CAP + 1); // the batch plus the "show more" row
    expect(wrapper.text()).toContain('file-0.ts');
    expect(wrapper.text()).not.toContain('file-200.ts');

    // Every entry stays reachable: the rest arrives in batches of the same size.
    // (The state mock's `t` returns the key, so the batch size shows up as the
    // interpolation argument rather than in the text.)
    const showMore = wrapper.get('.tree-show-more');
    expect(showMore.text()).toContain('dashboard.fileBrowser.showMore');
    for (let batch = 0; batch < 3; batch++) {
      await showMore.trigger('click');
      await nextTick();
    }
    expect(wrapper.findAll('vscode-tree-item').length).toBe(CAP * 4 + 1);
    expect(wrapper.text()).toContain('file-799.ts');

    wrapper.unmount();
  });

  it('renders a directory of exactly the cap without a "show more" row', async () => {
    setRootEntries(CAP);
    const wrapper = mountHost();
    await nextTick();

    expect(wrapper.findAll('vscode-tree-item')).toHaveLength(CAP);
    expect(wrapper.find('.tree-show-more').exists()).toBe(false);
    wrapper.unmount();
  });

  it('activates the "show more" row from the keyboard', async () => {
    // The row lives inside `<vscode-tree>`, whose host keydown handler stops the
    // key on the tree item and treats Enter/Space as item selection, so a nested
    // button never receives the browser's own keyboard activation. The capture
    // listener on the tree has to fire it instead.
    setRootEntries(5000);
    const wrapper = mountHost();
    await nextTick();

    const showMore = wrapper.get('.tree-show-more');
    expect(wrapper.findAll('vscode-tree-item')).toHaveLength(CAP + 1);

    await showMore.trigger('keydown', { key: 'Enter' });
    await nextTick();
    expect(wrapper.findAll('vscode-tree-item')).toHaveLength(CAP * 2 + 1);

    await showMore.trigger('keydown', { key: ' ' });
    await nextTick();
    expect(wrapper.findAll('vscode-tree-item')).toHaveLength(CAP * 3 + 1);

    // The mouse path still works.
    await showMore.trigger('click');
    await nextTick();
    expect(wrapper.findAll('vscode-tree-item')).toHaveLength(CAP * 4 + 1);

    wrapper.unmount();
  });

  it('does not load a file when the keyboard activates a "show more" row', async () => {
    // Enter/Space over a tree item is also the tree's selection key: activating
    // the row must not fall through to the item-select handler, which would try
    // to open an item that has no file path.
    setRootEntries(5000);
    const wrapper = mountHost();
    await nextTick();
    // Mounting loads the root directory; only what the keypress adds matters.
    stateMock.openRepoFile.mockClear();
    stateMock.loadRepoContents.mockClear();

    await wrapper.get('.tree-show-more').trigger('keydown', { key: 'Enter' });
    await nextTick();

    expect(stateMock.openRepoFile).not.toHaveBeenCalled();
    expect(stateMock.loadRepoContents).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

/**
 * The results panel reads the payload for the current query **and** ref, but a
 * request is only sent by the input debounce or on activation. After a branch
 * switch - or a keep-alive round trip that dropped the cached page - there is no
 * payload for what is on screen, and the panel used to render "No matching
 * files" for a search that had never run, with no way to trigger it.
 */
describe('RepoFileBrowser search that has not run', () => {
  const MAIN_KEY = 'inst-1:owner/repo:main:search:foo';

  beforeEach(() => {
    vi.useFakeTimers();
    stateMock.loadRepoFileSearch.mockClear();
    stateMock.repoFileSearchResults.value.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setResults(key: string, rows: unknown[]) {
    const state = useAppState() as unknown as { repoFileSearchResults: { value: Map<string, unknown[]> } };
    state.repoFileSearchResults.value.set(key, rows);
  }

  function dropResults(key: string) {
    const state = useAppState() as unknown as { repoFileSearchResults: { value: Map<string, unknown[]> } };
    state.repoFileSearchResults.value.delete(key);
  }

  it('offers the search instead of claiming no matches after a branch switch', async () => {
    setResults(MAIN_KEY, [{ path: 'src/foo.ts', sha: 'sha-1' }]);
    const wrapper = mountHost({ branches: ['main', 'feature'] });
    await typeSearch(wrapper, 'foo');
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(wrapper.text()).toContain('src/foo.ts');

    // The search that ran belongs to `main`; `feature` has no results yet.
    stateMock.loadRepoFileSearch.mockClear();
    const branchSelect = wrapper.get('.branch-select');
    (branchSelect.element as HTMLInputElement).value = 'feature';
    await branchSelect.trigger('change');
    await nextTick();

    expect(wrapper.text()).not.toContain('dashboard.fileBrowser.searchNoResults');
    expect(wrapper.text()).toContain('dashboard.fileBrowser.searchNotRun');

    await wrapper.get('.search-run-button').trigger('click');
    expect(stateMock.loadRepoFileSearch).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'feature', 'foo');
    wrapper.unmount();
  });

  it('offers the search again after a keep-alive round trip dropped the results', async () => {
    setResults(MAIN_KEY, [{ path: 'src/foo.ts', sha: 'sha-1' }]);
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');
    await nextTick();
    expect(wrapper.text()).toContain('src/foo.ts');

    // Away and back, with the bounded payload map evicting the page meanwhile.
    await wrapper.setProps({ show: false });
    dropResults(MAIN_KEY);
    await wrapper.setProps({ show: true });
    await nextTick();

    expect(wrapper.text()).not.toContain('dashboard.fileBrowser.searchNoResults');
    expect(wrapper.text()).toContain('dashboard.fileBrowser.searchNotRun');

    stateMock.loadRepoFileSearch.mockClear();
    await wrapper.get('.search-run-button').trigger('click');
    expect(stateMock.loadRepoFileSearch).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'main', 'foo');
    wrapper.unmount();
  });

  it('still reports an answered search that found nothing', async () => {
    setResults(MAIN_KEY, []);
    const wrapper = mountHost();
    await typeSearch(wrapper, 'foo');
    await nextTick();

    expect(wrapper.text()).toContain('dashboard.fileBrowser.searchNoResults');
    expect(wrapper.text()).not.toContain('dashboard.fileBrowser.searchNotRun');
    expect(wrapper.find('.search-run-button').exists()).toBe(false);
    wrapper.unmount();
  });
});
