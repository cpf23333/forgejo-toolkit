import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
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
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

function mountView() {
  return mount(Onboarding, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { TokenScopeList: true, ImportPreview: true },
    },
  });
}

function nextButton(wrapper: VueWrapper) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Next');
  expect(button, 'Next button').toBeTruthy();
  return button!;
}

/**
 * The wizard renders one step at a time, so every control of every step has to
 * carry its own accessible name (see `Settings.controlLabels.test.ts` for why a
 * neighbouring `<label>`/heading is not enough for a `vscode-*` control).
 */
describe('Onboarding form control accessible names', () => {
  it('names the language, server and worktree controls of every step', async () => {
    const wrapper = mountView();
    await nextTick();

    const languageSelect = wrapper.find('vscode-single-select');
    expect(languageSelect.attributes('label')).toBe('Language');

    await nextButton(wrapper).trigger('click');
    await nextTick();
    expect(wrapper.get('#onboarding-url').attributes('label')).toBe('Instance URL');
    expect(wrapper.get('#onboarding-token').attributes('label')).toBe('Access Token');

    await nextButton(wrapper).trigger('click');
    await nextTick();
    expect(wrapper.get('#onboarding-worktree-open-mode').attributes('label')).toBe('Open mode');
    expect(wrapper.get('#onboarding-worktree-cache-directory').attributes('label')).toBe('Cache directory');

    wrapper.unmount();
  });

  it('leaves no select or textfield of any step unnamed', async () => {
    const wrapper = mountView();
    await nextTick();

    for (const step of [0, 1, 2]) {
      const controls = wrapper.findAll('vscode-single-select, vscode-textfield');
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.attributes('label'), `step ${step}: ${control.html()}`).toBeTruthy();
      }
      await nextButton(wrapper).trigger('click');
      await nextTick();
    }

    wrapper.unmount();
  });
});
