import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The two editor headings, as one **identity band**
 * (`docs/design/settings-page.md` §3.4).
 *
 * What was wrong with the block the maintainer photographed: the reading order
 * was title → name → address → "back to the list", so the way out sat *after*
 * the information, and the copy control floated at the far right of the row,
 * disconnected from the address it copies. The fix is a band with three lines in
 * the order they are read, and it has to hold for **both** editor states: they
 * share the markup, and two different-looking headings in one page would be
 * worse than either shape on its own.
 *
 * What this file pins:
 *
 * 1. **The return control is line one, and it comes first in the heading's own
 *    DOM order** — before the title and before the identity — in both editors.
 * 2. **Line two is the title**, in the page's `h2` style, and there is still
 *    exactly one heading element per editor.
 * 3. **Line three is the identity**: the name, then the address in monospace,
 *    with the copy control **immediately beside the address it copies** — not a
 *    second copy control somewhere else, and not a control at the far end of the
 *    row.
 * 4. **Both editors share all three lines** — same classes, same order — so the
 *    structure cannot drift apart one editor at a time.
 * 5. **Both leave paths ask the same question and declining drops nothing**; the
 *    editors' `Cancel Edit` / `Cancel` go through the same functions the band's
 *    return control does, so there is no second confirmation path.
 * 6. **Leaving returns focus to the row's own Edit button** — the handoff the
 *    page already had, unchanged by the restyle.
 * 7. **The return control is a real button with an accessible name and a
 *    tooltip**, and the codicon inside it is decorative rather than a second
 *    name.
 *
 * The narrow-width half of "the buttons do not wrap" is a stylesheet property
 * (jsdom computes no cascade and lays nothing out), so it is pinned in
 * `Settings.instanceEditorLayout.test.ts` beside the band's other CSS rules;
 * what this file can confirm is the markup those rules apply to.
 */

const INSTANCE_A = { id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha' };
const INSTANCE_B = { id: 'inst-b', name: 'Beta', url: 'https://forgejo.example.com/beta' };

const ENTRY = {
  id: 'ollama-local',
  name: 'Ollama (this machine)',
  baseUrl: 'http://localhost:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  auth: 'bearer' as const,
  headers: [],
  keySet: true,
  address: 'http://localhost:11434/v1',
  insecure: true,
};

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
    testAiProvider: vi.fn(async () => ({
      providerId: '',
      providerName: '',
      address: '',
      ok: true,
      ran: true,
      shadowed: [],
    })),
    setAiModelPolicy: vi.fn(async () => ({ transport: 'auto' as const, requestTimeoutMs: 30_000 })),
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

// The host's reading of the settings page's own surface (§3.2): the manifest's
// defaults with the whole source map. It is built here rather than in the
// `vi.hoisted` body above because that body runs before this import exists.
stateMock.settingsSurface.value = settingsSurfaceFixture();

function endpointSnapshot() {
  return {
    providers: [{ ...ENTRY }],
    rejected: [],
    transport: 'auto' as const,
    requestTimeoutMs: 30_000,
    defaultModel: { providerId: '', modelId: '' },
    bindings: [],
    features: ['aiPreReview'],
    selection: 'none' as const,
    capability: { available: true },
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
 * view's own decision is recorded rather than `document.activeElement`.
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
  stateMock.aiProviderSettings.value = undefined;
  stateMock.showConfirm.mockImplementation(async () => true);
  snapshot.current = undefined;

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

/** A `vscode-button` by its visible label, wherever it is. */
function buttonByLabel(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(found, `button "${label}"`).toBeTruthy();
  return found!;
}

/** The editor's identity band, which is no longer the whole `.instance-editor`. */
function band(wrapper: VueWrapper) {
  const heading = wrapper.find('.editor-heading');
  expect(heading.exists(), 'the identity band').toBe(true);
  return heading;
}

/** The band's lines, in DOM order, by the class that identifies each one. */
function bandLines(wrapper: VueWrapper): string[] {
  const html = band(wrapper).element;
  return [...html.children].map((child) => {
    if (child.classList.contains('editor-band-back')) return 'back';
    if (child.tagName === 'H2') return 'title';
    if (child.classList.contains('editor-identity')) return 'identity';
    return `?${child.className}`;
  });
}

/** Opens the instance editor the way the user does: through that row's Edit button. */
async function openInstanceEditor(wrapper: VueWrapper, index: number) {
  const row = wrapper.findAll('.saved-item')[index];
  expect(row, `saved instance ${index}`).toBeTruthy();
  await row.find('vscode-button').trigger('click');
  await nextTick();
}

/** Opens the endpoint editor from its row's Edit button. */
async function openEndpointEditor(wrapper: VueWrapper) {
  const row = wrapper.findAll('.saved-item')[0];
  expect(row, 'the endpoint row').toBeTruthy();
  const edit = row!.findAll('vscode-button').find((entry) => entry.text().trim() === 'Edit');
  expect(edit, "the endpoint row's Edit button").toBeTruthy();
  await edit!.trigger('click');
  await flushPromises();
}

function backControl(wrapper: VueWrapper) {
  const back = band(wrapper).find('.editor-band-back');
  expect(back.exists(), "the band's return control").toBe(true);
  return back;
}

describe('Settings editor identity band: the three lines', () => {
  it('reads back, title, identity — in that order — in the instance editor', async () => {
    const wrapper = mountView();
    await nextTick();
    await openInstanceEditor(wrapper, 0);

    // The way out is stated first, before the identity: it is where a reader who
    // opened the wrong row looks, and it is the whole reason this restyle exists.
    expect(bandLines(wrapper)).toEqual(['back', 'title', 'identity']);

    // Then the title, in the page's `h2` style, and it is still the editor's only
    // heading — the band is the heading block, not a second strip.
    const title = band(wrapper).find('h2');
    expect(title.text()).toBe('Edit Instance');
    expect(title.classes()).toContain('editor-title');
    expect(wrapper.find('.instance-editor').findAll('h1, h2, h3, h4, h5, h6')).toHaveLength(1);

    // Then the identity: the name, then the address.
    const identity = band(wrapper).find('.editor-identity');
    expect(identity.find('.editor-identity-name').text()).toBe(INSTANCE_A.name);
    expect(identity.find('.editor-identity-url').text()).toBe(INSTANCE_A.url);

    wrapper.unmount();
  });

  it('puts the copy control immediately beside the address it copies', async () => {
    const wrapper = mountView();
    await nextTick();
    await openInstanceEditor(wrapper, 0);

    // One copy control for the band, and it is the next thing after the address
    // inside the same group — the floating far-right button is gone rather than
    // duplicated.
    const heading = band(wrapper);
    expect(heading.findAll('.editor-copy-url')).toHaveLength(1);
    const group = heading.find('.editor-identity-url-group');
    expect([...group.element.children].map((child) => child.className.split(' ')[0])).toEqual([
      'editor-identity-url',
      'editor-copy-url',
    ]);

    // …and it copies the value it sits beside.
    await heading.find('.editor-copy-url').trigger('click');
    expect(stateMock.copyToClipboard).toHaveBeenCalledWith(INSTANCE_A.url);

    wrapper.unmount();
  });

  it('gives the return control an accessible name, a tooltip and a decorative icon', async () => {
    const wrapper = mountView();
    await nextTick();
    await openInstanceEditor(wrapper, 0);

    const back = backControl(wrapper);
    // A real `<button>` in the light DOM: Enter and Space activate it without a
    // pointer, which is the contract the previous text link kept.
    expect(back.element.tagName).toBe('BUTTON');
    expect(back.attributes('type')).toBe('button');
    // The visible label is the accessible name, and the tooltip says what the
    // control does beyond its label.
    expect(back.text()).toBe('Back to instance list');
    expect(back.attributes('title')).toBe('Leave this editor and return to the instance list');
    // The icon is decoration: it carries no text and is hidden from assistive
    // technology rather than announced as part of the name.
    const icon = back.find('i.codicon-arrow-left');
    expect(icon.exists(), 'the codicon').toBe(true);
    expect(icon.attributes('aria-hidden')).toBe('true');

    wrapper.unmount();
  });

  it('builds the endpoint editor from the same three lines', async () => {
    snapshot.current = endpointSnapshot();
    stateMock.aiProviderSettings.value = endpointSnapshot();

    const wrapper = mountView();
    await flushPromises();
    await openEndpointEditor(wrapper);

    // Same structure, element for element and order for order.
    expect(bandLines(wrapper)).toEqual(['back', 'title', 'identity']);
    expect(band(wrapper).find('h2').text()).toBe('Edit AI Endpoint');
    const identity = band(wrapper).find('.editor-identity');
    expect(identity.find('.editor-identity-name').text()).toBe(ENTRY.name);
    expect(identity.find('.editor-identity-url').text()).toBe(ENTRY.address);
    // …including the copy control beside the address, and the endpoint's own
    // tooltip on its return control.
    const group = identity.find('.editor-identity-url-group');
    expect([...group.element.children].map((child) => child.className.split(' ')[0])).toEqual([
      'editor-identity-url',
      'editor-copy-url',
    ]);
    expect(backControl(wrapper).text()).toBe('Back to the endpoint list');
    expect(backControl(wrapper).attributes('title')).toBe('Leave this editor and return to the endpoint list');

    wrapper.unmount();
  });

  it('keeps the band’s shape when the endpoint editor has no address to name', async () => {
    // The "add endpoint" mode has no record: the first two lines stay, and the
    // identity line is absent rather than empty — an empty line would still take
    // the band's gap.
    const wrapper = mountView();
    await flushPromises();

    await buttonByLabel(wrapper, 'Add Endpoint').trigger('click');
    await flushPromises();

    expect(bandLines(wrapper)).toEqual(['back', 'title']);
    expect(band(wrapper).find('.editor-identity').exists()).toBe(false);
    expect(backControl(wrapper).text()).toBe('Back to the endpoint list');

    wrapper.unmount();
  });
});

describe('Settings editor identity band: the two ways out', () => {
  it('asks the same question from the band and from Cancel Edit, and declining keeps the form', async () => {
    const wrapper = mountView();
    await nextTick();
    await openInstanceEditor(wrapper, 0);
    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/alpha-edited');

    // Declined from the band: the question is the page's one discard sentence,
    // and nothing on the form is dropped.
    stateMock.showConfirm.mockImplementation(async () => false);
    await backControl(wrapper).trigger('click');
    await nextTick();

    expect(stateMock.showConfirm).toHaveBeenCalledTimes(1);
    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(band(wrapper).exists()).toBe(true);
    expect(fieldValue(wrapper, '#forgejo-url')).toBe('https://forgejo.example.com/alpha-edited');
    expect(stateMock.saveInstance).not.toHaveBeenCalled();

    // Cancelled from `Cancel Edit`: the same question, asked once.
    stateMock.showConfirm.mockClear();
    await buttonByLabel(wrapper, 'Cancel Edit').trigger('click');
    await nextTick();
    expect(stateMock.showConfirm).toHaveBeenCalledTimes(1);
    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(band(wrapper).exists()).toBe(true);

    // Accepted: the one way out actually leaves, and saves nothing.
    stateMock.showConfirm.mockClear();
    stateMock.showConfirm.mockImplementation(async () => true);
    await buttonByLabel(wrapper, 'Cancel Edit').trigger('click');
    await nextTick();
    expect(wrapper.find('.settings-list').exists()).toBe(true);
    expect(stateMock.saveInstance).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('takes both leave paths through one guard in the endpoint editor too', async () => {
    snapshot.current = endpointSnapshot();
    stateMock.aiProviderSettings.value = endpointSnapshot();

    const wrapper = mountView();
    await flushPromises();
    await openEndpointEditor(wrapper);
    await typeInto(wrapper, '#ai-provider-name', 'Ollama renamed');

    stateMock.showConfirm.mockImplementation(async () => false);
    await backControl(wrapper).trigger('click');
    await nextTick();

    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(band(wrapper).exists()).toBe(true);
    expect(fieldValue(wrapper, '#ai-provider-name')).toBe('Ollama renamed');
    expect(stateMock.saveAiProvider).not.toHaveBeenCalled();

    // The footer's Cancel is the same function, so it cannot be a second, silent
    // way to lose the typed draft.
    stateMock.showConfirm.mockClear();
    await buttonByLabel(wrapper, 'Cancel').trigger('click');
    await nextTick();
    expect(stateMock.showConfirm).toHaveBeenCalledTimes(1);
    expect(band(wrapper).exists()).toBe(true);

    wrapper.unmount();
  });

  it('gives focus back to the row’s Edit button when the band is used to leave', async () => {
    const wrapper = mountView();
    await nextTick();
    await openInstanceEditor(wrapper, 1);

    focusedElements.length = 0;
    await backControl(wrapper).trigger('click');
    await nextTick();
    await flushFocusHandoff();

    // The same handoff the page already had: the row the editor was opened from,
    // re-queried because leaving re-creates the list's DOM.
    const returnedTo = wrapper.findAll('.saved-item')[1].find('vscode-button').element;
    expect((returnedTo as HTMLElement).textContent?.trim()).toBe('Edit Instance');
    expect(focusedElements.map((element) => (element as HTMLElement).outerHTML)).toContain(
      (returnedTo as HTMLElement).outerHTML,
    );
    expect(focusedElements).not.toContain(buttonByLabel(wrapper, 'Add Instance').element);

    wrapper.unmount();
  });

  it('keeps the footer’s save and cancel controls in both editors', async () => {
    // The maintainer asked for both, explicitly: the band's way out does not
    // replace the footer's pair.
    const wrapper = mountView();
    await nextTick();
    await openInstanceEditor(wrapper, 0);
    for (const label of ['Test Connection', 'Update Instance', 'Cancel Edit']) {
      expect(buttonByLabel(wrapper, label).text(), label).toBe(label);
    }
    wrapper.unmount();

    snapshot.current = endpointSnapshot();
    stateMock.aiProviderSettings.value = endpointSnapshot();
    const endpoints = mountView();
    await flushPromises();
    await openEndpointEditor(endpoints);
    for (const label of ['Test connection', 'Save endpoint', 'Cancel']) {
      expect(buttonByLabel(endpoints, label).text(), label).toBe(label);
    }
    endpoints.unmount();
  });
});

describe('Settings editor identity band: the band’s own strings', () => {
  /**
   * The band's strings live in the webview catalogs like every other label
   * (`AGENTS.md`, i18n / webview strings), and both languages carry them. The
   * English source is what the rest of this file asserts, so this case mounts in
   * `zh` and checks the Chinese one: a key present in only one catalog resolves
   * through the English fallback and reads as an untranslated label in a Chinese
   * window.
   */
  it('names the way out, its tooltip and the copy control in Chinese as well', async () => {
    const wrapper = mount(Settings, {
      global: {
        plugins: [createTestRouter(), createTestI18n('zh')],
        stubs: { ModalDialog: true, TokenScopeList: true },
      },
    });
    await nextTick();
    await openInstanceEditor(wrapper, 0);

    const back = backControl(wrapper);
    expect(back.text()).toBe('返回实例列表');
    expect(back.attributes('title')).toBe('离开这个编辑器并回到实例列表');
    expect(band(wrapper).find('.editor-copy-url').attributes('aria-label')).toBe('复制实例地址');

    wrapper.unmount();
  });
});

/** Types into a `vscode-textfield` and lets the view see it. */
async function typeInto(wrapper: VueWrapper, selector: string, value: string): Promise<void> {
  const field = wrapper.find(selector);
  expect(field.exists(), selector).toBe(true);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
  await nextTick();
}

function fieldValue(wrapper: VueWrapper, selector: string): string {
  const field = wrapper.find(selector);
  const property = (field.element as unknown as { value?: string }).value;
  if (property !== undefined) {
    return String(property);
  }
  return field.attributes('value') ?? '';
}
