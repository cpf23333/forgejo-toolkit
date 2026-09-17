import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive } from 'vue';
import RepoFileBrowser from '../RepoFileBrowser.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    repoContents: { value: new Map<string, unknown[]>() },
    repoFileSearchResults: { value: new Map<string, unknown[]>() },
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
