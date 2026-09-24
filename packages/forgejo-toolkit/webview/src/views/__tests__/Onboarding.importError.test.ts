import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as Record<string, unknown>[] },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    worktreeOpenMode: { value: 'ask' },
    changeWorktreeOpenMode: vi.fn(),
    worktreeCacheDirectory: { value: '' },
    worktreeCacheDirectoryDefault: { value: '' },
    setWorktreeCacheDirectory: vi.fn(),
    browseWorktreeCacheDirectory: vi.fn(),
    importPreview: { value: undefined },
    importInstancesResult: { value: undefined },
    testConnectionResult: { value: undefined },
    saveInstanceResult: { value: undefined },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    testConnection: vi.fn(),
    saveInstance: vi.fn(),
    loadRepositories: vi.fn(),
    removeInstance: vi.fn(),
    openExternal: vi.fn(),
    previewImportInstances: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return { useAppState: () => state };
});

import Onboarding from '../Onboarding.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as {
  importInstancesResult: { value: unknown };
  importPreview: { value: unknown };
  previewImportInstances: ReturnType<typeof vi.fn>;
};

function mountView() {
  return mount(Onboarding, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { TokenScopeList: true, ImportPreview: true },
    },
  });
}

/** The wizard starts on the language step; the server step (with the import link) is step 1. */
async function openServerStep() {
  const wrapper = mountView();
  const next = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Next');
  expect(next).toBeTruthy();
  await next!.trigger('click');
  await nextTick();
  return wrapper;
}

function importLink(wrapper: ReturnType<typeof mountView>) {
  const link = wrapper.find('.import-hint a');
  expect(link.exists()).toBe(true);
  return link;
}

/**
 * The host answers an "import from file" attempt with `importInstancesResult`,
 * which carries the concrete reason on failure (unreadable file, wrong
 * password, no usable entries). The view used to handle only `success`, so a
 * failed import left the wizard looking as if the click had done nothing.
 */
describe('Onboarding import failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.importInstancesResult.value = undefined;
    state.importPreview.value = undefined;
  });

  it('renders the reason the host reported instead of staying silent', async () => {
    const wrapper = await openServerStep();
    await importLink(wrapper).trigger('click');
    expect(state.previewImportInstances).toHaveBeenCalledTimes(1);

    state.importInstancesResult.value = {
      success: false,
      error: 'Importing instance Forgejo failed: Incorrect password or corrupted file',
    };
    await nextTick();

    const errorStatus = wrapper.find('.status.error');
    expect(errorStatus.exists()).toBe(true);
    expect(errorStatus.attributes('role')).toBe('alert');
    expect(errorStatus.text()).toContain('Incorrect password or corrupted file');
    wrapper.unmount();
  });

  it('falls back to a localized message when the host sends none', async () => {
    const wrapper = await openServerStep();

    state.importInstancesResult.value = { success: false };
    await nextTick();

    expect(wrapper.find('.status.error').text()).toContain('Failed to import instances');
    wrapper.unmount();
  });

  it('clears the previous failure when another import is started', async () => {
    const wrapper = await openServerStep();

    state.importInstancesResult.value = { success: false, error: 'No valid instances found in file' };
    await nextTick();
    expect(wrapper.find('.status.error').exists()).toBe(true);

    await importLink(wrapper).trigger('click');
    expect(wrapper.find('.status.error').exists()).toBe(false);
    expect(state.previewImportInstances).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('stays quiet for a successful import', async () => {
    const wrapper = await openServerStep();

    state.importInstancesResult.value = { success: true, count: 2 };
    await nextTick();

    expect(wrapper.find('.status.error').exists()).toBe(false);
    wrapper.unmount();
  });
});
