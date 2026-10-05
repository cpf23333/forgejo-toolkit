import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const INSTANCE_A = { id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha' };
const INSTANCE_B = { id: 'inst-b', name: 'Beta', url: 'https://forgejo.example.com/beta' };

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
      transport: 'auto' as const,
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
      transport: 'auto',
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
    // The AI pre-review model row loads its list on mount; this file is about a
    // removed instance, so the row stays empty here.
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
        aiEnabled: true,
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

    // The editor closes on a removal without asking (the record is already
    // gone); this is here so a regression that starts prompting is visible as a
    // call rather than as a silent close.
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
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

type TestInstance = { id: string; name: string; url: string };

/**
 * Writes must go through the reactive proxy the view reads: mutating the raw
 * mock would not notify its watchers. `vi.mock` replaces `useAppState` with
 * `reactive(stateMock)`, which is the same proxy on every call.
 */
function state() {
  return useAppState() as unknown as { instances: { value: TestInstance[] } };
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

function headings(wrapper: VueWrapper): string[] {
  return wrapper.findAll('h2').map((heading) => heading.text());
}

/**
 * Opens a row's editor. It is a different state of the surface now, not an
 * inline form: the fields only exist while the editor is open, and the list is
 * not rendered beside them.
 */
async function clickEdit(wrapper: VueWrapper, index: number) {
  const item: DOMWrapper<Element> | undefined = wrapper.findAll('.saved-item')[index];
  expect(item, `saved instance ${index}`).toBeTruthy();
  await item!.find('vscode-button').trigger('click');
  await nextTick();
}

const EDITOR_TITLE = 'Edit Instance';

/**
 * The editor is bound to an instance record. Removing that instance from the
 * list (the host re-sends `instances` after a removal) left the editor open on a
 * record that no longer exists, so its Update and Test buttons answered "Instance
 * not found" (see the host's `editInstance` handler). The editor closes with its
 * record, and does so without a discard prompt: the record is already gone.
 */
describe('Settings instance editor for a removed instance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.instances.value = [{ ...INSTANCE_A }, { ...INSTANCE_B }];
  });

  it('closes the editor when its instance disappears from the list', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    expect(headings(wrapper)).toContain(EDITOR_TITLE);
    expect(wrapper.find('.editor-subject-name').text()).toBe(INSTANCE_A.name);
    expect(fieldValue(wrapper, '#forgejo-url')).toBe(INSTANCE_A.url);

    // The user removes Alpha (confirmed host-side); the refreshed list no
    // longer carries it.
    state().instances.value = [{ ...INSTANCE_B }];
    await nextTick();

    // Back to the list, with the removed instance's editor gone: no fields for a
    // record that no longer exists, and the remaining instance still listed.
    expect(wrapper.find('.instance-editor').exists()).toBe(false);
    expect(wrapper.find('#forgejo-url').exists()).toBe(false);
    expect(wrapper.find('.settings-list').exists()).toBe(true);
    expect(wrapper.findAll('.saved-item')).toHaveLength(1);
    expect(wrapper.text()).toContain(INSTANCE_B.name);
    expect(wrapper.text()).not.toContain(INSTANCE_A.name);
    // A removal is not a user-initiated discard, so nothing was asked.
    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps the editor open when its instance is still listed', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);

    // An unrelated refresh (another instance was added/edited) must not close
    // the editor the user is working in.
    state().instances.value = [{ ...INSTANCE_A }, { ...INSTANCE_B }];
    await nextTick();

    expect(headings(wrapper)).toContain(EDITOR_TITLE);
    expect(fieldValue(wrapper, '#forgejo-url')).toBe(INSTANCE_A.url);
    wrapper.unmount();
  });
});
