import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type {
  AiProviderDraftProbe,
  AiProviderSettingsSnapshot,
  AiProviderTestReport,
  SettingsSurfaceSnapshot,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The automatic model probe (`docs/design/settings-page.md` §4).
 *
 * This is the first path in this extension that sends a request **without a
 * click**, and the record's §8.1 states the cost rather than hiding it: an address
 * typed wrong, followed by a credential, sends one `GET /models` to that address.
 * What makes that acceptable is the shape of the trigger, and that shape is what
 * this file pins, one rule per test:
 *
 * 1. **800 ms of idle**, on a complete address plus a credential the user just
 *    typed — not on a load, a render, a save or a stored key.
 * 2. **Only an edit may arm it**: opening an existing endpoint, or switching to
 *    another one, fills the same fields and is not an input event — `auth: none`
 *    included, where no credential is needed but an edit still is.
 * 3. **Cancelled by further typing**, and re-armed for the new value.
 * 4. **One shot per input combination**: the same address, auth style and
 *    credential do not probe twice; a different one does.
 * 5. **Nothing is armed for an address the shared URL rule refuses**: the
 *    automatic path stays disarmed and the row says why.
 * 6. **A prefill, never a write**: the reported models are added to the draft as
 *    ordinary rows, and nothing is saved to settings or to secret storage.
 * 7. **A failure is a report**, not a dialog and not a blocked form: the host's
 *    own sentence is rendered, the line above the model rows says the probe got no
 *    answer and where the reason is, and the card names its own source.
 * 8. **A success is not consent** (§8 question 2): the line under the model rows
 *    says so in the same breath as the rows it just filled in, because "the probe
 *    answered" is the one outcome a reader can mistake for permission. A failed or
 *    refused probe says nothing about consent — it sent nothing to be mistaken for
 *    it.
 */

const { stateMock } = vi.hoisted(() => {
  const mock = {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
    settingsRefreshTick: { value: 0 },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
    settingsSurface: { value: undefined as unknown },
    loadSettingsSurface: vi.fn(async () => mock.settingsSurface.value),
    setSettingsSurfaceValue: vi.fn(async () => ({ snapshot: mock.settingsSurface.value })),
    openNativeSettings: vi.fn(),
    aiProviderSettings: { value: undefined as unknown },
    loadAiProviderSettings: vi.fn(async () => mock.aiProviderSettings.value),
    saveAiProvider: vi.fn(async (provider: { id: string }) => ({ id: provider.id })),
    removeAiProvider: vi.fn(async () => ({ cancelled: false })),
    setAiProviderSecret: vi.fn(async () => ({ set: true })),
    testAiProvider: vi.fn(async (_id: string) => reportOf()),
    testAiProviderDraft: vi.fn(async (_draft: AiProviderDraftProbe) => reportOf()),
    setAiModelPolicy: vi.fn(async () => ({
      transport: 'auto' as const,
      requestTimeoutMs: 30_000,
    })),
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
    showConfirm: vi.fn(async () => true),
  };
  return { stateMock: mock };
});

vi.mock('../../composables/useAppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useAppState')>();
  const { reactive: makeReactive } = await import('vue');
  return { ...actual, useAppState: () => makeReactive(stateMock) };
});

import Settings from '../Settings.vue';
import { createTestRouter, createTestI18n, settingsSurfaceFixture } from '../../__tests__/helpers/test-utils';

const BASE_URL = 'https://api.example.com/v1';
const API_KEY = 'sk-typed-in-the-editor';

/** One complete reading of the page's own surface, the source map included. */
function surfaceOf(overrides: Partial<SettingsSurfaceSnapshot> = {}): SettingsSurfaceSnapshot {
  return settingsSurfaceFixture(overrides);
}

function providerSnapshotOf(overrides: Partial<AiProviderSettingsSnapshot> = {}): AiProviderSettingsSnapshot {
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

function reportOf(overrides: Partial<AiProviderTestReport> = {}): AiProviderTestReport {
  return {
    providerId: 'api-example-com',
    providerName: 'api.example.com',
    address: BASE_URL,
    ok: true,
    ran: true,
    status: 200,
    elapsedMs: 12,
    summary: 'The endpoint reported 1 model(s) from "/models".',
    models: ['reported-model'],
    shadowed: [],
    ...overrides,
  };
}

function mountView(): VueWrapper {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(found, `button "${label}"`).toBeTruthy();
  return found!;
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string): Promise<void> {
  const field = wrapper.find(selector);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
}

/** Types into one `vscode-textfield` of a repeatable (model/header) row. */
async function typeIntoRowField(
  wrapper: VueWrapper,
  rowIndex: number,
  fieldIndex: number,
  value: string,
): Promise<void> {
  const row = wrapper.findAll('.repeatable-row')[rowIndex];
  expect(row, `repeatable row ${rowIndex}`).toBeTruthy();
  const field = row!.findAll('vscode-textfield')[fieldIndex];
  (field!.element as unknown as { value: string }).value = value;
  await field!.trigger('input');
}

/** The add-mode editor, with the fields the record's trigger is about. */
async function openAddEditor(wrapper: VueWrapper): Promise<void> {
  await button(wrapper, 'Add Endpoint').trigger('click');
  await wrapper.vm.$nextTick();
}

/**
 * The text of one `vscode-textfield`, read from the element's property when a
 * test typed it there and from its `value` attribute when Vue rendered it (the
 * same custom-element-means-no-property asymmetry as everywhere else in this
 * suite).
 */
function fieldText(field: { element: unknown; attributes(name: string): string | undefined }): string {
  const value = (field.element as { value?: unknown }).value;
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  return field.attributes('value') ?? '';
}

/**
 * The models the draft currently declares, in order.
 */
function declaredModels(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.repeatable-row')
    .map((row) => fieldText(row.findAll('vscode-textfield')[0]!))
    .filter((id) => id !== '');
}

/** The payload the last probe was posted with. */
function probedDraft(): AiProviderDraftProbe {
  const calls = stateMock.testAiProviderDraft.mock.calls;
  expect(calls.length, 'probe calls').toBeGreaterThan(0);
  return calls[calls.length - 1]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  stateMock.settingsSurface.value = surfaceOf();
  stateMock.aiProviderSettings.value = providerSnapshotOf();
  stateMock.testAiProviderDraft.mockImplementation(async () => reportOf());
  stateMock.testAiProvider.mockImplementation(async () => reportOf());
  stateMock.saveAiProvider.mockImplementation(async (provider: { id: string }) => ({ id: provider.id }));
  stateMock.setAiProviderSecret.mockImplementation(async () => ({ set: true }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('when the automatic probe runs', () => {
  it('waits 800 ms of idle after a complete address and a typed credential', async () => {
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);

    await vi.advanceTimersByTimeAsync(799);
    expect(stateMock.testAiProviderDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);
    // The editor's own fields, including the credential that was typed and the id
    // and name this page generated from the address.
    expect(probedDraft()).toEqual({
      id: 'api-example-com',
      name: 'api.example.com',
      baseUrl: BASE_URL,
      auth: 'bearer',
      key: API_KEY,
      headers: [],
    });
    wrapper.unmount();
  });

  it('cancels the pending probe when the user keeps typing, and probes the last value once', async () => {
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', 'sk-a');
    await vi.advanceTimersByTimeAsync(400);
    expect(stateMock.testAiProviderDraft).not.toHaveBeenCalled();

    // The user is still typing the credential: the window restarts.
    await typeInto(wrapper, '#ai-provider-key', 'sk-ab');
    await vi.advanceTimersByTimeAsync(400);
    expect(stateMock.testAiProviderDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);
    expect(probedDraft()['key']).toBe('sk-ab');
    wrapper.unmount();
  });

  it('runs one shot per input combination, and again for a different one', async () => {
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);
    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);

    // Nothing changed: no second probe, however long the editor stays open.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);

    // A new credential is a new combination.
    await typeInto(wrapper, '#ai-provider-key', `${API_KEY}-2`);
    await vi.advanceTimersByTimeAsync(800);
    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(2);
    expect(probedDraft()['key']).toBe(`${API_KEY}-2`);
    wrapper.unmount();
  });

  it('needs no credential for an endpoint that sends none', async () => {
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    const auth = wrapper.find('#ai-provider-auth');
    (auth.element as unknown as { value: string }).value = 'none';
    await auth.trigger('change');

    await vi.advanceTimersByTimeAsync(800);

    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);
    expect(probedDraft()['auth']).toBe('none');
    expect(probedDraft()['key']).toBe('');
    wrapper.unmount();
  });

  it('does not probe an existing endpoint whose key field was left empty', async () => {
    // Opening a stored endpoint is not an input event: the key field is empty by
    // design (a secret is never read back), so there is no newly typed credential
    // for the probe to carry.
    stateMock.aiProviderSettings.value = providerSnapshotOf({
      providers: [
        {
          id: 'api-example-com',
          name: 'api.example.com',
          baseUrl: BASE_URL,
          models: [],
          auth: 'bearer',
          headers: [],
          keySet: true,
          address: BASE_URL,
          insecure: false,
        },
      ],
    });
    vi.useFakeTimers();
    const editing = mountView();
    await vi.advanceTimersByTimeAsync(0);
    await button(editing, 'Edit').trigger('click');
    await vi.advanceTimersByTimeAsync(0);

    await typeInto(editing, '#ai-provider-base-url', `${BASE_URL}/`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(stateMock.testAiProviderDraft).not.toHaveBeenCalled();
    editing.unmount();
  });

  it('sends nothing when an existing endpoint that needs no credential is opened, and probes once it is edited', async () => {
    // The defect a live walkthrough found: `auth: none` needs no credential, so the
    // editor's own prefill satisfied the probe's condition the moment the editor
    // opened and a `GET /models` left the machine about a second later — before any
    // typing. An edit is required in every case, `auth: none` included.
    stateMock.aiProviderSettings.value = providerSnapshotOf({
      providers: [
        {
          id: 'local-endpoint',
          name: 'Local (this machine)',
          baseUrl: 'http://localhost:11434/v1',
          models: [],
          auth: 'none',
          headers: [],
          keySet: false,
          address: 'http://localhost:11434/v1',
          insecure: false,
        },
      ],
    });
    vi.useFakeTimers();
    const wrapper = mountView();
    await vi.advanceTimersByTimeAsync(0);
    await button(wrapper, 'Edit').trigger('click');
    await vi.advanceTimersByTimeAsync(5_000);

    // Opening the editor — and switching to another endpoint, which fills the same
    // fields — is not an input event.
    expect(stateMock.testAiProviderDraft).not.toHaveBeenCalled();

    await typeInto(wrapper, '#ai-provider-base-url', 'http://localhost:11434/v1/');
    await vi.advanceTimersByTimeAsync(800);

    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);
    expect(probedDraft()['auth']).toBe('none');
    expect(probedDraft()['key']).toBe('');
    wrapper.unmount();
  });

  it('arms the probe when only the authentication style is edited', async () => {
    // §4.3 names the authentication style as one of the three fields whose edit is
    // the input: switching a stored endpoint to `auth: none` is what makes the
    // address enough on its own, so that click alone has to arm the probe.
    stateMock.aiProviderSettings.value = providerSnapshotOf({
      providers: [
        {
          id: 'api-example-com',
          name: 'api.example.com',
          baseUrl: BASE_URL,
          models: [],
          auth: 'bearer',
          headers: [],
          keySet: true,
          address: BASE_URL,
          insecure: false,
        },
      ],
    });
    vi.useFakeTimers();
    const wrapper = mountView();
    await vi.advanceTimersByTimeAsync(0);
    await button(wrapper, 'Edit').trigger('click');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stateMock.testAiProviderDraft).not.toHaveBeenCalled();

    const auth = wrapper.find('#ai-provider-auth');
    (auth.element as unknown as { value: string }).value = 'none';
    await auth.trigger('change');
    await vi.advanceTimersByTimeAsync(800);

    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);
    expect(probedDraft()['auth']).toBe('none');
    wrapper.unmount();
  });

  it('runs the probe control on demand even when the automatic path is not armed', async () => {
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    // No credential typed: the automatic path stays disarmed.
    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stateMock.testAiProviderDraft).not.toHaveBeenCalled();

    await button(wrapper, 'Probe model list').trigger('click');
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);
    expect(probedDraft()['key']).toBe('');
    wrapper.unmount();
  });

  it('still lets the probe control send for an opened endpoint that was never edited', async () => {
    // The edit rule guards the **automatic** path only. The control is a click, so
    // it must keep working on an endpoint the user just opened: tightening the
    // automatic rule into "nothing may be sent until an edit" would leave the page
    // unable to probe a stored endpoint at all.
    stateMock.aiProviderSettings.value = providerSnapshotOf({
      providers: [
        {
          id: 'api-example-com',
          name: 'api.example.com',
          baseUrl: BASE_URL,
          models: [],
          auth: 'bearer',
          headers: [],
          keySet: true,
          address: BASE_URL,
          insecure: false,
        },
      ],
    });
    vi.useFakeTimers();
    const wrapper = mountView();
    await vi.advanceTimersByTimeAsync(0);
    await button(wrapper, 'Edit').trigger('click');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stateMock.testAiProviderDraft).not.toHaveBeenCalled();

    await button(wrapper, 'Probe model list').trigger('click');
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});

describe('what the probe does with its answer', () => {
  it('adds the reported models as ordinary rows without touching the hand-written ones', async () => {
    stateMock.testAiProviderDraft.mockImplementation(async () =>
      reportOf({ models: ['hand-written', 'reported-a', 'reported-b'] }),
    );
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await button(wrapper, 'Add model').trigger('click');
    await typeIntoRowField(wrapper, 0, 0, 'hand-written');
    await typeIntoRowField(wrapper, 0, 1, 'My own name');
    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);

    expect(declaredModels(wrapper)).toEqual(['hand-written', 'reported-a', 'reported-b']);
    expect(wrapper.text()).toContain("Added 2 model(s) from the endpoint's /models");
    // A success carries the one sentence a reader can take the wrong way: finding
    // models is not permission to send content anywhere.
    expect(wrapper.find('.probe-consent').text()).toContain('This does not mean requests are allowed');
    // The row's own display name is the user's and is not overwritten.
    expect(fieldText(wrapper.findAll('.repeatable-row')[0]!.findAll('vscode-textfield')[1]!)).toBe('My own name');
    wrapper.unmount();
  });

  it('replaces the empty placeholder row rather than adding to it', async () => {
    stateMock.testAiProviderDraft.mockImplementation(async () => reportOf({ models: ['reported-a'] }));
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);

    expect(declaredModels(wrapper)).toEqual(['reported-a']);
    wrapper.unmount();
  });

  it('says nothing was added when the endpoint reports nothing new', async () => {
    stateMock.testAiProviderDraft.mockImplementation(async () => reportOf({ models: [] }));
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);

    expect(wrapper.text()).toContain('reported no model this list does not already declare');
    // An answer that adds nothing is still an answer: the consent line belongs
    // here too, or "it answered" would read as permission again.
    expect(wrapper.find('.probe-consent').text()).toContain('This does not mean requests are allowed');
    wrapper.unmount();
  });

  it('reports a failure as the host sentence in a card, with the form still usable', async () => {
    stateMock.testAiProviderDraft.mockImplementation(async () =>
      reportOf({
        ok: false,
        ran: true,
        status: undefined,
        elapsedMs: undefined,
        summary: undefined,
        models: undefined,
        reason: 'The AI endpoint "api.example.com" rejected the credential (HTTP 401).',
      }),
    );
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);

    const report = wrapper.find('.test-report');
    expect(report.exists()).toBe(true);
    expect(report.text()).toContain('failed the test');
    expect(report.text()).toContain('rejected the credential (HTTP 401)');
    // The line above the model rows says what happened and where the reason is: the
    // card is below the rows and routinely below the fold, so a failed probe used to
    // leave that line empty and read as "nothing happened".
    const status = wrapper.find('.probe-status');
    expect(status.text()).toContain('did not get an answer');
    expect(status.text()).toContain('report below');
    // A probe that got no answer sent nothing, so it cannot be mistaken for
    // permission and carries no consent line.
    expect(wrapper.find('.probe-consent').exists()).toBe(false);
    // The card also says it came from the automatic probe, not from a pressed test.
    expect(report.text()).toContain('automatic model-list probe');
    // No native dialog: the page has never raised one for a setting, and a probe
    // the user did not click must not start one.
    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    // The editor is still the add-mode editor, and Save still works.
    expect(wrapper.find('.editor-title').text()).toBe('Add AI Endpoint');
    await button(wrapper, 'Save endpoint').trigger('click');
    await vi.advanceTimersByTimeAsync(0);
    expect(stateMock.saveAiProvider).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('says nothing was sent when the probe was refused, and points at the card', async () => {
    stateMock.testAiProviderDraft.mockImplementation(async () =>
      reportOf({
        ok: false,
        ran: false,
        status: undefined,
        elapsedMs: undefined,
        summary: undefined,
        models: undefined,
        reason: 'The AI endpoint "api.example.com" needs a stored credential and none is.',
      }),
    );
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);

    expect(wrapper.find('.probe-status').text()).toContain('sent nothing');
    expect(wrapper.find('.test-report').text()).toContain('was not tested: nothing was sent');
    // Nothing was sent, so there is nothing to read as consent.
    expect(wrapper.find('.probe-consent').exists()).toBe(false);
    wrapper.unmount();
  });

  it('tells the automatic probe card apart from the card a pressed test produced', async () => {
    // One editor can hold two reports at once — the automatic probe's and the
    // pressed "Test connection"'s — and both titles are built from the same outcome
    // wording and the same display name. A live walkthrough found an automatic "was
    // not tested" card stacking under an explicit "answered" card and the two
    // reading as the same card twice; each card now names its own source.
    stateMock.aiProviderSettings.value = providerSnapshotOf({
      providers: [
        {
          id: 'api-example-com',
          name: 'api.example.com',
          baseUrl: BASE_URL,
          models: [],
          auth: 'bearer',
          headers: [],
          keySet: true,
          address: BASE_URL,
          insecure: false,
        },
      ],
    });
    vi.useFakeTimers();
    const wrapper = mountView();
    await vi.advanceTimersByTimeAsync(0);
    await button(wrapper, 'Edit').trigger('click');
    await vi.advanceTimersByTimeAsync(0);

    await button(wrapper, 'Test connection').trigger('click');
    await vi.advanceTimersByTimeAsync(0);
    const pressed = wrapper.findAll('.test-report');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.text()).toContain('From the Test connection button you pressed.');

    stateMock.testAiProviderDraft.mockImplementation(async () =>
      reportOf({ ok: false, ran: false, reason: 'Nothing was sent: no credential is stored.' }),
    );
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);

    const cards = wrapper.findAll('.test-report');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.text()).toContain('automatic model-list probe');
    expect(cards[1]!.text()).toContain('Test connection button you pressed');
    expect(cards[0]!.text()).not.toBe(cards[1]!.text());
    wrapper.unmount();
  });

  it('never saves anything on its own: the probe is a prefill, not a write', async () => {
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);
    expect(stateMock.testAiProviderDraft).toHaveBeenCalledTimes(1);

    // Nothing reached settings or secret storage, and the editor did not close.
    expect(stateMock.saveAiProvider).not.toHaveBeenCalled();
    expect(stateMock.setAiProviderSecret).not.toHaveBeenCalled();
    expect(stateMock.setAiModelPolicy).not.toHaveBeenCalled();
    expect(wrapper.find('.editor-title').exists()).toBe(true);
    wrapper.unmount();
  });

  it('drops everything the probe produced when the editor closes', async () => {
    vi.useFakeTimers();
    const wrapper = mountView();
    await openAddEditor(wrapper);

    await typeInto(wrapper, '#ai-provider-base-url', BASE_URL);
    await typeInto(wrapper, '#ai-provider-key', API_KEY);
    await vi.advanceTimersByTimeAsync(800);
    expect(wrapper.find('.test-report').exists()).toBe(true);

    await button(wrapper, 'Cancel').trigger('click');
    await vi.advanceTimersByTimeAsync(0);
    await button(wrapper, 'Add Endpoint').trigger('click');
    await vi.advanceTimersByTimeAsync(0);

    expect(wrapper.find('.test-report').exists()).toBe(false);
    expect(declaredModels(wrapper)).toEqual([]);
    wrapper.unmount();
  });
});
