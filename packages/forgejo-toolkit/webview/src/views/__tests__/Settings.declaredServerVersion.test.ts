import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The declared server version on the instance editor: the escape hatch for the
 * automatic probe (`/api/v1/version` blocked by a reverse proxy, an
 * unrecognised fork, a timeout). The editor has one job — carry the field to the
 * host, prefill it from the record, and show the host's refusal when the value
 * cannot be a version — because the host owns the rule and the readable message.
 *
 * The field lives in the editor, not in the list: editing a row switches this
 * surface to the editor, and the new-instance mode of that same editor is what
 * "Add Instance" opens.
 */
const INSTANCE_DECLARED = {
  id: 'inst-declared',
  name: 'Declared',
  url: 'https://forgejo.example.com/declared',
  declaredServerVersion: '16.0.2+gitea-1.22.0',
};
const INSTANCE_PLAIN = { id: 'inst-plain', name: 'Plain', url: 'https://forgejo.example.com/plain' };

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
    settingsRefreshTick: { value: 0 },
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
    // The floor text the host pushes with `initialState`; the description's
    // example is interpolated from it.
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
    copyToClipboard: vi.fn(),
    previewImportInstances: vi.fn(),
    exportInstances: vi.fn(),
    copyInstancesToClipboard: vi.fn(),
    loadAiPreReviewChatModels: vi.fn(async () => ({ models: [], configured: '' })),
    saveAiPreReviewChatModel: vi.fn(async (value: string) => ({ value })),
    // The settings page reads its own surface on mount and renders the host's
    // reading rather than a value of its own. It is filled in after the imports
    // below: a `vi.hoisted` body runs before this file's imports are
    // initialized, so the complete, typed reading — source map included — can
    // only be built once `settingsSurfaceFixture` exists.
    settingsSurface: { value: undefined as unknown },
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
import { createTestRouter, createTestI18n, settingsSurfaceFixture } from '../../__tests__/helpers/test-utils';

// The host's reading of the settings page's own surface (§3.2): the manifest's
// defaults with the whole source map. It is built here rather than in the
// `vi.hoisted` body above because that body runs before this import exists.
stateMock.settingsSurface.value = settingsSurfaceFixture();

const state = useAppState() as unknown as {
  saveInstanceResult: { value: { success: boolean; error?: string; target?: unknown } | undefined };
  editInstance: ReturnType<typeof vi.fn>;
  saveInstance: ReturnType<typeof vi.fn>;
};

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

async function clickButton(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  await button!.trigger('click');
}

/** Opens the editor from the list's own way in: the "new instance" mode. */
async function clickAdd(wrapper: VueWrapper) {
  await clickButton(wrapper, 'Add Instance');
  await nextTick();
}

/** The Edit button of the nth saved instance. */
async function clickEdit(wrapper: VueWrapper, index: number) {
  const item = wrapper.findAll('.saved-item')[index];
  expect(item, `saved instance ${index}`).toBeTruthy();
  await item.find('vscode-button').trigger('click');
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string) {
  const field = wrapper.find(selector);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
}

function fieldValue(wrapper: VueWrapper, selector: string): string {
  const field = wrapper.find(selector);
  const property = (field.element as unknown as { value?: string }).value;
  if (property !== undefined) {
    return String(property);
  }
  return field.attributes('value') ?? '';
}

describe('Settings declared server version field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.saveInstanceResult.value = undefined;
    stateMock.instances.value = [INSTANCE_DECLARED, INSTANCE_PLAIN];
  });

  it('prefills the record’s declaration and sends it back unchanged on update', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    expect(fieldValue(wrapper, '#forgejo-declared-version')).toBe('16.0.2+gitea-1.22.0');

    await clickButton(wrapper, 'Update Instance');

    expect(state.editInstance).toHaveBeenCalledWith(
      INSTANCE_DECLARED.id,
      INSTANCE_DECLARED.url,
      '',
      true,
      '16.0.2+gitea-1.22.0',
    );
    wrapper.unmount();
  });

  it('prefills nothing for an instance that declares none', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 1);
    expect(fieldValue(wrapper, '#forgejo-declared-version')).toBe('');

    await clickButton(wrapper, 'Update Instance');
    // Empty is sent as such, which is how the host is told to clear the
    // declaration and use the probe again.
    expect(state.editInstance).toHaveBeenCalledWith(INSTANCE_PLAIN.id, INSTANCE_PLAIN.url, '', true, '');
    wrapper.unmount();
  });

  it('sends a cleared field as empty so the declaration can be removed', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    await typeInto(wrapper, '#forgejo-declared-version', '   ');
    await clickButton(wrapper, 'Update Instance');

    expect(state.editInstance).toHaveBeenCalledWith(INSTANCE_DECLARED.id, INSTANCE_DECLARED.url, '', true, '');
    wrapper.unmount();
  });

  it('carries a typed declaration in the new-instance editor', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickAdd(wrapper);
    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/new');
    await typeInto(wrapper, '#forgejo-token', 'new-token');
    await typeInto(wrapper, '#forgejo-declared-version', ' 16.0.2 ');
    await clickButton(wrapper, 'Add Instance');

    expect(state.saveInstance).toHaveBeenCalledWith('https://forgejo.example.com/new', 'new-token', true, '16.0.2');
    wrapper.unmount();
  });

  it('shows the host’s refusal and keeps the typed value on screen', async () => {
    // The host owns the rule (and the readable message); the editor must not
    // silently drop a value it does not understand, so the refusal is rendered
    // where the user is looking and the input stays as typed.
    const refusal =
      'Enter a Forgejo version such as 16.0.0, or leave the field empty to use the automatic version probe.';
    const wrapper = mountView();
    await nextTick();

    await clickAdd(wrapper);
    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/new');
    await typeInto(wrapper, '#forgejo-token', 'new-token');
    await typeInto(wrapper, '#forgejo-declared-version', 'devel');
    await clickButton(wrapper, 'Add Instance');

    state.saveInstanceResult.value = { success: false, error: refusal, target: { kind: 'new' } };
    await nextTick();

    expect(wrapper.text()).toContain(refusal);
    expect(fieldValue(wrapper, '#forgejo-declared-version')).toBe('devel');
    wrapper.unmount();
  });

  it('interpolates the host’s supported floor into the description instead of a literal', async () => {
    // One home for the fact: the example is the host's floor text, so this
    // string cannot keep naming a release the build no longer supports. The
    // placeholder is a shape hint, never that value — it must not read as "type
    // exactly this" on an instance that is far newer.
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);

    const row = wrapper.find('#forgejo-declared-version').element.closest('.form-row');
    const description = row?.querySelector('.field-description')?.textContent ?? '';
    expect(description).toContain(`${stateMock.minSupportedServerVersion.value} is accepted`);
    expect(description).not.toContain('{version}');
    // The old string's second literal, and the placeholder it used: neither may
    // survive in the rendered field.
    expect(description).not.toContain('+gitea-1.22.0');
    expect(wrapper.find('#forgejo-declared-version').attributes('placeholder')).toBe('major.minor.patch');
    wrapper.unmount();
  });

  it('renders no example at all when the host sent no floor', async () => {
    // The field is optional in the message (the panels share its type), so a
    // missing value must degrade to a gap rather than to a raw `{version}`.
    stateMock.minSupportedServerVersion.value = '';
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);

    const row = wrapper.find('#forgejo-declared-version').element.closest('.form-row');
    const description = row?.querySelector('.field-description')?.textContent ?? '';
    expect(description).not.toContain('{version}');
    wrapper.unmount();
    stateMock.minSupportedServerVersion.value = '16.0.0';
  });
});
