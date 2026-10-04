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
  enabled: boolean;
  transport: 'auto' | 'vscode-lm' | 'openai-compatible';
  localOnly: boolean;
  requestTimeoutMs: number;
  bindings: unknown[];
  features: string[];
  capability: unknown;
}

const { stateMock, snapshot } = vi.hoisted(() => {
  const holder: { current: unknown } = { current: undefined };
  const mock = {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
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
      address: 'http://127.0.0.1:11434/v1',
      ok: true,
      ran: true,
      status: 200,
      elapsedMs: 12,
      summary: 'The endpoint reported 2 model(s) from "/models".',
      shadowed: [],
    })),
    setAiModelPolicy: vi.fn(async () => ({
      enabled: false,
      transport: 'auto' as const,
      localOnly: false,
      requestTimeoutMs: 30_000,
    })),
    setAiModelBinding: vi.fn(async () => ({ feature: 'aiPreReview', providerId: '', modelId: '' })),
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
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import type {
  AiProviderSettingsSnapshot,
  AiProviderTestReport,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

const ENTRY = {
  id: 'ollama-local',
  name: 'Ollama (this machine)',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  auth: 'bearer' as const,
  headers: [{ name: 'api-version', set: true, shadowed: false, queryCarried: true }],
  localOnly: false,
  keySet: true,
  address: 'http://127.0.0.1:11434/v1',
  insecure: true,
  localOnlyBlocked: false,
};

function snapshotOf(overrides: Partial<SnapshotShape> = {}): AiProviderSettingsSnapshot {
  return {
    providers: [],
    rejected: [],
    enabled: false,
    transport: 'auto',
    localOnly: false,
    requestTimeoutMs: 30_000,
    bindings: [],
    features: ['aiPreReview'],
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
    address: 'http://127.0.0.1:11434/v1',
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
            id: 'public',
            name: 'Public gateway',
            address: 'https://gateway.example.com/v1',
            insecure: false,
            localOnlyBlocked: true,
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
    expect(rows).toHaveLength(4);
    expect(rows[0]!.text()).toContain('Ollama (this machine)');
    expect(rows[0]!.text()).toContain('http://127.0.0.1:11434/v1');
    expect(rows[0]!.text()).toContain('API key stored');
    expect(rows[0]!.text()).toContain('1 of 1 header value(s) stored');
    expect(rows[0]!.text()).toContain('Plain http://');
    // A declared header the auth style owns is named, with the reason.
    expect(rows[1]!.text()).toContain('No API key stored');
    expect(rows[1]!.text()).toContain('Not sent: the authentication style already owns authorization.');
    expect(rows[1]!.text()).toContain('No model is declared for this endpoint.');
    expect(rows[2]!.text()).toContain('Refused by the local-only policy');
    expect(rows[3]!.text()).toContain('This address cannot be used: its scheme is "file:"');
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
      address: 'http://127.0.0.1:11434/v1',
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
    expect(report.text()).toContain('http://127.0.0.1:11434/v1');
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
    await typeInto(wrapper, '#ai-provider-base-url', 'http://127.0.0.1:11434/v1');
    await typeInto(wrapper, '#ai-provider-key', 'sk-typed-once');

    await button(wrapper, 'Save endpoint').trigger('click');
    await flushPromises();

    expect(stateMock.saveAiProvider).toHaveBeenCalledWith({
      id: 'ollama-local',
      name: 'Ollama (this machine)',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [],
      auth: 'bearer',
      headers: [],
      localOnly: false,
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
    expect(wrapper.find('.editor-subject-name').text()).toBe('Ollama (this machine)');
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
      address: 'http://127.0.0.1:11434/v1',
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
    await typeInto(wrapper, '#ai-provider-base-url', 'http://127.0.0.1:11434/v1');
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

    // "Nothing is enabled by configuring": the two routes open the editor and look
    // again. Neither writes a setting, so neither can open egress.
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
          code: 'disabled',
          reason: '"forgejoToolkit.aiProvidersEnabled" is off, so the configured AI endpoint is not used.',
        },
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    // The endpoint route is emphasised, and the switch is named.
    const routes = wrapper.findAll('.capability-route');
    expect(routes).toHaveLength(2);
    expect(routes[1]!.classes()).toContain('first');
    expect(routes[0]!.classes()).not.toContain('first');
    expect(wrapper.text()).toContain('Requests to configured endpoints are switched off in this window');
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
    expect(wrapper.text()).not.toContain('Requests to configured endpoints are switched off');
    wrapper.unmount();
  });
});

describe('Settings AI model bindings', () => {
  it('saves and clears one feature binding through the host', async () => {
    setSnapshot(snapshotOf({ providers: [ENTRY] }));

    const wrapper = mountView();
    await flushPromises();

    const select = wrapper.find('#ai-binding-aiPreReview');
    expect(select.exists()).toBe(true);
    const optionLabels = select.findAll('vscode-option').map((option) => option.text());
    expect(optionLabels).toEqual(['No binding — use the transport choice above', 'Ollama (this machine)']);

    (select.element as unknown as { value: string }).value = 'ollama-local';
    await select.trigger('change');
    const modelField = wrapper.find('.binding-row vscode-textfield');
    (modelField.element as unknown as { value: string }).value = 'qwen3:8b';
    await modelField.trigger('input');
    await button(wrapper, 'Save binding').trigger('click');
    await flushPromises();

    expect(stateMock.setAiModelBinding).toHaveBeenCalledWith({
      feature: 'aiPreReview',
      providerId: 'ollama-local',
      modelId: 'qwen3:8b',
    });
    expect(wrapper.text()).toContain('The binding was saved.');

    await button(wrapper, 'Remove binding').trigger('click');
    await flushPromises();
    expect(stateMock.setAiModelBinding).toHaveBeenLastCalledWith({
      feature: 'aiPreReview',
      providerId: '',
      modelId: '',
    });
    expect(wrapper.text()).toContain('The binding was removed.');
    wrapper.unmount();
  });

  it('marks a binding that names an endpoint which is not configured', async () => {
    setSnapshot(
      snapshotOf({
        providers: [ENTRY],
        bindings: [{ feature: 'aiPreReview', providerId: 'gone-gateway', modelId: 'qwen3:8b' }],
      }),
    );

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('This binding names the endpoint "gone-gateway", which is not configured.');
    wrapper.unmount();
  });
});
