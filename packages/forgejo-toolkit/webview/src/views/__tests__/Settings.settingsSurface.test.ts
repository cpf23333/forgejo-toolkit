import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type {
  AiProviderSettingsSnapshot,
  SettingsSurfaceSnapshot,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { AI_PRE_REVIEW_PROMPT_SCOPES } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The settings this page presents itself (`docs/design/settings-page.md` §1.3,
 * §2, §3.2): notifications with the multi-window lease, the MCP surface with its
 * three write gates and the audit switch, and the AI pre-review switch with the
 * prompt scope.
 *
 * What each test pins:
 *
 * 1. **Every control shows the host's reading**, never a value the page keeps.
 *    The page has no default of its own: the switches are the host's, and a
 *    refused write puts the control back on the value that is actually stored.
 * 2. **The defaults are stated in words, not prefilled** (§3.2): a control that
 *    showed a default would make "I never chose" and "I chose the default" look
 *    the same.
 * 3. **The settings that stay native are named, not re-implemented** (§2.2): the
 *    transport is a pointer row with its full id, and the transport's value still
 *    travels with a policy write rather than being dropped.
 * 4. **The scope values are the host's enumeration** (§3.2), so the page cannot
 *    offer a value the host would refuse.
 */

const { stateMock, surface } = vi.hoisted(() => {
  const holder = {
    current: undefined as unknown,
    /**
     * Writes the surface into the state **through the reactive proxy** the page
     * holds. The raw object is what this file owns, but the page reads the
     * proxy: a write to the raw target is invisible to it, so the loader and the
     * write reply both go through here — which is what the real composable does
     * (`settingsSurface.value = answer.snapshot`).
     */
    apply: undefined as undefined | ((snapshot: unknown) => void),
  };
  const mock = {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
    settingsSurface: { value: undefined as unknown },
    loadSettingsSurface: vi.fn(async () => {
      holder.apply?.(holder.current);
      return holder.current;
    }),
    setSettingsSurfaceValue: vi.fn(async () => {
      // The answer arrives a microtask later, as a host reply does: applying it
      // in the same tick as the click would hide the intermediate render in which
      // the control already shows the click's value — and that intermediate state
      // is exactly what "the control follows the host" is about.
      await Promise.resolve();
      holder.apply?.(holder.current);
      return { snapshot: holder.current };
    }),
    openNativeSettings: vi.fn(),
    aiProviderSettings: { value: undefined as unknown },
    loadAiProviderSettings: vi.fn(async () => {
      mock.aiProviderSettings.value = providerSnapshotHolder.current;
      return providerSnapshotHolder.current;
    }),
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
    testAiProviderDraft: vi.fn(async () => ({
      providerId: '',
      providerName: '',
      address: '',
      ok: true,
      ran: true,
      shadowed: [],
    })),
    /**
     * The four policy gates. The declared return type is the full transport union
     * rather than one call's literal, so a test can answer with another transport
     * without a cast.
     */
    setAiModelPolicy: vi.fn(
      async (): Promise<{
        enabled: boolean;
        transport: AiProviderSettingsSnapshot['transport'];
        localOnly: boolean;
        requestTimeoutMs: number;
      }> => ({
        enabled: false,
        transport: 'auto',
        localOnly: false,
        requestTimeoutMs: 30_000,
      }),
    ),
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
  const providerSnapshotHolder: { current: unknown } = { current: undefined };
  return { stateMock: mock, surface: holder };
});

vi.mock('../../composables/useAppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useAppState')>();
  const { reactive: makeReactive } = await import('vue');
  const reactiveState = makeReactive(stateMock);
  // `reactiveState.settingsSurface` is the nested proxy, so assigning `.value`
  // through it is what the page actually observes.
  surface.apply = (snapshot: unknown) => {
    (reactiveState as { settingsSurface: { value: unknown } }).settingsSurface.value = snapshot;
  };
  return {
    ...actual,
    useAppState: () => reactiveState,
  };
});

import Settings from '../Settings.vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import en from '../../i18n/en.json';
import zh from '../../i18n/zh.json';

/** The manifest's defaults, i.e. what a fresh install reports. */
function surfaceOf(overrides: Partial<SettingsSurfaceSnapshot> = {}): SettingsSurfaceSnapshot {
  return {
    notificationPollingEnabled: true,
    mcpEnabled: true,
    mcpWriteTools: { createIssueComment: false, submitPullReview: false, cancelActionRun: false },
    mcpWriteAuditToFile: false,
    multiWindowLease: true,
    aiPreReview: false,
    aiPreReviewPromptScope: 'ask',
    ...overrides,
  };
}

function providerSnapshotOf(overrides: Partial<AiProviderSettingsSnapshot> = {}): AiProviderSettingsSnapshot {
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

function mountView(): VueWrapper {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

/**
 * The `on`/`off` state of one boolean control in this environment.
 *
 * `vscode-checkbox` is not registered with `customElements` under jsdom, so the
 * first render writes the **attribute** (`checked="true"` / `"false"` — Vue cannot
 * set a DOM property an unknown element does not have). The moment a test assigns
 * `.checked` to simulate a click, the element does have that property, and Vue's
 * later patches set the property instead — which is also what the component and
 * the change handler read. Both places are therefore consulted, property first.
 */
function isOn(wrapper: VueWrapper, selector: string, property: 'checked' | 'disabled'): boolean {
  const element = wrapper.find(selector).element as unknown as Record<string, unknown>;
  if (typeof element[property] === 'boolean') {
    return element[property] as boolean;
  }
  return wrapper.find(selector).attributes(property) === 'true';
}

function checked(wrapper: VueWrapper, selector: string): boolean {
  return isOn(wrapper, selector, 'checked');
}

function disabled(wrapper: VueWrapper, selector: string): boolean {
  return isOn(wrapper, selector, 'disabled');
}

beforeEach(() => {
  vi.clearAllMocks();
  surface.current = surfaceOf();
  stateMock.settingsSurface.value = undefined;
  stateMock.aiProviderSettings.value = undefined;
  // A `mockImplementation` from one test would otherwise outlive it: the loader
  // is restored to the host's own behaviour, which is the reading the page was
  // told about.
  stateMock.loadSettingsSurface.mockImplementation(async () => {
    surface.apply?.(surface.current);
    return surface.current;
  });
  stateMock.setSettingsSurfaceValue.mockImplementation(async () => {
    await Promise.resolve();
    surface.apply?.(surface.current);
    return { snapshot: surface.current };
  });
  stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({ models: [], configured: '' }));
  stateMock.testAiProviderDraft.mockImplementation(async () => ({
    providerId: '',
    providerName: '',
    address: '',
    ok: true,
    ran: true,
    shadowed: [],
  }));
});

describe('the settings the page presents', () => {
  it('shows every switch as the host last read it', async () => {
    surface.current = surfaceOf({
      notificationPollingEnabled: false,
      mcpEnabled: true,
      mcpWriteTools: { createIssueComment: true, submitPullReview: false, cancelActionRun: true },
      mcpWriteAuditToFile: true,
      multiWindowLease: false,
      aiPreReview: true,
      aiPreReviewPromptScope: 'changed-files',
    });
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    expect(checked(wrapper, '#notification-polling-enabled')).toBe(false);
    expect(checked(wrapper, '#mcp-enabled')).toBe(true);
    expect(checked(wrapper, '#mcp-write-create-issue-comment')).toBe(true);
    expect(checked(wrapper, '#mcp-write-submit-pull-review')).toBe(false);
    expect(checked(wrapper, '#mcp-write-cancel-action-run')).toBe(true);
    expect(checked(wrapper, '#mcp-write-audit-to-file')).toBe(true);
    expect(checked(wrapper, '#multi-window-lease')).toBe(false);
    expect(checked(wrapper, '#ai-pre-review-enabled')).toBe(true);
    expect(wrapper.find('#ai-pre-review-scope').attributes('value')).toBe('changed-files');
    wrapper.unmount();
  });

  it('states each default in words instead of prefilling the control', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    // The four defaults the record names, each in its own section.
    expect(wrapper.text()).toContain('Default on: polling works as soon as an instance is configured.');
    expect(wrapper.text()).toContain('Default on: one window polls and raises the alerts, the others stay quiet.');
    expect(wrapper.text()).toContain('Default on: the servers work as soon as an instance is configured.');
    expect(wrapper.text()).toContain('Default off: every write tool stays off until you turn on the one you mean.');
    expect(wrapper.text()).toContain(
      'Default off: the audit stays in the Forgejo Toolkit output channel, and is lost when the window closes.',
    );
    expect(wrapper.text()).toContain('Default off: nothing is sent to a model until you turn this on.');
    expect(wrapper.text()).toContain('Default: `ask` — the first run asks once and writes your answer here.');
    wrapper.unmount();
  });

  it('states where the audit goes when — and only when — it is written to a file', async () => {
    surface.current = surfaceOf({ mcpWriteAuditToFile: true });
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    // The file's path and cap are stated where the switch is, not only in the
    // manifest's own description.
    expect(wrapper.text()).toContain('mcp-write-audit.jsonl');
    expect(wrapper.text()).toContain('capped at 1 MB');
    wrapper.unmount();

    surface.current = surfaceOf({ mcpWriteAuditToFile: false });
    const off = mountView();
    await flushPromises();

    expect(off.text()).not.toContain('mcp-write-audit.jsonl');
    off.unmount();
  });

  it('says what an off switch means, and stops saying it when it is on', async () => {
    surface.current = surfaceOf({
      notificationPollingEnabled: false,
      mcpEnabled: false,
      multiWindowLease: false,
      aiPreReview: false,
    });
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const off = mountView();
    await flushPromises();

    expect(off.text()).toContain('While this is off the unread badge and the alerts stop updating.');
    // The sentence the manifest's own description gives for turning MCP off.
    expect(off.text()).toContain('keeps the server process it started until you reload the window');
    expect(off.text()).toContain('With this off every window polls and alerts on its own');
    expect(off.text()).toContain('a run uses them only while this is on');
    off.unmount();

    surface.current = surfaceOf({ notificationPollingEnabled: true, mcpEnabled: true, multiWindowLease: true });
    const on = mountView();
    await flushPromises();

    expect(on.text()).not.toContain('the alerts stop updating');
    expect(on.text()).not.toContain('keeps the server process it started');
    expect(on.text()).not.toContain('every window polls and alerts on its own');
    on.unmount();
  });

  it('names the native-only settings instead of re-implementing them', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    // The two pointer rows, each with the full id the user has to search for.
    const pointers = wrapper.findAll('.pointer-row');
    expect(pointers).toHaveLength(2);
    expect(pointers[0]!.text()).toContain('forgejoToolkit.notificationPollingInterval');
    expect(pointers[1]!.text()).toContain('forgejoToolkit.aiTransport');
    // The transport is no longer a control of this page (§1.3).
    expect(wrapper.find('#ai-transport').exists()).toBe(false);
    wrapper.unmount();
  });

  it('opens the filtered native settings editor from the header and from both pointer rows', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    const header = wrapper
      .findAll('vscode-button')
      .find((button) => button.text().trim() === 'Open Extension Settings');
    expect(header, 'the header control').toBeTruthy();
    await header!.trigger('click');
    expect(stateMock.openNativeSettings).toHaveBeenCalledTimes(1);

    // Every entry point goes through the one action, which posts the one command
    // the host implements with the extension's own id as the filter (§2.1, §2.2):
    // a second, hand-written filter is how the two rows and the header could drift
    // apart, and one of them opening an unfiltered editor is the defect this pins.
    const pointers = wrapper.findAll('.pointer-row');
    expect(pointers).toHaveLength(2);
    await pointers[0]!.trigger('click');
    expect(stateMock.openNativeSettings).toHaveBeenCalledTimes(2);
    await pointers[1]!.trigger('click');
    expect(stateMock.openNativeSettings).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });
});

describe('writing one setting from the page', () => {
  it('writes the full setting id and shows what the host stored', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    // The host's answer is a reading in which the switch is off; the mock applies
    // it through the state the page holds, exactly as the composable does.
    surface.current = surfaceOf({ notificationPollingEnabled: false });

    const checkbox = wrapper.find('#notification-polling-enabled');
    (checkbox.element as unknown as { checked: boolean }).checked = false;
    await checkbox.trigger('change');
    await flushPromises();

    expect(stateMock.setSettingsSurfaceValue).toHaveBeenCalledWith('forgejoToolkit.notificationPollingEnabled', false);
    expect(checked(wrapper, '#notification-polling-enabled')).toBe(false);
    wrapper.unmount();
  });

  it('puts the control back on the stored value and prints the host sentence when the write is refused', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    // The host refused: the reading it answers with is unchanged, and its own
    // sentence says why. The page adds no interpretation of its own.
    surface.current = surfaceOf({ notificationPollingEnabled: true });
    stateMock.setSettingsSurfaceValue.mockImplementation(async () => {
      await Promise.resolve();
      const snapshot = surfaceOf({ notificationPollingEnabled: true });
      surface.apply?.(snapshot);
      return {
        snapshot,
        error: 'The setting "forgejoToolkit.notificationPollingEnabled" was not written: no write access',
      };
    });

    const checkbox = wrapper.find('#notification-polling-enabled');
    (checkbox.element as unknown as { checked: boolean }).checked = false;
    await checkbox.trigger('change');
    await flushPromises();

    expect(checked(wrapper, '#notification-polling-enabled')).toBe(true);
    expect(wrapper.text()).toContain('was not written: no write access');
    wrapper.unmount();
  });

  it('offers exactly the host’s five prompt scopes and stores the one picked', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    const select = wrapper.find('#ai-pre-review-scope');
    const values = select.findAll('vscode-option').map((option) => option.attributes('value'));
    expect(values).toEqual([...AI_PRE_REVIEW_PROMPT_SCOPES]);

    (select.element as unknown as { value: string }).value = 'full-diff';
    await select.trigger('change');

    expect(stateMock.setSettingsSurfaceValue).toHaveBeenCalledWith(
      'forgejoToolkit.aiPreReviewPromptScope',
      'full-diff',
    );
    wrapper.unmount();
  });

  it('has a label for every scope value in both catalogues', () => {
    // The select is a `v-for` over the shared enumeration, so the labels cannot be
    // checked statically like a `t('…')` literal: this is what keeps the two
    // catalogues complete for it.
    for (const scope of AI_PRE_REVIEW_PROMPT_SCOPES) {
      const key = `settings.aiPreReview.scopeOption.${scope}`;
      const read = (catalogue: unknown): string => {
        const settings = (catalogue as { settings: { aiPreReview: { scopeOption: Record<string, string> } } }).settings;
        return settings.aiPreReview.scopeOption[scope] ?? '';
      };
      expect(read(en), key).not.toBe('');
      expect(read(zh), key).not.toBe('');
      expect(read(zh), key).not.toBe(read(en));
    }
  });

  it('keeps sending the transport with a policy write although the page no longer renders it', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf({ transport: 'openai-compatible' });
    stateMock.setAiModelPolicy.mockImplementation(async () => ({
      enabled: false,
      transport: 'openai-compatible' as const,
      localOnly: true,
      requestTimeoutMs: 30_000,
    }));
    const wrapper = mountView();
    await flushPromises();

    const checkbox = wrapper.find('#ai-local-only');
    (checkbox.element as unknown as { checked: boolean }).checked = true;
    await checkbox.trigger('change');
    await flushPromises();

    expect(stateMock.setAiModelPolicy).toHaveBeenCalledWith({
      enabled: false,
      transport: 'openai-compatible',
      localOnly: true,
      requestTimeoutMs: 30_000,
    });
    wrapper.unmount();
  });

  it('disables the controls until the host has reported, so nothing shows an invented value', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    // A load that never answers: the page must not present the switches as off.
    stateMock.loadSettingsSurface.mockImplementation(async () => {
      stateMock.settingsSurface.value = undefined;
      return undefined;
    });

    const wrapper = mountView();
    await flushPromises();

    expect(disabled(wrapper, '#notification-polling-enabled')).toBe(true);
    expect(disabled(wrapper, '#mcp-enabled')).toBe(true);
    expect(disabled(wrapper, '#ai-pre-review-scope')).toBe(true);
    wrapper.unmount();
  });

  it('disables only the section whose write is in flight', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    let release: (() => void) | undefined;
    stateMock.setSettingsSurfaceValue.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { snapshot: surfaceOf({ mcpEnabled: false }) };
    });
    const wrapper = mountView();
    await flushPromises();

    const checkbox = wrapper.find('#mcp-enabled');
    (checkbox.element as unknown as { checked: boolean }).checked = false;
    await checkbox.trigger('change');
    await flushPromises();

    // A write is a round trip; greying out an unrelated switch while it lands
    // would claim the page is busy when only its own section is.
    expect(disabled(wrapper, '#mcp-enabled')).toBe(true);
    expect(disabled(wrapper, '#notification-polling-enabled')).toBe(false);

    release?.();
    await flushPromises();
    expect(disabled(wrapper, '#mcp-enabled')).toBe(false);
    wrapper.unmount();
  });
});
