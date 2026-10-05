import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type {
  AiProviderSettingsSnapshot,
  SettingsSurfaceSnapshot,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import {
  AI_PRE_REVIEW_PROMPT_SCOPES,
  PR_DESCRIPTION_PROMPT_SCOPES,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

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
 *    polling interval is a pointer row with its full id, while the transport — which
 *    used to be one — is a control of the page now, and its value still travels with
 *    a policy write rather than being dropped.
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
     * The model policy. The declared return type is the full transport union
     * rather than one call's literal, so a test can answer with another transport
     * without a cast.
     */
    setAiModelPolicy: vi.fn(
      async (): Promise<{
        transport: AiProviderSettingsSnapshot['transport'];
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
    aiEnabled: true,
    aiPreReview: false,
    aiPreReviewPromptScope: 'ask',
    prDescription: false,
    prDescriptionPromptScope: 'ask',
    ...overrides,
  };
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
      aiEnabled: true,
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
    expect(checked(wrapper, '#ai-enabled')).toBe(true);
    expect(checked(wrapper, '#ai-pre-review-enabled')).toBe(true);
    expect(wrapper.find('#ai-pre-review-scope').attributes('value')).toBe('changed-files');
    wrapper.unmount();
  });

  it('says what being off means and how to turn it back on, without hiding the rest of the page', async () => {
    // The global AI switch is the layer above the per-feature switches
    // (`docs/design/ai-model-transport.md` §8.3), and the page has to stay coherent
    // while it is off: the sentence says what is closed, and every control whose
    // only writable source is this page stays on it — otherwise turning AI back on
    // would need a value the user can no longer write.
    surface.current = surfaceOf({ aiEnabled: false });
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    expect(checked(wrapper, '#ai-enabled')).toBe(false);
    expect(wrapper.text()).toContain('AI is off, so no AI feature runs');
    expect(wrapper.text()).toContain('turning this switch back on needs no reconfiguration');
    for (const selector of [
      '#ai-enabled',
      '#ai-pre-review-enabled',
      '#ai-pre-review-scope',
      '#pr-description-enabled',
      '#pr-description-scope',
      '#ai-transport',
      '#ai-request-timeout',
    ]) {
      expect(wrapper.find(selector).exists(), selector).toBe(true);
    }
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

  it('names the native-only setting instead of re-implementing it, and renders the transport', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    // The one pointer row that is left, with the full id the user has to search for.
    const pointers = wrapper.findAll('.pointer-row');
    expect(pointers).toHaveLength(1);
    expect(pointers[0]!.text()).toContain('forgejoToolkit.notificationPollingInterval');
    // The transport is a control of this page now (§1.3): the choice decides which
    // half of the AI area the page presents, so it cannot be native-only.
    const transport = wrapper.find('#ai-transport');
    expect(transport.exists()).toBe(true);
    expect(transport.findAll('vscode-option').map((option) => option.attributes('value'))).toEqual([
      'auto',
      'vscode-lm',
      'openai-compatible',
    ]);
    wrapper.unmount();
  });

  it('opens the filtered native settings editor from the header and from the pointer row', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    const header = wrapper
      .findAll('vscode-button')
      .find((button) => button.text().trim() === 'Open Extension Settings');
    expect(header, 'the header control').toBeTruthy();
    await header!.trigger('click');
    expect(stateMock.openNativeSettings).toHaveBeenCalledTimes(1);

    // The one entry point goes through the one action, which posts the one command
    // the host implements with the extension's own id as the filter (§2.1, §2.2):
    // a second, hand-written filter is how the header and the row could drift
    // apart, and one of them opening an unfiltered editor is the defect this pins.
    const pointers = wrapper.findAll('.pointer-row');
    expect(pointers).toHaveLength(1);
    await pointers[0]!.trigger('click');
    expect(stateMock.openNativeSettings).toHaveBeenCalledTimes(2);
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

  it('offers exactly the host’s two PR-description scopes and stores the one picked', async () => {
    // A second pair of controls with its own enumeration: the page must offer the
    // values the host accepts for **this** feature, not the pre-review's, which
    // describe different content (`docs/design/ai-model-transport.md` §7.6).
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    const select = wrapper.find('#pr-description-scope');
    const values = select.findAll('vscode-option').map((option) => option.attributes('value'));
    expect(values).toEqual([...PR_DESCRIPTION_PROMPT_SCOPES]);

    (select.element as unknown as { value: string }).value = 'commits-and-files';
    await select.trigger('change');

    expect(stateMock.setSettingsSurfaceValue).toHaveBeenCalledWith(
      'forgejoToolkit.prDescriptionPromptScope',
      'commits-and-files',
    );
    wrapper.unmount();
  });

  it('writes the PR-description switch as its own setting id', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    const checkbox = wrapper.find('#pr-description-enabled');
    (checkbox.element as unknown as { checked: boolean }).checked = true;
    await checkbox.trigger('change');
    await flushPromises();

    expect(stateMock.setSettingsSurfaceValue).toHaveBeenCalledWith('forgejoToolkit.prDescription', true);
    wrapper.unmount();
  });

  it('has a label for every PR-description scope value in both catalogues', () => {
    for (const scope of PR_DESCRIPTION_PROMPT_SCOPES) {
      const key = `settings.prDescription.scopeOption.${scope}`;
      const read = (catalogue: unknown): string => {
        const settings = (catalogue as { settings: { prDescription: { scopeOption: Record<string, string> } } })
          .settings;
        return settings.prDescription.scopeOption[scope] ?? '';
      };
      expect(read(en), key).not.toBe('');
      expect(read(zh), key).not.toBe('');
      expect(read(zh), key).not.toBe(read(en));
    }
  });

  it('turns the whole AI area off through its own setting id', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    const checkbox = wrapper.find('#ai-enabled');
    expect(checked(wrapper, '#ai-enabled')).toBe(true);
    (checkbox.element as unknown as { checked: boolean }).checked = false;
    await checkbox.trigger('change');
    await flushPromises();

    expect(stateMock.setSettingsSurfaceValue).toHaveBeenCalledWith('forgejoToolkit.aiEnabled', false);
    wrapper.unmount();
  });

  it('writes the transport when — and only when — the select changes', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf({ transport: 'auto' });
    // The host answers with the transport it actually stored, which is what the
    // control then shows: the page never keeps a value it only hoped for.
    stateMock.setAiModelPolicy.mockImplementation(async () => ({
      transport: 'vscode-lm' as const,
      requestTimeoutMs: 30_000,
    }));
    const wrapper = mountView();
    await flushPromises();

    const select = wrapper.find('#ai-transport');
    const before = stateMock.setAiModelPolicy.mock.calls.length;
    (select.element as unknown as { value: string }).value = 'vscode-lm';
    await select.trigger('change');
    await flushPromises();

    expect(stateMock.setAiModelPolicy).toHaveBeenCalledTimes(before + 1);
    expect(stateMock.setAiModelPolicy).toHaveBeenLastCalledWith({
      transport: 'vscode-lm',
      requestTimeoutMs: 30_000,
    });
    // `vscode-single-select` is not a registered custom element under jsdom, so the
    // value the page holds lands on the element as a **property** rather than as an
    // attribute — the same split the `checked` helper at the top deals with.
    expect((wrapper.find('#ai-transport').element as unknown as { value: string }).value).toBe('vscode-lm');
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
    expect(disabled(wrapper, '#ai-enabled')).toBe(true);
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
