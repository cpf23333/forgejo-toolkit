import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoContentEntry } from '../../types/api';

async function mountFileTreeItem(props: Record<string, unknown> = {}) {
  vi.resetModules();
  const [{ default: FileTreeItem }, { useAppState, repoContentsKey: keyFn }] = await Promise.all([
    import('../FileTreeItem.vue'),
    import('../../composables/useAppState'),
  ]);
  const router = createTestRouter();
  const i18n = createTestI18n();
  const wrapper = mount(FileTreeItem, {
    props: {
      instanceId: 'test-instance',
      owner: 'owner',
      repo: 'repo',
      branchRef: 'main',
      level: 0,
      ...props,
    } as any,
    global: {
      plugins: [router, i18n],
    },
  });
  await flushPromises();
  return { wrapper, state: useAppState(), keyFn };
}

describe('FileTreeItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a file entry with a history action', async () => {
    const entry: ForgejoContentEntry = {
      name: 'README.md',
      path: 'README.md',
      type: 'file',
      size: 42,
      sha: 'abc',
    };

    const { wrapper } = await mountFileTreeItem({ entry });

    expect(wrapper.text()).toContain('README.md');
    expect(wrapper.find('.tree-action').exists()).toBe(true);
  });

  it('renders a directory entry without history action', async () => {
    const entry: ForgejoContentEntry = {
      name: 'src',
      path: 'src',
      type: 'dir',
      sha: 'def',
    };

    const { wrapper } = await mountFileTreeItem({ entry });

    expect(wrapper.text()).toContain('src');
    expect(wrapper.find('.tree-action').exists()).toBe(false);
  });

  it('shows loading placeholder while directory children are loading', async () => {
    const entry: ForgejoContentEntry = {
      name: 'src',
      path: 'src',
      type: 'dir',
      sha: 'def',
    };

    const { wrapper, state, keyFn } = await mountFileTreeItem({ entry });
    const key = keyFn('test-instance', 'owner', 'repo', 'main', 'src');
    state.loading.set(key, true);
    await nextTick();

    expect(wrapper.text()).toContain('加载中...');
  });

  it('renders child entries when directory contents are available', async () => {
    const entry: ForgejoContentEntry = {
      name: 'src',
      path: 'src',
      type: 'dir',
      sha: 'def',
    };
    const child: ForgejoContentEntry = {
      name: 'index.ts',
      path: 'src/index.ts',
      type: 'file',
      size: 10,
      sha: 'ghi',
    };

    const { wrapper, state, keyFn } = await mountFileTreeItem({ entry });
    const key = keyFn('test-instance', 'owner', 'repo', 'main', 'src');
    state.repoContents.value.set(key, [child]);
    await nextTick();

    expect(wrapper.text()).toContain('index.ts');
  });

  it('emits show-history when history action is clicked', async () => {
    const entry: ForgejoContentEntry = {
      name: 'README.md',
      path: 'README.md',
      type: 'file',
      size: 42,
      sha: 'abc',
    };

    const { wrapper } = await mountFileTreeItem({ entry });

    await wrapper.find('.tree-action').trigger('click');

    expect(wrapper.emitted('showHistory')).toHaveLength(1);
    expect((wrapper.emitted('showHistory')![0] as ForgejoContentEntry[])[0].name).toBe('README.md');
  });
});
