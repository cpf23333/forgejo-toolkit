import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The import preview's way back (`docs/design/settings-page.md` §9.4 rule 3, §10.6).
 *
 * The preview used to be a route in the sidebar application, so leaving it was a
 * navigation. It is rendered **in place** now, inside the settings tab: it covers
 * the page, and the only exits were its own two footer buttons — Import, which
 * completes it, and Cancel, which is the last thing in a long list. A reader who
 * opened the wrong file had no return path, and nothing put them back where they
 * started.
 *
 * What this file pins is that the page now offers one, and that it is the same
 * path the page's two editor states already offer:
 *
 * 1. **It is in the preview's own heading area, above the list**, drawn by the page
 *    through the preview's `return-path` slot — the place the two editors state
 *    their return path first.
 * 2. **It returns to the group the reader came from**, with focus handed back to
 *    the Import button that opened the preview. The group is structural, exactly
 *    as it is for the editors: nothing writes `currentGroup` while the preview is
 *    on screen.
 * 3. **It asks before throwing the reader's choices away** and keeps the preview
 *    when they decline — the same `common.discardChangesConfirm` question, and the
 *    same "only when there is something to lose" rule the editors' `formDirty`
 *    follows. The preview's own Cancel goes through that same question, exactly as
 *    `Cancel Edit` goes through `requestCloseEditor`.
 * 4. **A successful import lands in the list state**, in the same group, with the
 *    outcome reported there, and does not navigate anywhere: the preview's
 *    `state.importPreview` is cleared and the page the user was already on comes
 *    back. The graph half of "no navigation" is `src/__tests__/entryGraph.test.ts`
 *    (the tab's surface installs and reaches no `vue-router`).
 * 5. **Escape is left alone.** The page binds no Escape handler for either editor
 *    (`Settings.vue`'s only `keydown` is the group tablist's own keyboard model),
 *    so a return path that answered Escape would be a second, invented behaviour
 *    rather than the page's. The test states the check so that the two move
 *    together if an editor ever gains it.
 *
 * jsdom lays nothing out, so the page measures a width of zero here and renders the
 * narrow shape with the group selector: the group is chosen through it, and the
 * assertions are about state, focus and text, none of which need layout.
 */

const INSTANCE_A = { id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha' };
const INSTANCE_B = { id: 'inst-b', name: 'Beta', url: 'https://forgejo.example.com/beta' };

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined as unknown },
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
    importInstancesResult: { value: undefined as unknown },
    testConnection: vi.fn(),
    saveInstance: vi.fn(),
    editInstance: vi.fn(),
    removeInstance: vi.fn(),
    openExternal: vi.fn(),
    copyToClipboard: vi.fn(),
    // The import trio the settings page drives: the request, the confirmation with
    // the reader's selection, and the cancel that drops the host's stash.
    previewImportInstances: vi.fn(),
    confirmImportInstances: vi.fn(),
    cancelImportInstances: vi.fn(),
    exportInstances: vi.fn(),
    copyInstancesToClipboard: vi.fn(),
    loadAiPreReviewChatModels: vi.fn(async () => ({ models: [], configured: '' })),
    saveAiPreReviewChatModel: vi.fn(async (value: string) => ({ value })),
    // Filled in after the imports below: a `vi.hoisted` body runs before this
    // file's imports are initialized, so the complete, typed reading — source map
    // included — can only be built once `settingsSurfaceFixture` exists.
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

/**
 * The proxy the view itself reads. Mutating `stateMock` directly is not always
 * enough to notify the view's watchers, so the host replies are published through
 * the same object the component holds (the pattern `Settings.instanceEditor.test.ts`
 * uses).
 */
const state = useAppState() as unknown as {
  importPreview: { value: unknown };
  importInstancesResult: { value: unknown };
};

/** The preview the host answers `previewImportInstances` with. */
function publishPreview(preview: Record<string, unknown> = {}) {
  state.importPreview.value = {
    instances: [{ ...INSTANCE_A }, { ...INSTANCE_B }],
    existingIds: [],
    ...preview,
  };
}

function mountView() {
  return mount(Settings, {
    attachTo: document.body,
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

/**
 * The elements the view asked to focus, in order (see
 * `Settings.instanceEditor.test.ts`): jsdom refuses focus on a container, so the
 * view's own decision is what is recorded rather than `document.activeElement`.
 */
let focusedElements: Element[] = [];
let focusSpy: { mockRestore: () => void } | undefined;

/**
 * The frame queue the page's deferred focus handoff runs on. jsdom implements
 * `requestAnimationFrame` only when it pretends to be visual, which this
 * environment is not, so the page would fall back to a timer; a queue the test
 * drains by hand is both closer to the real runtime and deterministic.
 */
const pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 0;
let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

async function flushFocusHandoff(): Promise<void> {
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
  vi.clearAllMocks();
  stateMock.instances.value = [{ ...INSTANCE_A }, { ...INSTANCE_B }];
  stateMock.importPreview.value = undefined;
  stateMock.importInstancesResult.value = undefined;
  stateMock.showConfirm.mockImplementation(async () => true);

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

function buttonByLabel(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  return button!;
}

function paneFor(wrapper: VueWrapper, group: string) {
  const pane = wrapper.find(`#settings-group-panel-${group}`);
  expect(pane.exists(), `the pane of ${group}`).toBe(true);
  return pane;
}

/** Whether one group is the one on screen (`hidden` + `inert`, see §9.4 rule 1). */
function isVisible(pane: ReturnType<typeof paneFor>): boolean {
  const element = pane.element as HTMLElement;
  return !element.hasAttribute('hidden') && !element.hasAttribute('inert');
}

/** Shows one group through the narrow shape's selector. */
async function selectGroup(wrapper: VueWrapper, group: string) {
  const select = wrapper.find('#settings-group-select');
  expect(select.exists(), 'the narrow group selector').toBe(true);
  (select.element as unknown as { value: string }).value = group;
  await select.trigger('change');
  await nextTick();
}

/** The page's import entry, the control the preview must return focus to. */
function importButton(wrapper: VueWrapper) {
  return buttonByLabel(wrapper, 'Import');
}

/**
 * Opens the preview the way the reader does: the Import button asks the host for a
 * preview, and the host's reply is what puts it on screen.
 */
async function openPreview(wrapper: VueWrapper, preview: Record<string, unknown> = {}) {
  await importButton(wrapper).trigger('click');
  await nextTick();
  publishPreview(preview);
  await nextTick();
  expect(wrapper.find('.import-preview').exists(), 'the preview is on screen').toBe(true);
}

function backControl(wrapper: VueWrapper) {
  const back = wrapper.find('.import-preview-header .import-preview-back');
  expect(back.exists(), 'the preview return control').toBe(true);
  return back;
}

describe('Settings: the import preview returns to where it was opened from', () => {
  it('draws the return path in the preview’s heading, above the list', async () => {
    const wrapper = mountView();
    await nextTick();
    await selectGroup(wrapper, 'instances');
    await openPreview(wrapper);

    const back = backControl(wrapper);
    // The label is the page's own key, in both catalogs (`en.json`/`zh.json`), and
    // it names the destination the way the two editors' do.
    expect(back.text()).toBe('Back to the instance list');
    // A real `<button>`, so Enter and Space activate it without a pointer — the
    // same contract the editors' return path keeps.
    expect(back.element.tagName).toBe('BUTTON');
    expect(back.attributes('type')).toBe('button');
    // It is stated before the list, in the heading: the first thing a reader who
    // opened the wrong file looks for.
    const heading = wrapper.find('.import-preview-header');
    expect(heading.find('.import-preview-back').exists()).toBe(true);
    expect(heading.element.compareDocumentPosition(wrapper.find('.import-preview-body').element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    wrapper.unmount();
  });

  it('returns to the instances group with focus back on the Import button', async () => {
    const wrapper = mountView();
    await nextTick();
    await selectGroup(wrapper, 'instances');
    await openPreview(wrapper);

    // The preview covers the whole page: the list state, its panes and the group
    // navigation are not rendered at all while it is open.
    expect(wrapper.find('.settings-list').exists()).toBe(false);
    expect(wrapper.find('.settings-pane').exists()).toBe(false);

    focusedElements.length = 0;
    await backControl(wrapper).trigger('click');
    await nextTick();
    await flushFocusHandoff();

    // The page is back, in the group the preview was opened from — not on the
    // default group, which is where a plain "leave" would land.
    expect(wrapper.find('.import-preview').exists()).toBe(false);
    expect(wrapper.find('.settings-list').exists()).toBe(true);
    expect(isVisible(paneFor(wrapper, 'instances'))).toBe(true);
    expect(isVisible(paneFor(wrapper, 'general'))).toBe(false);
    // Leaving drops the host's stash of the file: no preview is on screen to
    // confirm it from, and the entries it holds carry tokens.
    expect(stateMock.cancelImportInstances).toHaveBeenCalledTimes(1);
    // Focus goes to the control that opened the preview, re-queried because
    // leaving re-creates the list's DOM — and not to the section's Add Instance,
    // which is the fallback a missing return target would land on.
    const returnedTo = importButton(wrapper).element as HTMLElement;
    expect(focusedElements.map((element) => (element as HTMLElement).outerHTML)).toContain(returnedTo.outerHTML);
    expect(focusedElements).not.toContain(buttonByLabel(wrapper, 'Add Instance').element);
    wrapper.unmount();
  });

  it('leaves the same way from the preview’s own Cancel', async () => {
    // One exit, wherever it is asked from: the component's footer button reaches
    // the page's guard through the preview's `requestLeave` prop, so Cancel is not
    // a second, silent way to lose the reader's choices.
    const wrapper = mountView();
    await nextTick();
    await selectGroup(wrapper, 'instances');
    await openPreview(wrapper);
    await buttonByLabel(wrapper, 'Deselect all').trigger('click');
    await nextTick();

    focusedElements.length = 0;
    stateMock.showConfirm.mockImplementation(async () => false);
    await buttonByLabel(wrapper, 'Cancel').trigger('click');
    await nextTick();
    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(wrapper.find('.import-preview').exists()).toBe(true);
    expect(stateMock.cancelImportInstances).not.toHaveBeenCalled();

    stateMock.showConfirm.mockImplementation(async () => true);
    await buttonByLabel(wrapper, 'Cancel').trigger('click');
    await nextTick();
    await flushFocusHandoff();

    expect(wrapper.find('.import-preview').exists()).toBe(false);
    expect(isVisible(paneFor(wrapper, 'instances'))).toBe(true);
    expect(stateMock.cancelImportInstances).toHaveBeenCalledTimes(1);
    const returnedTo = importButton(wrapper).element as HTMLElement;
    expect(focusedElements.map((element) => (element as HTMLElement).outerHTML)).toContain(returnedTo.outerHTML);
    wrapper.unmount();
  });

  it('asks before discarding a choice the reader made, and stays when declined', async () => {
    const wrapper = mountView();
    await nextTick();
    await selectGroup(wrapper, 'instances');
    await openPreview(wrapper);

    // The reader changes what will be imported: the arriving state is "everything
    // selected", so deselecting is a choice this preview would lose.
    await buttonByLabel(wrapper, 'Deselect all').trigger('click');
    await nextTick();

    stateMock.showConfirm.mockImplementation(async () => false);
    await backControl(wrapper).trigger('click');
    await nextTick();

    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    // Declined: the preview is untouched and nothing was dropped host-side.
    expect(wrapper.find('.import-preview').exists()).toBe(true);
    expect(stateMock.cancelImportInstances).not.toHaveBeenCalled();

    stateMock.showConfirm.mockImplementation(async () => true);
    await backControl(wrapper).trigger('click');
    await nextTick();

    expect(wrapper.find('.import-preview').exists()).toBe(false);
    expect(stateMock.cancelImportInstances).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('leaves without asking when the reader has not chosen anything', async () => {
    const wrapper = mountView();
    await nextTick();
    await selectGroup(wrapper, 'instances');
    await openPreview(wrapper);

    // Untouched: every instance is selected and every conflict answer is still the
    // one that changes nothing, so there is nothing to ask about (the same rule as
    // the editors' `formDirty`).
    await backControl(wrapper).trigger('click');
    await nextTick();

    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    expect(wrapper.find('.import-preview').exists()).toBe(false);
    expect(wrapper.find('.settings-list').exists()).toBe(true);
    wrapper.unmount();
  });

  it('counts an answered endpoint conflict as a choice worth asking about', async () => {
    // The second half of the preview's `dirty`: leaving with an endpoint whose
    // conflict was answered `replace` would apply nothing, and the answer is the
    // reader's, not a default.
    const wrapper = mountView();
    await nextTick();
    await selectGroup(wrapper, 'instances');
    await openPreview(wrapper, {
      ai: {
        providers: [
          {
            id: 'ollama-local',
            name: 'Ollama (this machine)',
            baseUrl: 'http://localhost:11434/v1',
            auth: 'bearer',
            models: ['qwen3:8b'],
            headers: [],
            existing: true,
          },
        ],
        bindings: [],
        transport: 'auto',
        secretsIncluded: false,
      },
    });

    const conflict = wrapper.find('#ai-conflict-ollama-local');
    expect(conflict.exists(), 'the conflict question').toBe(true);
    (conflict.element as unknown as { value: string }).value = 'replace';
    await conflict.trigger('change');
    await nextTick();

    stateMock.showConfirm.mockImplementation(async () => false);
    await backControl(wrapper).trigger('click');
    await nextTick();

    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(wrapper.find('.import-preview').exists()).toBe(true);
    wrapper.unmount();
  });

  it('lands in the instances list after a successful import, without navigating', async () => {
    const wrapper = mountView();
    await nextTick();
    await selectGroup(wrapper, 'instances');
    await openPreview(wrapper);

    focusedElements.length = 0;
    await buttonByLabel(wrapper, 'Import selected (2)').trigger('click');
    await nextTick();

    // The confirmation carries the reader's selection (§10.6's in-place preview);
    // the host rehydrates the entries from its own stash, so no file is picked
    // again and the stash is not cancelled — the import consumed it.
    expect(stateMock.confirmImportInstances).toHaveBeenCalledWith(['inst-a', 'inst-b'], undefined, {});

    // The list state, in the group the preview was opened from.
    expect(wrapper.find('.import-preview').exists()).toBe(false);
    expect(wrapper.find('.settings-list').exists()).toBe(true);
    expect(isVisible(paneFor(wrapper, 'instances'))).toBe(true);
    expect(stateMock.cancelImportInstances).not.toHaveBeenCalled();

    await flushFocusHandoff();
    const returnedTo = importButton(wrapper).element as HTMLElement;
    expect(focusedElements.map((element) => (element as HTMLElement).outerHTML)).toContain(returnedTo.outerHTML);

    // The host's outcome is reported in the list it happened in, and the page is
    // still the tab's page: nothing pushed a route, because this surface has none.
    state.importInstancesResult.value = { success: true, count: 2 };
    await nextTick();
    expect(wrapper.text()).toContain('Imported 2 instance(s)');
    expect(wrapper.find('.settings').exists()).toBe(true);
    expect(wrapper.find('.import-preview').exists()).toBe(false);
    expect(isVisible(paneFor(wrapper, 'instances'))).toBe(true);
    wrapper.unmount();
  });

  it('leaves Escape to the editors’ own discipline, which binds no Escape handler', async () => {
    // The check behind this test: `Settings.vue`'s only keydown binding is the wide
    // group tablist's arrow/Home/End model, and neither editor closes on Escape. A
    // new return path that answered Escape would be inventing behaviour rather than
    // matching the page's; if the editors ever gain one, this test is where the two
    // move together.
    const wrapper = mountView();
    await nextTick();
    await selectGroup(wrapper, 'instances');
    await openPreview(wrapper);

    await wrapper.find('.import-preview').trigger('keydown', { key: 'Escape' });
    await nextTick();

    expect(wrapper.find('.import-preview').exists()).toBe(true);
    expect(stateMock.cancelImportInstances).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
