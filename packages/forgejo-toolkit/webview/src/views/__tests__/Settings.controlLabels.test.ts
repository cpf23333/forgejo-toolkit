import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

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
    // accessible names, so the row stays empty here.
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
  return {
    ...actual,
    useAppState: () => makeReactive(stateMock),
  };
});

import Settings from '../Settings.vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import { nextTick } from 'vue';

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

/** Opens the shared instance editor in its "new instance" mode. */
async function openNewEditor(wrapper: ReturnType<typeof mountView>) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Add Instance');
  expect(button, 'Add Instance button').toBeTruthy();
  await button!.trigger('click');
  await nextTick();
}

/**
 * A `vscode-*` form control takes its accessible name only from its own `label`
 * property: the element puts `aria-label=${this.label}` on the focusable control
 * inside its shadow root. A light-DOM `<label for=...>` (or an `aria-label` on
 * the host) names the host node instead, so a screen reader still announced
 * every field below as an unnamed combobox or textbox.
 *
 * The hidden language select is the one field whose text is not in a `<label>`:
 * its section heading ("Language") is the text to reuse. The instance fields are
 * in the editor, which is a state of its own, so it has to be opened first.
 */
describe('Settings form control accessible names', () => {
  it('names every select and textfield with the text shown beside it', async () => {
    const wrapper = mountView();

    // The list state's controls are named too.
    expect(wrapper.get('.setting-section vscode-single-select').attributes('label')).toBe('Language');

    await openNewEditor(wrapper);

    // No control may be left unnamed, including any added later.
    const controls = wrapper.findAll('vscode-single-select, vscode-textfield');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.attributes('label'), control.html()).toBeTruthy();
    }

    expect(wrapper.get('#forgejo-url').attributes('label')).toBe('Instance URL');
    expect(wrapper.get('#forgejo-token').attributes('label')).toBe('Access Token');

    // The neighbouring text is still what the user sees; the label repeats it.
    expect(wrapper.get('label[for="forgejo-token"]').text()).toBe('Access Token');

    wrapper.unmount();
  });

  it('names the worktree controls in the list state', () => {
    const wrapper = mountView();

    expect(wrapper.get('#worktree-open-mode').attributes('label')).toBe('Open mode');
    expect(wrapper.get('#worktree-cache-directory').attributes('label')).toBe('Cache directory');
    // The neighbouring text is still what the user sees; the label repeats it.
    expect(wrapper.get('label[for="worktree-open-mode"]').text()).toBe('Open mode');

    wrapper.unmount();
  });
});
