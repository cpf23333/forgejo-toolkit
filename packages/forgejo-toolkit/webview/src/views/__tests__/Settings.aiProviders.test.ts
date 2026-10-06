import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

/**
 * The AI endpoint section of the Settings page: the endpoint list (master), the
 * endpoint editor (detail) and the §9.3 block.
 *
 * The four properties the section exists for, and what each test pins:
 *
 * 1. **Secrets are never echoed.** A stored key and a stored header value are shown
 *    as "set", never as a value: the fields start empty, the page says so in words,
 *    and the only control that touches a stored value is the one that clears it.
 * 2. **What was ignored is visible.** The reader's rejected entries and the
 *    transport's shadowed header names are rendered where the user can act on them,
 *    rather than leaving a provider that silently does nothing.
 * 3. **The §9.3 block branches on the host's reason code**, and configures nothing:
 *    its buttons open the editor or re-read the offered models, and neither writes
 *    a policy.
 * 4. **The test-connection report is the transport's own reading** — status, elapsed
 *    time, the summary or the reason, and the address — with no credential in it.
 *
 * `useAppState` is mocked the way every other Settings test mocks it. The mock's
 * `loadAiProviderSettings` fills the same state ref the real host push does, so the
 * component under test renders the snapshot exactly as it would in production.
 */

interface SnapshotShape {
  providers: unknown[];
  rejected: unknown[];
  transport: 'auto' | 'vscode-lm' | 'openai-compatible';
  requestTimeoutMs: number;
  /** The default destination every feature without an override follows (§8.4). */
  defaultModel: { providerId: string; modelId: string };
  bindings: unknown[];
  features: string[];
  selection: 'editor' | 'configured-endpoint' | 'none';
  capability: unknown;
}

const { stateMock, snapshot } = vi.hoisted(() => {
  const holder: { current: unknown } = { current: undefined };
  const mock = {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
    settingsRefreshTick: { value: 0 },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
    aiProviderSettings: { value: undefined as unknown },
    loadAiProviderSettings: vi.fn(async () => {
      mock.aiProviderSettings.value = holder.current;
      return holder.current;
    }),
    saveAiProvider: vi.fn(async (provider: { id: string }) => ({ id: provider.id })),
    removeAiProvider: vi.fn(async () => ({ cancelled: false })),
    setAiProviderSecret: vi.fn(async () => ({ set: true })),
    testAiProvider: vi.fn(async (): Promise<AiProviderTestReport> => ({
      providerId: 'ollama-local',
      providerName: 'Ollama (this machine)',
      address: 'http://localhost:11434/v1',
      ok: true,
      ran: true,
      status: 200,
      elapsedMs: 12,
      summary: 'The endpoint reported 2 model(s) from "/models".',
      shadowed: [],
    })),
    /**
     * The model policy. The declared return type names the full transport union
     * rather than one call's literal, so a test can answer with another transport
     * without a cast.
     */
    setAiModelPolicy: vi.fn(
      async (): Promise<{
        transport: 'auto' | 'vscode-lm' | 'openai-compatible';
        requestTimeoutMs: number;
      }> => ({
        transport: 'auto',
        requestTimeoutMs: 30_000,
      }),
    ),
    setAiModelBinding: vi.fn(async () => ({ feature: 'aiPreReview', providerId: '', modelId: '' })),
    setAiDefaultModel: vi.fn(async () => ({ providerId: '', modelId: '' })),
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
    copyToClipboard: vi.fn(),
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

    showConfirm: vi.fn(async () => true),
  };
  return { stateMock: mock, snapshot: holder };
});

vi.mock('../../composables/useAppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useAppState')>();
  const { reactive: makeReactive } = await import('vue');
  return {
    ...actual,
    useAppState: () => makeReactive(stateMock),
  };
});

import Settings from '../Settings.vue';
import { createTestRouter, createTestI18n, settingsSurfaceFixture } from '../../__tests__/helpers/test-utils';
import type {
  AiProviderSettingsSnapshot,
  AiProviderTestReport,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

// The host's reading of the settings page's own surface (§3.2): the manifest's
// defaults with the whole source map. It is built here rather than in the
// `vi.hoisted` body above because that body runs before this import exists.
stateMock.settingsSurface.value = settingsSurfaceFixture();

const ENTRY = {
  id: 'ollama-local',
  name: 'Ollama (this machine)',
  baseUrl: 'http://localhost:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  auth: 'bearer' as const,
  headers: [{ name: 'api-version', set: true, shadowed: false, queryCarried: true }],
  keySet: true,
  address: 'http://localhost:11434/v1',
  insecure: true,
};

function snapshotOf(overrides: Partial<SnapshotShape> = {}): AiProviderSettingsSnapshot {
  return {
    providers: [],
    rejected: [],
    transport: 'auto',
    requestTimeoutMs: 30_000,
    defaultModel: { providerId: '', modelId: '' },
    bindings: [],
    features: ['aiPreReview'],
    selection: 'none',
    capability: { available: true },
    ...overrides,
  } as AiProviderSettingsSnapshot;
}

function setSnapshot(value: AiProviderSettingsSnapshot): void {
  snapshot.current = value;
  stateMock.aiProviderSettings.value = value;
}

function mountView(): VueWrapper {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

/** A button by its visible label, wherever it is. */
function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(found, `button "${label}"`).toBeTruthy();
  return found!;
}

/** The button inside the endpoint row with this id. */
function rowButton(wrapper: VueWrapper, rowIndex: number, label: string) {
  const row = wrapper.findAll('.saved-item')[rowIndex];
  expect(row, `endpoint row ${rowIndex}`).toBeTruthy();
  const found = row!.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(found, `row button "${label}"`).toBeTruthy();
  return found!;
}

async function openEditorForRow(wrapper: VueWrapper, rowIndex = 0): Promise<void> {
  await rowButton(wrapper, rowIndex, 'Edit').trigger('click');
  await flushPromises();
}

function fieldValue(wrapper: VueWrapper, selector: string): string {
  const field = wrapper.find(selector);
  const property = (field.element as unknown as { value?: string }).value;
  if (property !== undefined) {
    return String(property);
  }
  return field.attributes('value') ?? '';
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string): Promise<void> {
  const field = wrapper.find(selector);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
}

/** Types into one `vscode-textfield` of a repeatable row, by its position in the row. */
async function typeIntoRowField(
  wrapper: VueWrapper,
  rowIndex: number,
  fieldIndex: number,
  value: string,
): Promise<void> {
  const row = wrapper.findAll('.repeatable-row')[rowIndex];
  expect(row, `repeatable row ${rowIndex}`).toBeTruthy();
  const field = row!.findAll('vscode-textfield')[fieldIndex];
  expect(field, `field ${fieldIndex} of row ${rowIndex}`).toBeTruthy();
  (field!.element as unknown as { value: string }).value = value;
  await field!.trigger('input');
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.current = undefined;
  stateMock.aiProviderSettings.value = undefined;
  stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({ models: [], configured: '' }));
  stateMock.saveAiProvider.mockImplementation(async (provider: { id: string }) => ({ id: provider.id }));
  stateMock.removeAiProvider.mockImplementation(async () => ({ cancelled: false }));
  stateMock.setAiProviderSecret.mockImplementation(async () => ({ set: true }));
  stateMock.testAiProvider.mockImplementation(async () => ({
    providerId: 'ollama-local',
    providerName: 'Ollama (this machine)',
    address: 'http://localhost:11434/v1',
    ok: true,
    ran: true,
    status: 200,
    elapsedMs: 12,
    summary: 'The endpoint reported 2 model(s) from "/models".',
    shadowed: [],
  }));
});

describe('Settings AI endpoint list', () => {
  it('renders one row per endpoint with the facts a user has to act on', async () => {
    setSnapshot(
      snapshotOf({
        providers: [
          ENTRY,
          {
            ...ENTRY,
            id: 'azure',
            name: 'Azure OpenAI',
            address: 'https://models.example.com/openai/v1',
            insecure: false,
            keySet: false,
            headers: [
              { name: 'api-version', set: false, shadowed: false, queryCarried: true },
              { name: 'authorization', set: true, shadowed: true, queryCarried: false },
            ],
            models: [],
          },
          {
            ...ENTRY,
            id: 'broken-url',
            name: 'Broken URL',
            address: 'file:///tmp/v1',
            addressError: 'its scheme is "file:", and only http: and https: can be a model endpoint',
          },
        ],
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    const rows = wrapper.findAll('.saved-item');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('Ollama (this machine)');
    expect(rows[0]!.text()).toContain('http://localhost:11434/v1');
    expect(rows[0]!.text()).toContain('API key stored');
    expect(rows[0]!.text()).toContain('1 of 1 header value(s) stored');
    expect(rows[0]!.text()).toContain('Plain http://');
    // A declared header the auth style owns is named, with the reason.
    expect(rows[1]!.text()).toContain('No API key stored');
    expect(rows[1]!.text()).toContain('Not sent: the authentication style already owns authorization.');
    expect(rows[1]!.text()).toContain('No model is declared for this endpoint.');
    expect(rows[2]!.text()).toContain('This address cannot be used: its scheme is "file:"');
    wrapper.unmount();
  });

  it('names every entry the settings reader refused, with the reader reason', async () => {
    setSnapshot(
      snapshotOf({
        rejected: [
          { index: 0, id: 'broken entry', reason: 'its "id" is not a legal provider id' },
          { index: 2, reason: 'it has no "id"' },
        ],
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('Entries that could not be read');
    expect(wrapper.text()).toContain('Entry 1 (id "broken entry"): its "id" is not a legal provider id');
    expect(wrapper.text()).toContain('Entry 3: it has no "id"');
    // The list of readable endpoints is separate from it.
    expect(wrapper.text()).toContain('No AI endpoint is configured.');
    wrapper.unmount();
  });

  it('renders the test-connection report with the address, the status and no credential', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));
    stateMock.testAiProvider.mockImplementation(async () => ({
      providerId: 'ollama-local',
      providerName: 'Ollama (this machine)',
      address: 'http://localhost:11434/v1',
      ok: true,
      ran: true,
      status: 200,
      elapsedMs: 12,
      summary: 'The endpoint reported 2 model(s) from "/models".',
      shadowed: ['authorization'],
    }));

    const wrapper = mountView();
    await flushPromises();

    await rowButton(wrapper, 0, 'Test connection').trigger('click');
    await flushPromises();

    expect(stateMock.testAiProvider).toHaveBeenCalledWith('ollama-local');
    const report = wrapper.find('.test-report');
    expect(report.exists()).toBe(true);
    expect(report.text()).toContain('The endpoint "Ollama (this machine)" answered.');
    expect(report.text()).toContain('http://localhost:11434/v1');
    expect(report.text()).toContain('200');
    expect(report.text()).toContain('12 ms');
    expect(report.text()).toContain('reported 2 model(s)');
    expect(report.text()).toContain('Not sent: the authentication style already owns authorization.');
    // Nothing the report renders can be a credential.
    expect(report.text()).not.toContain('sk-');
    wrapper.unmount();
  });

  it('says "not tested" rather than "failed" when nothing was sent', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));
    stateMock.testAiProvider.mockImplementation(async () => ({
      providerId: 'ollama-local',
      providerName: 'Ollama (this machine)',
      address: 'file:///tmp/v1',
      ok: false,
      ran: false,
      reason: 'The AI endpoint "Ollama (this machine)" cannot be used: it is not an absolute URL',
      shadowed: [],
    }));

    const wrapper = mountView();
    await flushPromises();

    await rowButton(wrapper, 0, 'Test connection').trigger('click');
    await flushPromises();

    const report = wrapper.find('.test-report');
    expect(report.text()).toContain('was not tested: nothing was sent');
    expect(report.text()).toContain('cannot be used');
    // The address is still named even when nothing went there.
    expect(report.text()).toContain('file:///tmp/v1');
    wrapper.unmount();
  });

  it('removes an endpoint, and reports a declined host confirmation as nothing done', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));
    stateMock.removeAiProvider.mockImplementation(async () => ({ cancelled: true }));

    const wrapper = mountView();
    await flushPromises();

    await rowButton(wrapper, 0, 'Remove').trigger('click');
    await flushPromises();

    // The webview never asks its own question: the host owns that confirmation.
    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    expect(stateMock.removeAiProvider).toHaveBeenCalledWith('ollama-local');
    expect(wrapper.text()).toContain('Nothing was removed.');
    wrapper.unmount();
  });
});

describe('Settings AI endpoint editor', () => {
  it('saves a new endpoint and stores the typed key through the host', async () => {
    setSnapshot(snapshotOf());

    const wrapper = mountView();
    await flushPromises();

    await button(wrapper, 'Add Endpoint').trigger('click');
    await flushPromises();
    expect(wrapper.find('.editor-title').text()).toBe('Add AI Endpoint');

    await typeInto(wrapper, '#ai-provider-id', 'ollama-local');
    await typeInto(wrapper, '#ai-provider-name', 'Ollama (this machine)');
    await typeInto(wrapper, '#ai-provider-base-url', 'http://localhost:11434/v1');
    await typeInto(wrapper, '#ai-provider-key', 'sk-typed-once');

    await button(wrapper, 'Save endpoint').trigger('click');
    await flushPromises();

    expect(stateMock.saveAiProvider).toHaveBeenCalledWith({
      id: 'ollama-local',
      name: 'Ollama (this machine)',
      baseUrl: 'http://localhost:11434/v1',
      models: [],
      auth: 'bearer',
      headers: [],
    });
    // The key goes to secret storage after the endpoint exists, not into settings.
    expect(stateMock.setAiProviderSecret).toHaveBeenCalledWith('ollama-local', undefined, 'sk-typed-once');
    expect(JSON.stringify(stateMock.saveAiProvider.mock.calls)).not.toContain('sk-typed-once');
    // The editor closes back to the list, which says what happened.
    expect(wrapper.find('.editor-title').exists()).toBe(false);
    expect(wrapper.text()).toContain('The endpoint "ollama-local" was saved.');
    wrapper.unmount();
  });

  it('never reads a stored secret back: the fields start empty and say what is set', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));

    const wrapper = mountView();
    await flushPromises();
    await openEditorForRow(wrapper);

    expect(wrapper.find('.editor-title').text()).toBe('Edit AI Endpoint');
    expect(wrapper.find('.editor-identity-name').text()).toBe('Ollama (this machine)');
    expect(fieldValue(wrapper, '#ai-provider-id')).toBe('ollama-local');
    // The id is part of the key a stored secret lives under, so it is fixed.
    expect(wrapper.find('#ai-provider-id').attributes('disabled')).toBeDefined();

    // Both secret fields are empty, and the words beside them are the state.
    expect(fieldValue(wrapper, '#ai-provider-key')).toBe('');
    expect(wrapper.text()).toContain('A key is stored. Leave the field empty to keep it.');
    // ENTRY declares one model (row 0) and one header (row 1).
    const headerValue = wrapper.findAll('.repeatable-row')[1]!.findAll('vscode-textfield')[1]!;
    expect(fieldValue(wrapper, '.repeatable-row vscode-textfield[type="password"]')).toBe('');
    expect(headerValue.attributes('placeholder')).toBe('A value is stored. Leave this empty to keep it.');
    // `api-version`'s value travels as a query parameter, and the row says so.
    expect(wrapper.text()).toContain('Sent as a query parameter rather than as a header.');

    await button(wrapper, 'Clear stored key').trigger('click');
    await flushPromises();
    expect(stateMock.setAiProviderSecret).toHaveBeenCalledWith('ollama-local', undefined, '');
    wrapper.unmount();
  });

  it('does not offer to clear a secret that is not set, and does not need one when auth is none', async () => {
    setSnapshot(
      snapshotOf({
        providers: [
          { ...ENTRY, keySet: false, headers: [], auth: 'none', models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }] },
        ],
      }),
    );

    const wrapper = mountView();
    await flushPromises();
    await openEditorForRow(wrapper);

    expect(wrapper.text()).toContain('This endpoint sends no credential, so there is no key to store.');
    expect(wrapper.findAll('vscode-button').some((entry) => entry.text().trim() === 'Clear stored key')).toBe(false);
    wrapper.unmount();
  });

  it('marks a duplicate model id or header name before the host has to refuse it', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));

    const wrapper = mountView();
    await flushPromises();
    await openEditorForRow(wrapper);

    // ENTRY declares one model and one header, so the new model is row 1.
    await button(wrapper, 'Add model').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.repeatable-row')).toHaveLength(3);
    await typeIntoRowField(wrapper, 1, 0, 'qwen3:8b');
    expect(wrapper.findAll('.repeatable-row')[1]!.classes()).toContain('invalid');
    expect(wrapper.text()).toContain('This model id is already declared above.');

    // ... and the new header is the last row, after the two models.
    await button(wrapper, 'Add header').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.repeatable-row')).toHaveLength(4);
    await typeIntoRowField(wrapper, 3, 0, 'api-version');
    // The duplicate is marked, and the auth-owned conflict is a different message.
    expect(wrapper.text()).toContain('This header name is already declared above.');

    await typeIntoRowField(wrapper, 3, 0, 'Authorization');
    expect(wrapper.text()).toContain('The authentication style above sends this header itself');
    wrapper.unmount();
  });

  it('keeps the editor open and says why when the host refuses the save', async () => {
    setSnapshot(snapshotOf());
    stateMock.saveAiProvider.mockImplementation(async () => ({
      id: 'bad id',
      error: 'The endpoint id may use letters, digits, "_" and "-" only.',
    }));

    const wrapper = mountView();
    await flushPromises();
    await button(wrapper, 'Add Endpoint').trigger('click');
    await flushPromises();
    await typeInto(wrapper, '#ai-provider-id', 'bad id');
    await button(wrapper, 'Save endpoint').trigger('click');
    await flushPromises();

    // The typed draft is still on screen, with the reason beside it.
    expect(wrapper.find('.editor-title').exists()).toBe(true);
    expect(fieldValue(wrapper, '#ai-provider-id')).toBe('bad id');
    expect(wrapper.text()).toContain('The endpoint id may use letters, digits, "_" and "-" only.');
    wrapper.unmount();
  });

  it('prefills the model declaration from the list the endpoint reported', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));
    stateMock.testAiProvider.mockImplementation(async () => ({
      providerId: 'ollama-local',
      providerName: 'Ollama (this machine)',
      address: 'http://localhost:11434/v1',
      ok: true,
      ran: true,
      status: 200,
      elapsedMs: 8,
      summary: 'The endpoint reported 2 model(s) from "/models".',
      // One of them is already declared: the control offers only the missing one.
      models: ['qwen3:8b', 'llama3:8b'],
      shadowed: [],
    }));

    const wrapper = mountView();
    await flushPromises();
    await openEditorForRow(wrapper);

    // Nothing is offered before a report exists: the declaration is the user's.
    expect(wrapper.findAll('vscode-button').some((entry) => entry.text().includes('Add the reported model(s)'))).toBe(
      false,
    );

    await button(wrapper, 'Test connection').trigger('click');
    await flushPromises();

    const addModels = wrapper
      .findAll('vscode-button')
      .find((entry) => entry.text().includes('Add the reported model(s)'));
    expect(addModels, 'the prefill control').toBeTruthy();
    expect(addModels!.text()).toContain('(1)');
    await addModels!.trigger('click');
    await flushPromises();

    // The rows are ordinary declaration rows: the id is filled, the name is left for
    // the user (the host falls back to the id when it is saved empty).
    expect(wrapper.findAll('.repeatable-row')).toHaveLength(3);
    expect(fieldValue(wrapper, '#ai-provider-id')).toBe('ollama-local');
    const rows = wrapper.findAll('.repeatable-row');
    expect(rows[1]!.findAll('vscode-textfield')[0]!.attributes('value')).toBe('llama3:8b');
    // Pressing it again cannot duplicate the declaration.
    expect(wrapper.findAll('vscode-button').some((entry) => entry.text().includes('Add the reported model(s)'))).toBe(
      false,
    );
    wrapper.unmount();
  });

  it('keeps the typed value when the endpoint was saved but its secret was not', async () => {
    setSnapshot(snapshotOf());
    stateMock.setAiProviderSecret.mockImplementation(async () => ({
      set: false,
      error: 'The endpoint "ollama-local" does not declare a header named "x".',
    }));

    const wrapper = mountView();
    await flushPromises();
    await button(wrapper, 'Add Endpoint').trigger('click');
    await flushPromises();
    await typeInto(wrapper, '#ai-provider-id', 'ollama-local');
    await typeInto(wrapper, '#ai-provider-name', 'Ollama');
    await typeInto(wrapper, '#ai-provider-base-url', 'http://localhost:11434/v1');
    await typeInto(wrapper, '#ai-provider-key', 'sk-kept');
    await button(wrapper, 'Save endpoint').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('The endpoint was saved, but a stored value could not be written');
    // Closing on this path would discard a value that was never read back.
    expect(wrapper.find('.editor-title').exists()).toBe(true);
    expect(fieldValue(wrapper, '#ai-provider-key')).toBe('sk-kept');
    wrapper.unmount();
  });
});

describe('Settings AI endpoint capability block', () => {
  it('stays out of the way while a model is usable', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.find('.capability-block').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('No AI model is available');
    wrapper.unmount();
  });

  it('states the host reason, offers both routes, and offers to configure nothing else', async () => {
    setSnapshot(
      snapshotOf({
        capability: {
          available: false,
          code: 'no-model',
          reason:
            'No AI model is available: this editor provides no chat model (the language model API lists none), and no AI endpoint is configured.',
        },
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    const block = wrapper.find('.capability-block');
    expect(block.exists()).toBe(true);
    expect(block.text()).toContain('No AI model is available');
    // The host's own sentence, not a paraphrase of it.
    expect(block.text()).toContain('this editor provides no chat model');
    // Both routes are offered, whatever the reason code is.
    expect(block.text()).toContain('Install an extension that contributes a chat model');
    expect(block.text()).toContain('Configure an OpenAI-compatible endpoint');

    // "Nothing is turned on by configuring": the two routes open the editor and
    // look again. Neither writes a setting, so neither can enable anything.
    expect(block.findAll('.capability-route.first')).toHaveLength(1);
    await button(wrapper, 'Re-check the offered models').trigger('click');
    await flushPromises();
    expect(stateMock.loadAiPreReviewChatModels).toHaveBeenCalled();
    expect(stateMock.setAiModelPolicy).not.toHaveBeenCalled();

    await button(wrapper, 'Configure an endpoint').trigger('click');
    await flushPromises();
    expect(wrapper.find('.editor-title').text()).toBe('Add AI Endpoint');
    expect(stateMock.setAiModelPolicy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('branches on the reason code for the route it puts first and the extra sentence', async () => {
    setSnapshot(
      snapshotOf({
        capability: {
          available: false,
          code: 'ai-off',
          reason: '"forgejoToolkit.aiEnabled" is off, so no AI feature runs and nothing was sent.',
        },
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    // The endpoint route is emphasised, and the global switch is named.
    const routes = wrapper.findAll('.capability-route');
    expect(routes).toHaveLength(2);
    expect(routes[1]!.classes()).toContain('first');
    expect(routes[0]!.classes()).not.toContain('first');
    expect(wrapper.text()).toContain('AI is off, so no AI feature runs');
    expect(wrapper.text()).not.toContain('Nothing says which endpoint serves this feature');
    wrapper.unmount();
  });

  it('points at the binding when nothing says which endpoint to use', async () => {
    setSnapshot(
      snapshotOf({
        capability: {
          available: false,
          code: 'bind',
          reason: 'No AI model is available: no endpoint is bound to this feature.',
        },
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('Nothing says which endpoint serves this feature');
    expect(wrapper.text()).not.toContain('AI is off, so no AI feature runs');
    wrapper.unmount();
  });
});

describe('Settings AI model overrides', () => {
  it('saves and clears one feature override through the host', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));

    const wrapper = mountView();
    await flushPromises();

    const select = wrapper.find('#ai-binding-aiPreReview');
    expect(select.exists()).toBe(true);
    const optionLabels = select.findAll('vscode-option').map((option) => option.text());
    expect(optionLabels).toEqual(['Do not override — follow the default above', 'Ollama (this machine)']);

    (select.element as unknown as { value: string }).value = 'ollama-local';
    await select.trigger('change');
    const modelField = wrapper.find('.binding-row vscode-textfield');
    (modelField.element as unknown as { value: string }).value = 'qwen3:8b';
    await modelField.trigger('input');
    await button(wrapper, 'Save override').trigger('click');
    await flushPromises();

    expect(stateMock.setAiModelBinding).toHaveBeenCalledWith({
      feature: 'aiPreReview',
      providerId: 'ollama-local',
      modelId: 'qwen3:8b',
    });
    expect(wrapper.text()).toContain('The binding was saved.');

    await button(wrapper, 'Remove override').trigger('click');
    await flushPromises();
    expect(stateMock.setAiModelBinding).toHaveBeenLastCalledWith({
      feature: 'aiPreReview',
      providerId: '',
      modelId: '',
    });
    expect(wrapper.text()).toContain('The binding was removed.');
    wrapper.unmount();
  });

  it('marks an override that names an endpoint which is not configured', async () => {
    setSnapshot(
      snapshotOf({
        providers: [ENTRY],
        bindings: [{ feature: 'aiPreReview', providerId: 'gone-gateway', modelId: 'qwen3:8b' }],
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('This override names the endpoint "gone-gateway", which is not configured.');
    wrapper.unmount();
  });
});

describe('Settings AI default endpoint and model', () => {
  it('leads with the default row and states that nothing is configured yet', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));

    const wrapper = mountView();
    await flushPromises();

    // The default is the primary path: its row is above the override section and
    // says what "no default" means, rather than leaving an empty control.
    const providerSelect = wrapper.find('#ai-default-provider');
    expect(providerSelect.attributes('label')).toBe('Default endpoint');
    expect(wrapper.find('#ai-default-model').attributes('label')).toBe('Default model id');
    expect(wrapper.text()).toContain('No default endpoint is configured yet');
    expect(wrapper.find('#ai-default-model').exists()).toBe(true);
    const providerOptions = providerSelect.findAll('vscode-option').map((option) => option.text());
    expect(providerOptions).toEqual(['Do not override — follow the default above', 'Ollama (this machine)']);
    wrapper.unmount();
  });

  it('saves both halves as one pair, and never writes a half', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));

    const wrapper = mountView();
    await flushPromises();

    const select = wrapper.find('#ai-default-provider');
    (select.element as unknown as { value: string }).value = 'ollama-local';
    await select.trigger('change');

    // The model is still empty: saving now is refused on the page, because the host
    // would refuse it too and the sentence says which half is missing.
    await button(wrapper, 'Save default').trigger('click');
    await flushPromises();
    expect(stateMock.setAiDefaultModel).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('The default needs both halves');

    const modelField = wrapper.find('#ai-default-model');
    (modelField.element as unknown as { value: string }).value = 'qwen3:8b';
    await modelField.trigger('input');
    await button(wrapper, 'Save default').trigger('click');
    await flushPromises();

    expect(stateMock.setAiDefaultModel).toHaveBeenCalledWith({ providerId: 'ollama-local', modelId: 'qwen3:8b' });
    wrapper.unmount();
  });

  it('clears the default through the host', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY], defaultModel: { providerId: 'ollama-local', modelId: 'qwen3:8b' } }));

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('Default: ollama-local / qwen3:8b');

    await button(wrapper, 'Remove default').trigger('click');
    await flushPromises();

    expect(stateMock.setAiDefaultModel).toHaveBeenCalledWith({ providerId: '', modelId: '' });
    wrapper.unmount();
  });

  it('marks a default that names an endpoint which is not configured', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY], defaultModel: { providerId: 'gone-gateway', modelId: 'qwen3:8b' } }));

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('The default names the endpoint "gone-gateway", which is not configured.');
    // The select can still show it: a value the host reports is never dropped from
    // the control, or the user could not see what is stored.
    expect(wrapper.find('#ai-default-provider').attributes('value')).toBe('gone-gateway');
    wrapper.unmount();
  });

  it('puts the controls back on the stored default when the host refuses the write', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY], defaultModel: { providerId: 'ollama-local', modelId: 'qwen3:8b' } }));
    stateMock.setAiDefaultModel.mockImplementation(async () => ({
      providerId: 'ollama-local',
      modelId: 'qwen3:8b',
      error: 'No AI endpoint with the id "other" is configured, so it cannot be the default.',
    }));

    const wrapper = mountView();
    await flushPromises();

    const modelField = wrapper.find('#ai-default-model');
    (modelField.element as unknown as { value: string }).value = 'big-model';
    await modelField.trigger('input');
    await button(wrapper, 'Save default').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('cannot be the default');
    expect((wrapper.find('#ai-default-model').element as unknown as { value: string }).value).toBe('qwen3:8b');
    wrapper.unmount();
  });
});

describe('the AI area follows the transport choice', () => {
  it('shows both routes and states the precedence under auto', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY], transport: 'auto' }));

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.find('#ai-transport').attributes('value')).toBe('auto');
    expect(wrapper.text()).toContain(
      "auto prefers this editor's model when one is available, and uses the configured endpoint when it is not.",
    );
    // Both halves are on the page, and the endpoint surface is not hidden.
    expect(wrapper.find('#ai-pre-review-model').exists()).toBe(true);
    expect(wrapper.find('#ai-default-provider').exists()).toBe(true);
    expect(wrapper.findAll('.saved-item')).toHaveLength(1);
    expect(wrapper.text()).not.toContain('is hidden while the transport is vscode-lm');
    wrapper.unmount();
  });

  it('hides the endpoint surface under vscode-lm and says how to get it back', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY], transport: 'vscode-lm' }));

    const wrapper = mountView();
    await flushPromises();

    // The editor's own row is the one that stays.
    expect(wrapper.find('#ai-pre-review-model').exists()).toBe(true);
    // The endpoint surface — the list, its editor controls and the default row — is
    // gone, with the sentence that says why and which control brings it back.
    expect(wrapper.find('.saved-item').exists()).toBe(false);
    expect(wrapper.find('#ai-default-provider').exists()).toBe(false);
    expect(wrapper.text()).toContain('is hidden while the transport is vscode-lm');
    // The timeout, which the transport choice does not make unreachable, stays.
    expect(wrapper.find('#ai-request-timeout').exists()).toBe(true);
    // The choice that hid them is still on the page, so nothing is a dead end.
    expect(wrapper.find('#ai-transport').exists()).toBe(true);
    wrapper.unmount();
  });

  it('hides the editor model row under openai-compatible and never offers it as a route', async () => {
    setSnapshot(
      snapshotOf({
        providers: [ENTRY],
        transport: 'openai-compatible',
        capability: { available: false, code: 'no-model', reason: 'this editor provides no chat model' },
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.find('#ai-pre-review-model').exists()).toBe(false);
    expect(wrapper.text()).toContain('openai-compatible uses the configured endpoint only.');
    // The endpoint surface is the one that stays, and the §9.3 block is gone with
    // the route it was offering.
    expect(wrapper.find('#ai-default-provider').exists()).toBe(true);
    expect(wrapper.find('.saved-item').exists()).toBe(true);
    expect(wrapper.find('.capability-block').exists()).toBe(false);
    wrapper.unmount();
  });

  it('writes the transport through the same policy message the timeout uses', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY], transport: 'auto' }));
    stateMock.setAiModelPolicy.mockImplementation(async () => ({
      transport: 'openai-compatible' as const,
      requestTimeoutMs: 30_000,
    }));

    const wrapper = mountView();
    await flushPromises();

    const select = wrapper.find('#ai-transport');
    (select.element as unknown as { value: string }).value = 'openai-compatible';
    await select.trigger('change');
    await flushPromises();

    expect(stateMock.setAiModelPolicy).toHaveBeenCalledWith({
      transport: 'openai-compatible',
      requestTimeoutMs: 30_000,
    });
    wrapper.unmount();
  });
});
