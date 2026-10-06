import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The settings page's group navigation (`docs/design/settings-page.md` §9).
 *
 * The page grew to eleven blocks in one scroll column with no navigation at all,
 * five of them from the AI work; §9 divides them into six groups and gives the
 * navigation two shapes, chosen by the width the page measures for itself. What
 * this file pins is the part a rendered page can answer, and it is deliberately
 * the part §9.4 says must not regress:
 *
 * 1. **The mapping is complete and singular.** Every setting the drift guard
 *    counts as rendered (`en.json`'s `settings["forgejoToolkit.*"]` keys) belongs
 *    to exactly one group, and every block the table names is rendered inside
 *    that group's pane. A new block with no home, or one listed twice, fails here.
 * 2. **Nothing is unmounted.** All six panes exist whatever the current group is,
 *    because the page's own suites (and the drift guard's rendered-markup half)
 *    query controls across groups in one mount — an unmounted group would turn
 *    those checks into no-ops rather than failures.
 * 3. **No dead ends.** Every group is one click away from any other, and the
 *    inactive ones are `hidden` + `inert` — off the screen and out of the tab
 *    order — rather than merely invisible.
 * 4. **The shape follows the measured width.** Wide gives the vertical tab list,
 *    narrow gives the selector in the sticky bar, and a resize switches between
 *    them with no second observer and no user setting.
 * 5. **The group is not remembered.** A reopen is a new page (the tab is disposed
 *    with it, §9.3): mounting again starts at 通用.
 * 6. **Both editors come back to their group with focus on the row's button**
 *    (§9.4 rule 3).
 *
 * jsdom lays nothing out, so what the width *is* comes from this file: the page
 * reads `getBoundingClientRect().width` off its own scroll root, which is the
 * number patched below.
 */

const INSTANCE_A = { id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha' };
const INSTANCE_B = { id: 'inst-b', name: 'Beta', url: 'https://forgejo.example.com/beta' };

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
    setAiModelPolicy: vi.fn(async () => ({ transport: 'auto', requestTimeoutMs: 30000 })),
    setAiModelBinding: vi.fn(async () => ({ feature: 'aiPreReview', providerId: '', modelId: '' })),
    setAiDefaultModel: vi.fn(async () => ({ providerId: '', modelId: '' })),
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
        prDescription: false,
        prDescriptionPromptScope: 'ask',
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
import en from '../../i18n/en.json';
import { SETTINGS_GROUPS, WIDE_NAV_MIN_WIDTH } from '../settingsGroups';

/** The observer the page builds: `stickyScrollPadding.test.ts` records the same one. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  readonly observed: Element[] = [];

  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.observed.length = 0;
  }

  /** What a real size change would do: run the callback the page handed in. */
  trigger(): void {
    this.callback();
  }
}

const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
/** The width the page measures for itself, per test. */
let pageWidth = 300;

function mountView(options: { attach?: boolean } = {}): VueWrapper {
  return mount(Settings, {
    ...(options.attach ? { attachTo: document.body } : {}),
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

/** The page after its first measurement has been read. */
async function mountMeasured(width = 300, options: { attach?: boolean } = {}): Promise<VueWrapper> {
  pageWidth = width;
  const wrapper = mountView(options);
  await nextTick();
  return wrapper;
}

function panes(wrapper: VueWrapper) {
  return wrapper.findAll('.settings-pane');
}

function paneFor(wrapper: VueWrapper, group: string) {
  const pane = wrapper.find(`#settings-group-panel-${group}`);
  expect(pane.exists(), `the pane of ${group}`).toBe(true);
  return pane;
}

function isVisible(pane: ReturnType<typeof paneFor>): boolean {
  const element = pane.element as HTMLElement;
  return !element.hasAttribute('hidden') && !element.hasAttribute('inert');
}

async function selectViaNav(wrapper: VueWrapper, group: string) {
  const tab = wrapper.find(`#settings-group-tab-${group}`);
  expect(tab.exists(), `the tab of ${group}`).toBe(true);
  await tab.trigger('click');
  await nextTick();
}

async function selectViaSelector(wrapper: VueWrapper, group: string) {
  const select = wrapper.find('#settings-group-select');
  expect(select.exists(), 'the narrow group selector').toBe(true);
  (select.element as unknown as { value: string }).value = group;
  await select.trigger('change');
  await nextTick();
}

beforeEach(() => {
  vi.clearAllMocks();
  stateMock.instances.value = [{ ...INSTANCE_A }, { ...INSTANCE_B }];
  FakeResizeObserver.instances = [];
  pageWidth = 300;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const width = this.classList?.contains('settings') ? pageWidth : 0;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  } as typeof Element.prototype.getBoundingClientRect;
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
});

describe('Settings groups: the mapping', () => {
  it('gives every rendered setting exactly one group', () => {
    // The drift guard (`src/__tests__/settingsSurface.test.ts`) decides what
    // "rendered" means: the catalogue keys that are a setting's full id. This is
    // the other half — none of them may be homeless, and none may be listed
    // twice, or switching groups could hide a setting's only writable source.
    const renderedKeys = Object.keys(en.settings).filter((key) => key.startsWith('forgejoToolkit.'));
    const mapped = SETTINGS_GROUPS.flatMap((group) => group.settingIds);
    expect([...mapped].sort()).toEqual([...renderedKeys].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('gives every block exactly one group, and every group at least one block', () => {
    const blocks = SETTINGS_GROUPS.flatMap((group) => group.blocks);
    expect(new Set(blocks).size).toBe(blocks.length);
    const empty = SETTINGS_GROUPS.filter((group) => group.blocks.length === 0).map((group) => group.id);
    expect(empty).toEqual([]);
    // The eleven blocks the page had before the split (§9.1), no more and no less.
    expect(blocks).toHaveLength(11);
  });

  it('renders every block inside the pane of the group that claims it', () => {
    // The table above is data; this is the markup it is about. A block moved into
    // the wrong pane (or left outside every pane) fails here even though the table
    // still looks complete.
    const wrapper = mountView();
    const claimed: string[] = [];
    for (const group of SETTINGS_GROUPS) {
      const pane = paneFor(wrapper, group.id);
      const headings = pane.findAll('h2').map((heading) => heading.text());
      for (const block of group.blocks) {
        claimed.push(block);
        expect(headings, `${group.id} renders ${block}`).toContain(labelOf(block));
      }
    }
    // And nothing is rendered that no group claims.
    const rendered = wrapper.findAll('.setting-section').length;
    expect(rendered).toBe(claimed.length);
  });
});

/** The English label one block's key names, through the catalogue's own nesting. */
function labelOf(key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object') {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, en as unknown);
  expect(typeof value, `${key} is a string in en.json`).toBe('string');
  return String(value);
}

describe('Settings groups: mounting and reachability', () => {
  it('mounts all six panes and hides the five that are not current', async () => {
    const wrapper = await mountMeasured();

    expect(panes(wrapper)).toHaveLength(SETTINGS_GROUPS.length);
    for (const group of SETTINGS_GROUPS) {
      const pane = paneFor(wrapper, group.id);
      expect(isVisible(pane), `${group.id} visible`).toBe(group.id === 'general');
      expect(pane.attributes('role')).toBe('tabpanel');
      expect(pane.attributes('aria-labelledby')).toBe(`settings-group-tab-${group.id}`);
    }
  });

  it('keeps every group’s controls in the document, hidden rather than unmounted', async () => {
    // The drift guard and the page's own suites query across groups in one mount;
    // the notification switch is the control `Settings.settingsSurface.test.ts`
    // names, so it stands in for the rest.
    const wrapper = await mountMeasured();
    expect(wrapper.find('#notification-polling-enabled').exists()).toBe(true);
    expect(wrapper.find('#mcp-enabled').exists()).toBe(true);
    expect(wrapper.find('#ai-enabled').exists()).toBe(true);

    await selectViaSelector(wrapper, 'worktree');

    expect(wrapper.find('#notification-polling-enabled').exists()).toBe(true);
    expect(isVisible(paneFor(wrapper, 'notifications'))).toBe(false);
  });

  it('starts on 通用 and remembers nothing across a reopen', async () => {
    const first = await mountMeasured();
    await selectViaSelector(first, 'worktree');
    expect(isVisible(paneFor(first, 'worktree'))).toBe(true);
    first.unmount();

    // A reopened tab is a new page (§9.3): the group is session state, not a
    // setting, and there is deliberately no `setState`/`getState` anywhere.
    const second = await mountMeasured();
    expect(isVisible(paneFor(second, 'general'))).toBe(true);
    second.unmount();
  });

  it('reaches every group in one click, from every group', async () => {
    const wrapper = await mountMeasured(900);
    for (const from of SETTINGS_GROUPS) {
      await selectViaNav(wrapper, from.id);
      for (const to of SETTINGS_GROUPS) {
        await selectViaNav(wrapper, to.id);
        expect(isVisible(paneFor(wrapper, to.id)), `${from.id} → ${to.id}`).toBe(true);
      }
    }
  });
});

describe('Settings groups: the two navigation shapes', () => {
  it('renders the vertical tab list when the page is wide enough', async () => {
    const wrapper = await mountMeasured(WIDE_NAV_MIN_WIDTH);

    const tablist = wrapper.find('[role="tablist"]');
    expect(tablist.exists()).toBe(true);
    expect(tablist.attributes('aria-orientation')).toBe('vertical');
    const tabs = tablist.findAll('[role="tab"]');
    expect(tabs).toHaveLength(SETTINGS_GROUPS.length);
    expect(tabs.map((tab) => tab.text())).toEqual(SETTINGS_GROUPS.map((group) => labelOf(group.labelKey)));
    // One Tab stop for the whole list, and the arrow keys move within it.
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(
      SETTINGS_GROUPS.map((group) => (group.id === 'general' ? '0' : '-1')),
    );
    expect(tabs[0].attributes('aria-selected')).toBe('true');
    expect(tabs[0].attributes('aria-controls')).toBe('settings-group-panel-general');
    // The narrow shape's control is not rendered at all in this shape.
    expect(wrapper.find('#settings-group-select').exists()).toBe(false);
  });

  it('renders the group selector in the sticky bar when the page is narrow', async () => {
    const wrapper = await mountMeasured(WIDE_NAV_MIN_WIDTH - 1);

    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
    expect(wrapper.find('.settings-nav').exists()).toBe(false);
    const select = wrapper.find('#settings-group-select');
    expect(select.exists()).toBe(true);
    expect(select.findAll('vscode-option').map((option) => option.text())).toEqual(
      SETTINGS_GROUPS.map((group) => labelOf(group.labelKey)),
    );
    // It is the sticky block of this shape, so its height is what the scroll
    // container reserves above a focused field.
    expect(wrapper.find('.settings-pane-bar').exists()).toBe(true);
  });

  it('switches shape when the page is resized, and never stacks observers', async () => {
    const wrapper = await mountMeasured(300);
    expect(wrapper.find('#settings-group-select').exists()).toBe(true);
    // One **live** observer for both readings (§9.3): it is re-created on every
    // re-measure (that is how the original code re-attached to a new block), so
    // what "never stacks" means is that only one of them is watching anything —
    // and that it is watching the page's scroll root in the list state too, which
    // is what makes the width readable in all three states.
    const live = () => FakeResizeObserver.instances.filter((observer) => observer.observed.length > 0);
    expect(live()).toHaveLength(1);
    expect(live()[0].observed.some((element) => element.classList.contains('settings'))).toBe(true);

    pageWidth = 900;
    live()[0].trigger();
    await nextTick();

    expect(wrapper.find('#settings-group-select').exists()).toBe(false);
    expect(wrapper.find('[role="tablist"]').exists()).toBe(true);
    expect(live()).toHaveLength(1);
    // The current group survives the change of shape: the two shapes share one
    // state, so nothing becomes unreachable by resizing.
    expect(isVisible(paneFor(wrapper, 'general'))).toBe(true);
  });

  it('switches the visible group from either shape', async () => {
    const wide = await mountMeasured(900);
    await selectViaNav(wide, 'notifications');
    expect(isVisible(paneFor(wide, 'notifications'))).toBe(true);
    expect(isVisible(paneFor(wide, 'general'))).toBe(false);

    const narrow = await mountMeasured(300);
    await selectViaSelector(narrow, 'mcp');
    expect(isVisible(paneFor(narrow, 'mcp'))).toBe(true);
    expect(isVisible(paneFor(narrow, 'general'))).toBe(false);
  });
});

describe('Settings groups: the editors return to their group', () => {
  /**
   * The elements the page asked to focus. jsdom refuses focus on a container, so
   * the page's own decision is what is recorded — the same approach, and for the
   * same reason, as `Settings.instanceEditor.test.ts`.
   */
  let focusedElements: Element[] = [];
  let focusSpy: { mockRestore: () => void } | undefined;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  let nextFrameHandle = 0;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  async function flushFocusHandoff() {
    for (let step = 0; step < 4 && pendingFrames.size > 0; step += 1) {
      const frames = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const frame of frames) {
        await Promise.resolve();
        frame(0);
      }
      await nextTick();
    }
  }

  beforeEach(() => {
    focusedElements = [];
    const original = HTMLElement.prototype.focus;
    focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      ...args: unknown[]
    ) {
      focusedElements.push(this);
      (original as (...rest: unknown[]) => void).apply(this, args);
    }) as unknown as { mockRestore: () => void };
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    pendingFrames.clear();
    nextFrameHandle = 0;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      nextFrameHandle += 1;
      pendingFrames.set(nextFrameHandle, callback);
      return nextFrameHandle;
    };
    window.cancelAnimationFrame = (handle: number) => {
      pendingFrames.delete(handle);
    };
  });

  afterEach(() => {
    focusSpy?.mockRestore();
    pendingFrames.clear();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('returns the instance editor to 实例 with focus on the row it came from', async () => {
    // Attached: the focus handoff refuses a detached element (that is what keeps
    // it from focusing a control off screen), so a detached mount would look like
    // "no focus was ever asked for".
    const wrapper = await mountMeasured(900, { attach: true });
    await selectViaNav(wrapper, 'instances');

    const row = wrapper.findAll('.saved-item')[1];
    const editButton = row.find('vscode-button');
    await editButton.trigger('click');
    await nextTick();

    // The editor is a state of the page, not a group: the navigation is not on
    // screen while it is open, so the group cannot be changed under it.
    expect(wrapper.find('.instance-editor').exists()).toBe(true);
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);

    await wrapper.find('.editor-band-back').trigger('click');
    await nextTick();
    await flushFocusHandoff();

    // Back in the group it was opened from, with focus handed to that row's own
    // control — the two halves of §9.4 rule 3, which have to be one move: focus
    // landing on a control inside a hidden pane is a dead end.
    expect(wrapper.find('.instance-editor').exists()).toBe(false);
    expect(isVisible(paneFor(wrapper, 'instances'))).toBe(true);
    // Re-queried, not the element captured before the editor opened: leaving the
    // editor re-creates the list's DOM, so the button that takes focus is a new
    // element carrying the same row identity.
    const returnedTo = wrapper.findAll('.saved-item')[1].find('vscode-button').element;
    expect(focusedElements.map((element) => (element as HTMLElement).outerHTML)).toContain(
      (returnedTo as HTMLElement).outerHTML,
    );
    expect(isVisible(paneFor(wrapper, 'general'))).toBe(false);
    wrapper.unmount();
  });

  it('returns the endpoint editor to the AI group with focus on Add Endpoint', async () => {
    const wrapper = await mountMeasured(900, { attach: true });
    await selectViaNav(wrapper, 'ai');

    const addEndpoint = wrapper.findAll('vscode-button').find((button) => button.text().trim() === 'Add Endpoint');
    expect(addEndpoint, 'the Add Endpoint control').toBeTruthy();
    await addEndpoint!.trigger('click');
    await nextTick();

    expect(wrapper.find('.instance-editor').exists()).toBe(true);
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);

    await wrapper.find('.editor-band-back').trigger('click');
    await nextTick();
    await flushFocusHandoff();

    expect(wrapper.find('.instance-editor').exists()).toBe(false);
    expect(isVisible(paneFor(wrapper, 'ai'))).toBe(true);
    const returnedTo = wrapper.findAll('vscode-button').find((button) => button.text().trim() === 'Add Endpoint');
    expect(focusedElements.map((element) => (element as HTMLElement).outerHTML)).toContain(
      (returnedTo!.element as HTMLElement).outerHTML,
    );
    wrapper.unmount();
  });
});
