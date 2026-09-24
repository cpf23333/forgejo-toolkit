import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const EXPORTED_INSTANCE = {
  id: 'inst-a',
  name: 'Alpha',
  url: 'https://forgejo.example.com/alpha',
  username: 'demo-user',
  token: 'token',
};

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    importPreview: { value: undefined as unknown },
    instances: { value: [] as unknown[] },
    confirmImportInstances: vi.fn(),
    cancelImportInstances: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  return { useAppState: () => reactive(stateMock) };
});

import ImportPreview from '../ImportPreview.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

function setPreview(preview: Record<string, unknown>) {
  const state = useAppState() as unknown as { importPreview: { value: unknown } };
  state.importPreview.value = {
    instances: [{ ...EXPORTED_INSTANCE }],
    existingIds: [],
    ...preview,
  };
}

function mountView() {
  return mount(ImportPreview, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
}

/**
 * The skipped-entry warning was the `role="status"` region, and its text was
 * rendered with it — the case an assistive technology is allowed to miss,
 * because it has to observe the region before its content changes. The preview
 * only ever learns the count together with the entries it belongs to, so the
 * sentence is now held back for one render: the region is in the document, empty,
 * before the announcement is put into it.
 */
describe('ImportPreview dropped-entry announcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.importPreview.value = undefined;
    stateMock.instances.value = [];
  });

  it('shows no live region when nothing was dropped', async () => {
    setPreview({ dropped: 0 });

    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.find('.dropped-warning').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders the region empty first and fills it on the next render', async () => {
    setPreview({ dropped: 3 });

    const wrapper = mountView();

    // The count arrives with the preview, but the region still exists before its
    // text does: that is what makes the announcement reliable.
    const region = wrapper.get('.dropped-warning');
    expect(region.attributes('role')).toBe('status');
    expect(region.attributes('aria-live')).toBe('polite');
    expect(region.text()).toBe('');

    await nextTick();
    expect(wrapper.get('.dropped-warning').text()).toContain('3 entry(ies) in this file could not be used');

    wrapper.unmount();
  });

  it('stays quiet on the failed-read state, where the warning is not shown', async () => {
    setPreview({ instances: [], dropped: 2, error: 'invalid password' });

    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.find('.dropped-warning').exists()).toBe(false);

    wrapper.unmount();
  });

  it('carries the warning text exactly once, with no hidden duplicate', async () => {
    setPreview({ dropped: 2 });

    const wrapper = mountView();
    await nextTick();

    const warning = wrapper.get('.dropped-warning');
    // The region is the visible warning: the sentence is not repeated in a
    // second, hidden copy.
    expect(warning.text()).toContain('2 entry(ies)');
    expect(wrapper.findAll('[role="status"]')).toHaveLength(1);

    wrapper.unmount();
  });
});
