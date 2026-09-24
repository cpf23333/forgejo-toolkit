import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] },
    importPreview: { value: undefined },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
    worktreeOpenMode: { value: 'ask' },
    changeWorktreeOpenMode: vi.fn(),
    worktreeCacheDirectory: { value: '' },
    worktreeCacheDirectoryDefault: { value: '' },
    setWorktreeCacheDirectory: vi.fn(),
    browseWorktreeCacheDirectory: vi.fn(),
    worktrees: { value: [] },
    lastWorktreeError: { value: undefined },
    openWorktreePath: vi.fn(),
    removeWorktree: vi.fn(),
    testConnectionResult: { value: undefined },
    saveInstanceResult: { value: undefined },
    exportInstancesResult: { value: undefined },
    importInstancesResult: { value: undefined },
    testConnection: vi.fn(),
    saveInstance: vi.fn(),
    editInstance: vi.fn(),
    removeInstance: vi.fn(),
    openExternal: vi.fn(),
    previewImportInstances: vi.fn(),
    exportInstances: vi.fn(),
    copyInstancesToClipboard: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useAppState')>();
  const { reactive: makeReactive } = await import('vue');
  return { ...actual, useAppState: () => makeReactive(stateMock) };
});

import Settings from '../Settings.vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

async function typeUrl(wrapper: VueWrapper, value: string) {
  const input = wrapper.get('#forgejo-url');
  (input.element as HTMLInputElement).value = value;
  await input.trigger('input');
  await nextTick();
}

/**
 * The token-settings link is built from what the user typed into the instance
 * form. A saved instance URL can carry credentials (`https://token@host`), and a
 * browser cannot open the masked form of it — the link is a URL the webview
 * *uses*, so the credential has to be stripped out of it.
 */
describe('Settings token-settings link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the token page without the credential the user typed', async () => {
    const wrapper = mountView();
    await typeUrl(wrapper, 'https://s3cret-token@forgejo.example.com');

    await wrapper.get('.token-create-link').trigger('click');
    await nextTick();

    expect(stateMock.openExternal).toHaveBeenCalledWith('https://forgejo.example.com/user/settings/applications');
    expect(stateMock.openExternal.mock.calls[0][0]).not.toContain('s3cret-token');
    expect(stateMock.openExternal.mock.calls[0][0]).not.toContain('@');
    wrapper.unmount();
  });

  it('keeps a credential-free URL untouched', async () => {
    const wrapper = mountView();
    await typeUrl(wrapper, 'https://forgejo.example.com:3000');

    await wrapper.get('.token-create-link').trigger('click');
    await nextTick();

    expect(stateMock.openExternal).toHaveBeenCalledWith('https://forgejo.example.com:3000/user/settings/applications');
    wrapper.unmount();
  });

  it('offers no link until an http(s) URL is typed', async () => {
    const wrapper = mountView();
    await typeUrl(wrapper, 'forgejo.example.com');

    expect(wrapper.find('.token-create-link').exists()).toBe(false);
    wrapper.unmount();
  });
});
