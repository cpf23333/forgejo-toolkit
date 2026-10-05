import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as unknown[] },
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
    worktreeCacheDirectoryDefault: { value: '/host/default' },
    setWorktreeCacheDirectory: vi.fn(),
    browseWorktreeCacheDirectory: vi.fn(),
    worktrees: { value: [] as unknown[] },
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
    // the worktree cache directory, so the row stays empty here.
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
  },
}));

vi.mock('../../composables/useAppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useAppState')>();
  const { reactive: makeReactive } = await import('vue');
  return {
    ...actual,
    useAppState: () => makeReactive(stateMock),
  };
});

import Settings from '../Settings.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

const SELECTOR = '#worktree-cache-directory';

/**
 * Writes must go through the reactive proxy the view reads: mutating the raw
 * mock would not notify its watchers. `vi.mock` replaces `useAppState` with
 * `reactive(stateMock)`, which is the same proxy on every call.
 */
function state() {
  return useAppState() as unknown as { worktreeCacheDirectory: { value: string } };
}

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

function fieldValue(wrapper: VueWrapper, selector: string): string {
  const field = wrapper.find(selector);
  const property = (field.element as unknown as { value?: string }).value;
  if (property !== undefined) {
    return String(property);
  }
  return field.attributes('value') ?? '';
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string) {
  const field = wrapper.find(selector);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
}

/**
 * The host validates the cache directory: an unusable path gets a native error
 * and *no* reply, while an accepted one is answered with the directory now in
 * use. The field re-synced from state only when a truthy value arrived, so a
 * rejected path stayed on screen while new worktrees still went to the previous
 * directory. After applying, the field falls back to the directory the host
 * actually has; the reply of an accepted path re-syncs it.
 */
describe('Settings worktree cache directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.worktreeCacheDirectory.value = '/host/current';
    stateMock.worktreeCacheDirectoryDefault.value = '/host/default';
  });

  it('falls back to the directory in use when the host rejects the new path', async () => {
    // A rejected path is answered with a native error and nothing else.
    stateMock.setWorktreeCacheDirectory.mockImplementation(() => {});
    const wrapper = mountView();
    await nextTick();
    expect(fieldValue(wrapper, SELECTOR)).toBe('/host/current');

    await typeInto(wrapper, SELECTOR, '/rejected/path');
    await wrapper.find(SELECTOR).trigger('change');
    await nextTick();

    expect(stateMock.setWorktreeCacheDirectory).toHaveBeenCalledWith('/rejected/path');
    expect(fieldValue(wrapper, SELECTOR)).toBe('/host/current');
    wrapper.unmount();
  });

  it('shows the directory the host confirmed for an accepted path', async () => {
    // The host reply carries the directory that is now in use.
    stateMock.setWorktreeCacheDirectory.mockImplementation((directory: string) => {
      state().worktreeCacheDirectory.value = directory;
    });
    const wrapper = mountView();
    await nextTick();

    await typeInto(wrapper, SELECTOR, '/accepted/path');
    await wrapper.find(SELECTOR).trigger('change');
    await nextTick();

    expect(stateMock.setWorktreeCacheDirectory).toHaveBeenCalledWith('/accepted/path');
    expect(fieldValue(wrapper, SELECTOR)).toBe('/accepted/path');
    wrapper.unmount();
  });
});
