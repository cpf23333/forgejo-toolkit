import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type {
  AiProviderSettingsSnapshot,
  SettingsSurfaceSnapshot,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import {
  AI_PRE_REVIEW_PROMPT_SCOPES,
  AI_TRANSPORT_CHOICES,
  PR_DESCRIPTION_PROMPT_SCOPES,
  SETTINGS_SURFACE_WRITABLE_KEYS,
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
    settingsRefreshTick: { value: 0 },
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
import {
  createTestRouter,
  createTestI18n,
  settingSources,
  settingsSurfaceFixture,
} from '../../__tests__/helpers/test-utils';
import en from '../../i18n/en.json';
import zh from '../../i18n/zh.json';

/**
 * The page's own source. One rule about the source map is a property of the read
 * rather than of a render (`sourceOverride` must not optional-chain the map), and
 * the webview tests run without Node types, so it is read through Vite's glob —
 * the same way `Settings.instanceEditorLayout.test.ts` reads it.
 */
const settingsSource = Object.values(
  import.meta.glob('../Settings.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
)[0] as string;

/**
 * The manifest's defaults, i.e. what a fresh install reports.
 *
 * The source map is stated at `default` — nothing above the user's own level
 * holds anything, which is what makes every source note stay away — and every
 * fixture built from `settingsSurfaceFixture()` carries the whole map, so a
 * reading that dropped it cannot be written here at all (§3.5).
 */
function surfaceOf(overrides: Partial<SettingsSurfaceSnapshot> = {}): SettingsSurfaceSnapshot {
  return settingsSurfaceFixture({ sources: settingSources('default'), ...overrides });
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

  it('renders the last two settings that used to be native-only', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    // `notificationPollingInterval`: a number field with the range the manifest
    // declares, and its own Save control, so a draft is only written when asked.
    const interval = wrapper.find('#notification-polling-interval');
    expect(interval.exists()).toBe(true);
    expect(interval.attributes('label')).toBe('Polling interval (seconds)');
    // `vscode-textfield` is not a registered custom element under jsdom either, so
    // the field's value lands on the element as an **attribute** — the same split
    // the `checked` helper at the top of this file deals with.
    expect(interval.attributes('value')).toBe('300');
    expect(wrapper.text()).toContain('between 60 and 3600');
    // `useMockApi`: a switch in the developer passage of 通用, which says what it
    // does, that the data on screen is sample data while it is on, and that it
    // takes effect after a window reload.
    expect(wrapper.find('#use-mock-api').exists()).toBe(true);
    expect(wrapper.text()).toContain('Developer');
    expect(wrapper.text()).toContain('sample data, not your server');
    expect(wrapper.text()).toContain('reload the window');
    // Nothing is left to VS Code's own editor, so the interval's "more settings"
    // row is gone with the last of them (§2.2): the page does not name the
    // setting as a native one anywhere. (The two AI prose sentences that do spell
    // a setting id are about their own settings, not about this one — §2.3.)
    expect(wrapper.text()).not.toContain('forgejoToolkit.notificationPollingInterval');
    wrapper.unmount();
  });

  it('names the level a control’s value comes from, and only when it is not the user’s own', async () => {
    // §3.5: the page writes the user level, so a workspace value wins over a click
    // here. The note says which level it is and where to change it; every control
    // whose level is the user's own (or the manifest's default) carries nothing.
    surface.current = surfaceOf({
      sources: {
        ...settingSources('user'),
        'forgejoToolkit.notificationPollingEnabled': 'workspace',
        'forgejoToolkit.mcpWriteAuditToFile': 'workspace',
        // Machine-scoped: the host never reports a workspace level for it, and the
        // page has no note for it to render even if one arrived (§3.5).
        'forgejoToolkit.aiEnabled': 'user',
      },
    });
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    const notes = wrapper.findAll('.source-note');
    // Two overridden settings, two notes — and no others anywhere on the page.
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note.text()).toContain('A workspace setting wins here');
      expect(note.text()).toContain('changing this control on this page will not take effect');
      expect(note.find('.source-badge').text()).toBe('Workspace');
    }
    // The action goes through the one entry point to the native editor (§2.1), so
    // the reader can go and change the copy that wins.
    await notes[0]!.find('button').trigger('click');
    expect(stateMock.openNativeSettings).toHaveBeenCalledTimes(1);
    // `aiEnabled` is the machine-scoped control with no note at all (§3.5), and it
    // is still rendered and still writable.
    expect(wrapper.find('#ai-enabled').exists()).toBe(true);
    expect(wrapper.find('#ai-enabled').attributes('disabled')).not.toBe('true');
    wrapper.unmount();
  });

  it('shows no source note when no level above the user’s own holds anything', async () => {
    // The overridden case above is only half of the rule: with nothing overriding,
    // nothing is rendered — no marker, no sentence, no action.
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.findAll('.source-note')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('wins here');
    wrapper.unmount();
  });

  it('states a source map for every reading a fixture builds, so a reading cannot drop it', () => {
    // §3.5: the map is required, and `settingsSurfaceFixture()` is how every
    // fixture in this suite states a reading — a fixture that dropped the map
    // could not be written (its type requires one), and a map that lost a key
    // fails here rather than making one control silently unannotatable.
    const reading = settingsSurfaceFixture();
    expect(Object.keys(reading.sources).sort()).toEqual([...SETTINGS_SURFACE_WRITABLE_KEYS].sort());
    for (const level of Object.values(reading.sources)) {
      expect(['default', 'user', 'workspace']).toContain(level);
    }
  });

  it('reads the source map as a required field, not through an optional chain', () => {
    // The page-level half of the same rule, pinned where jsdom cannot show it:
    // the read is `settingsSurface.value?.sources[key]`, so a reading without the
    // map fails during render instead of quietly rendering a page whose every
    // overridden control looks unmarked. Re-adding the second optional chain is
    // what this notices.
    expect(settingsSource).toContain('settingsSurface.value?.sources[');
    expect(settingsSource).not.toContain('sources?.[');
  });

  it('offers the transport from the shared enumeration rather than a copy of it', async () => {
    // The transport became a control of this page (§1.3) because it decides which
    // half of the AI area the page presents. Its three values come from
    // `AI_TRANSPORT_CHOICES`, the enumeration the host reads and writes with, so
    // the page cannot offer one the host would refuse.
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    const transport = wrapper.find('#ai-transport');
    expect(transport.exists()).toBe(true);
    expect(transport.findAll('vscode-option').map((option) => option.attributes('value'))).toEqual([
      ...AI_TRANSPORT_CHOICES,
    ]);
    wrapper.unmount();
  });

  it('opens the filtered native settings editor from the header', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();

    const wrapper = mountView();
    await flushPromises();

    const header = wrapper
      .findAll('vscode-button')
      .find((button) => button.text().trim() === 'Open Extension Settings');
    expect(header, 'the header control').toBeTruthy();
    await header!.trigger('click');
    expect(stateMock.openNativeSettings).toHaveBeenCalledTimes(1);
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

  it('writes the polling interval as a number when its own Save control is pressed', async () => {
    // A typed field, not a switch: the draft is only written when asked, and it is
    // written as a **number**, which is the shape the host validates against the
    // manifest's range. The page never validates the range itself (§7 rule 3).
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    const field = wrapper.find('#notification-polling-interval');
    (field.element as unknown as { value: string }).value = '900';
    await field.trigger('input');
    const save = wrapper.findAll('vscode-button').find((button) => button.text().trim() === 'Save interval');
    expect(save, 'the interval Save control').toBeTruthy();
    await save!.trigger('click');
    await flushPromises();

    expect(stateMock.setSettingsSurfaceValue).toHaveBeenCalledWith('forgejoToolkit.notificationPollingInterval', 900);
    wrapper.unmount();
  });

  it('turns the developer mock switch on through its own setting id', async () => {
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    const checkbox = wrapper.find('#use-mock-api');
    expect(checked(wrapper, '#use-mock-api')).toBe(false);
    (checkbox.element as unknown as { checked: boolean }).checked = true;
    await checkbox.trigger('change');
    await flushPromises();

    expect(stateMock.setSettingsSurfaceValue).toHaveBeenCalledWith('forgejoToolkit.useMockApi', true);
    wrapper.unmount();
  });

  it('still writes the user level when a workspace value is what the control shows', async () => {
    // The note is not a second write scope (§3.5): the page keeps writing the user
    // level and says the workspace copy wins, which is what the reader has to act
    // on. A control that refused to write, or wrote the workspace level, would be
    // the second writable source §7 rule 1 forbids.
    surface.current = surfaceOf({
      sources: { ...settingSources('user'), 'forgejoToolkit.notificationPollingEnabled': 'workspace' },
    });
    stateMock.aiProviderSettings.value = providerSnapshotOf();
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.findAll('.source-note')).toHaveLength(1);

    const checkbox = wrapper.find('#notification-polling-enabled');
    (checkbox.element as unknown as { checked: boolean }).checked = false;
    await checkbox.trigger('change');
    await flushPromises();

    expect(stateMock.setSettingsSurfaceValue).toHaveBeenCalledWith('forgejoToolkit.notificationPollingEnabled', false);
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
