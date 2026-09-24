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

/** The reactive proxy the view reads (mutating the raw mock would not notify it). */
function state() {
  return useAppState() as unknown as { importPreview: { value: unknown } };
}

function mountView() {
  return mount(ImportPreview, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
}

function setPreview(settings: Record<string, unknown>) {
  state().importPreview.value = {
    instances: [{ ...EXPORTED_INSTANCE }],
    existingIds: [],
    settings,
  };
}

/**
 * The preview's `settings` is a raw cast of the imported file (the host only
 * validates the values when it applies them, see `src/webview/instanceImport.ts`).
 * `t('locales.' + settings.locale)` therefore rendered the literal key — a file
 * with `"locale": "ja"` showed `locales.ja` — because vue-i18n falls back to the
 * key itself for a missing message. An unknown locale is left out of the summary
 * instead.
 */
describe('ImportPreview imported locale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.importPreview.value = undefined;
    stateMock.instances.value = [];
  });

  it('never shows a raw i18n key for an unsupported locale', async () => {
    setPreview({ locale: 'ja' });
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.text()).not.toContain('locales.ja');
    expect(wrapper.text()).not.toContain('Language');
    wrapper.unmount();
  });

  it('still shows the translated name of a supported locale', async () => {
    setPreview({ locale: 'zh' });
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.text()).toContain('Language');
    expect(wrapper.text()).toContain('中文');
    wrapper.unmount();
  });

  it('renders the other imported settings next to a skipped locale', async () => {
    setPreview({ locale: 'ja', debug: true, worktreeCacheDirectory: '/tmp/worktrees' });
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.text()).toContain('/tmp/worktrees');
    expect(wrapper.text()).toContain('Debug');
    wrapper.unmount();
  });
});
