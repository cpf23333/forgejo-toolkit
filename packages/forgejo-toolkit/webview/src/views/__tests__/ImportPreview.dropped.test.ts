import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function state() {
  return useAppState() as unknown as { importPreview: { value: unknown } };
}

function mountView() {
  return mount(ImportPreview, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
}

/** The `importPreview` state the host reply for `previewImportInstances` writes. */
function setPreview(preview: Record<string, unknown>) {
  state().importPreview.value = {
    instances: [{ ...EXPORTED_INSTANCE }],
    existingIds: [],
    ...preview,
  };
}

/**
 * The host's `importPreview` reply may carry `dropped?: number`: entries in the
 * file it could not use because required fields were missing or wrongly typed.
 * Those entries never reach `instances`, so before this the preview looked like a
 * complete read of the file and the user confirmed an import that had silently
 * lost rows.
 *
 * The host's own half may not be wired yet, so these tests drive the webview
 * state directly with the exact field the contract names (`dropped`) and assert
 * on what the view renders.
 */
describe('ImportPreview dropped entries warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.importPreview.value = undefined;
    stateMock.instances.value = [];
  });

  it('warns how many entries were skipped', async () => {
    setPreview({ dropped: 3 });
    const wrapper = mountView();
    await nextTick();

    const warning = wrapper.find('.dropped-warning');
    expect(warning.exists()).toBe(true);
    // "could not be used", not "required fields were missing": the count also
    // covers entries whose fields were wrongly typed and entries that were not
    // objects at all, so naming one cause claimed more than the host reported.
    // The `(ies)` spelling follows the other counted strings in `en.json`
    // (`instance(s)`, `attachment(s)`, `approval(s)`), which this project does not
    // pluralize through vue-i18n's `plural` forms.
    expect(warning.text()).toContain('3 entry(ies) in this file could not be used and were skipped');
    wrapper.unmount();
  });

  it('shows the warning above the list, before the user can confirm', async () => {
    setPreview({ dropped: 2 });
    const wrapper = mountView();
    await nextTick();

    const html = wrapper.html();
    expect(html.indexOf('dropped-warning')).toBeGreaterThan(-1);
    expect(html.indexOf('dropped-warning')).toBeLessThan(html.indexOf('instance-list'));
    wrapper.unmount();
  });

  it('stays quiet when the host reported nothing dropped', async () => {
    setPreview({ dropped: 0 });
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.dropped-warning').exists()).toBe(false);
    wrapper.unmount();
  });

  it('stays quiet when the reply does not carry the field', async () => {
    // A pre-contract host reply has no `dropped` at all; "unreported" must not be
    // read as "something was dropped".
    setPreview({});
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.dropped-warning').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not warn on the failed-read error state', async () => {
    setPreview({ instances: [], dropped: 2, error: 'invalid password' });
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.error-state').exists()).toBe(true);
    expect(wrapper.find('.dropped-warning').exists()).toBe(false);
    wrapper.unmount();
  });
});
