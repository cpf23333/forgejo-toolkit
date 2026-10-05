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
    aiProviderSettings: { value: undefined },
    loadAiProviderSettings: vi.fn(async () => ({
      providers: [],
      rejected: [],
      enabled: false,
      transport: 'auto' as const,
      localOnly: false,
      requestTimeoutMs: 30000,
      bindings: [],
      features: ['aiPreReview'],
      capability: { available: true } as const,
      defaultModel: { providerId: '', modelId: '' },
      selection: 'none' as const,
    })),
    saveAiProvider: vi.fn(async (provider: { id: string }) => ({ id: provider.id })),
    removeAiProvider: vi.fn(async () => ({ cancelled: false })),
    setAiProviderSecret: vi.fn(async () => ({ set: true })),
    testAiProvider: vi.fn(async () => ({
      providerId: '',
      providerName: '',
      address: '',
      ok: true,
      ran: true,
      shadowed: [],
    })),
    setAiModelPolicy: vi.fn(async () => ({
      enabled: false,
      transport: 'auto',
      localOnly: false,
      requestTimeoutMs: 30000,
    })),
    setAiModelBinding: vi.fn(async () => ({ feature: 'aiPreReview', providerId: '', modelId: '' })),
    // The supported floor the host pushes with `initialState`; the form's
    // description interpolates it.
    minSupportedServerVersion: { value: '16.0.0' },
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
    // The AI pre-review model row loads its list on mount; this file is about
    // the token settings link, so the row stays empty here.
    loadAiPreReviewChatModels: vi.fn(async () => ({ models: [], configured: '' })),
    saveAiPreReviewChatModel: vi.fn(async (value: string) => ({ value })),
    // The settings page reads its own surface on mount and renders the host's
    // reading rather than a value of its own; the defaults below are the
    // manifest's, so a test that does not care about those sections still mounts
    // a page with the values a fresh install has.
    settingsSurface: {
      value: {
        notificationPollingEnabled: true,
        mcpEnabled: true,
        mcpWriteTools: { createIssueComment: false, submitPullReview: false, cancelActionRun: false },
        mcpWriteAuditToFile: false,
        multiWindowLease: true,
        aiPreReview: false,
        aiPreReviewPromptScope: 'ask',
      },
    },
    loadSettingsSurface: vi.fn(async () => undefined),
    setSettingsSurfaceValue: vi.fn(async () => ({ snapshot: undefined })),
    testAiProviderDraft: vi.fn(async () => ({
      providerId: '',
      providerName: '',
      address: '',
      ok: true,
      ran: true,
      shadowed: [],
    })),
    openNativeSettings: vi.fn(),

    showConfirm: vi.fn(async () => true),
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

/**
 * Opens the instance editor, which is where the URL field and the token link
 * live: the surface shows either the list or the editor, never both.
 */
async function openEditor(wrapper: VueWrapper) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Add Instance');
  expect(button, 'Add Instance button').toBeTruthy();
  await button!.trigger('click');
  await nextTick();
}

async function typeUrl(wrapper: VueWrapper, value: string) {
  const input = wrapper.get('#forgejo-url');
  (input.element as HTMLInputElement).value = value;
  await input.trigger('input');
  await nextTick();
}

/**
 * The token-settings link is built from what the user typed into the instance
 * editor. A saved instance URL can carry credentials (`https://token@host`), and
 * a browser cannot open the masked form of it — the link is a URL the webview
 * *uses*, so the credential has to be stripped out of it.
 */
describe('Settings token-settings link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the token page without the credential the user typed', async () => {
    const wrapper = mountView();
    await openEditor(wrapper);
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
    await openEditor(wrapper);
    await typeUrl(wrapper, 'https://forgejo.example.com:3000');

    await wrapper.get('.token-create-link').trigger('click');
    await nextTick();

    expect(stateMock.openExternal).toHaveBeenCalledWith('https://forgejo.example.com:3000/user/settings/applications');
    wrapper.unmount();
  });

  it('offers no link until an http(s) URL is typed', async () => {
    const wrapper = mountView();
    await openEditor(wrapper);
    await typeUrl(wrapper, 'forgejo.example.com');

    expect(wrapper.find('.token-create-link').exists()).toBe(false);
    wrapper.unmount();
  });
});
