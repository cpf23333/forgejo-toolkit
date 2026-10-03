import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const INSTANCE_A = {
  id: 'inst-a',
  name: 'Alpha',
  url: 'https://forgejo.example.com/alpha',
  declaredServerVersion: '16.0.2',
};
const INSTANCE_B = { id: 'inst-b', name: 'Beta', url: 'https://forgejo.example.com/beta' };

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
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
    // The editor's discard prompt, a pure UI-state confirmation.
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
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * The proxy the view itself reads. Mutating `stateMock` directly is not always
 * enough to notify the view's watchers, so the replies are published through the
 * same object the component holds (see the same pattern in
 * `Settings.saveInstanceTarget.test.ts`).
 */
const state = useAppState() as unknown as {
  saveInstanceResult: { value: unknown };
  testConnectionResult: { value: unknown };
};

function mountView(options: { attach?: boolean } = {}) {
  return mount(Settings, {
    ...(options.attach ? { attachTo: document.body } : {}),
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

/**
 * Settles the focus handoff the view defers to the next frame: the frame
 * callbacks are the part that runs before the move is attempted, and the extra
 * `nextTick` covers a retry the first frame schedules.
 */
async function flushFocusHandoff() {
  await nextTick();
  await runAnimationFrames();
  await nextTick();
}

function buttonByLabel(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  return button!;
}

async function clickButton(wrapper: VueWrapper, label: string) {
  await buttonByLabel(wrapper, label).trigger('click');
  await nextTick();
}

/** The editor's return path, which is a text link rather than a `vscode-button`. */
async function clickBack(wrapper: VueWrapper) {
  const back = wrapper.find('.editor-back');
  expect(back.exists(), 'editor back link').toBe(true);
  await back.trigger('click');
  await nextTick();
}

/** Opens a row's editor the way the user does: through that row's Edit button. */
async function clickEdit(wrapper: VueWrapper, index: number) {
  const item = wrapper.findAll('.saved-item')[index];
  expect(item, `saved instance ${index}`).toBeTruthy();
  await item.find('vscode-button').trigger('click');
  await nextTick();
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string) {
  const field = wrapper.find(selector);
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

const editor = (wrapper: VueWrapper) => wrapper.find('.instance-editor');
const list = (wrapper: VueWrapper) => wrapper.find('.settings-list');

/**
 * The elements the view asked to focus, in order.
 *
 * The focus *handoff* is the behaviour under test — which element the open and
 * the close move focus to — and asserting it on `document.activeElement` does
 * not work in this environment: jsdom refuses focus on a container, so every
 * state transition would look like "focus went to the body". Recording the calls
 * keeps the assertion on the view's own decision.
 *
 * A `vscode-button` is itself the focusable control (`tabIndex = 0`, no shadow
 * root and `role="button"` on the host), so the recorded element for a list
 * control is the host element.
 */
let focusedElements: Element[] = [];
let focusSpy: { mockRestore: () => void } | undefined;

/**
 * The frame queue the view's deferred focus handoff runs on.
 *
 * jsdom implements `requestAnimationFrame` only when it is asked to pretend to
 * be visual, and the webview test environment is not, so the view would fall
 * back to a timer. A queue the test drains by hand is both closer to the real
 * runtime (a frame, not a tick) and deterministic; `runAnimationFrames` also
 * runs the frames a retry schedules off a previous frame.
 */
const pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 0;
let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

async function runAnimationFrames(limit = 4): Promise<void> {
  for (let step = 0; step < limit && pendingFrames.size > 0; step += 1) {
    const frames = [...pendingFrames.values()];
    pendingFrames.clear();
    for (const frame of frames) {
      await Promise.resolve();
      frame(0);
    }
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
    (original as (...focusArgs: unknown[]) => void).apply(this, args);
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

/**
 * The instance editor is a state of the Settings surface, not a form inside the
 * list: opening a row's Edit (or Add Instance) replaces the list with the
 * editor, and closing it puts the list back. These tests pin the two properties
 * the restructure exists for — the editor says which instance it is editing, and
 * the list is never on screen beside its fields.
 */
describe('Settings instance editor is a state of its own', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.instances.value = [{ ...INSTANCE_A }, { ...INSTANCE_B }];
    stateMock.saveInstanceResult.value = undefined;
    stateMock.testConnectionResult.value = undefined;
    stateMock.showConfirm.mockImplementation(async () => true);
  });

  it('starts on the list, with no instance fields anywhere', async () => {
    const wrapper = mountView();
    await nextTick();

    expect(list(wrapper).exists()).toBe(true);
    expect(editor(wrapper).exists()).toBe(false);
    expect(wrapper.find('#forgejo-url').exists()).toBe(false);
    // The list's own way in is there instead.
    expect(buttonByLabel(wrapper, 'Add Instance')).toBeTruthy();
    wrapper.unmount();
  });

  it('replaces the list with the editor and names the instance it is editing', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);

    // The list is gone: its rows cannot be mistaken for the fields below.
    expect(list(wrapper).exists()).toBe(false);
    expect(wrapper.findAll('.saved-item')).toHaveLength(0);
    // …and the editor states its subject: the mode, the name and the URL.
    expect(wrapper.find('.editor-title').text()).toBe('Edit Instance');
    expect(wrapper.find('.editor-subject-name').text()).toBe('Alpha');
    expect(wrapper.find('.editor-subject-url').text()).toBe(INSTANCE_A.url);
    // The fields below are that instance's.
    expect(fieldValue(wrapper, '#forgejo-url')).toBe(INSTANCE_A.url);
    expect(fieldValue(wrapper, '#forgejo-declared-version')).toBe('16.0.2');
    wrapper.unmount();
  });

  it('opens the new-instance mode from Add Instance, with no record to name', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickButton(wrapper, 'Add Instance');

    expect(list(wrapper).exists()).toBe(false);
    expect(editor(wrapper).exists()).toBe(true);
    expect(wrapper.find('.editor-title').text()).toBe('Add Forgejo Instance');
    // Nothing is loaded, so the editor shows no identity rather than borrowing
    // one from the list.
    expect(wrapper.find('.editor-subject').exists()).toBe(false);
    expect(fieldValue(wrapper, '#forgejo-url')).toBe('');
    expect(fieldValue(wrapper, '#forgejo-token')).toBe('');
    wrapper.unmount();
  });

  it('switches from the list to the editor and back without losing the list', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 1);
    expect(wrapper.find('.editor-subject-name').text()).toBe('Beta');

    await clickBack(wrapper);

    // The same list comes back, with both rows.
    expect(list(wrapper).exists()).toBe(true);
    expect(wrapper.findAll('.saved-item')).toHaveLength(2);
    expect(wrapper.text()).toContain(INSTANCE_A.name);
    expect(editor(wrapper).exists()).toBe(false);
    // Cancelling saves nothing.
    expect(stateMock.editInstance).not.toHaveBeenCalled();
    expect(stateMock.saveInstance).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps the Cancel Edit button as the second way out', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    await clickButton(wrapper, 'Cancel Edit');

    expect(list(wrapper).exists()).toBe(true);
    expect(editor(wrapper).exists()).toBe(false);
    expect(stateMock.editInstance).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('returns to the list after a save, with the outcome on the list', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/alpha-edited');
    await clickButton(wrapper, 'Update Instance');
    expect(stateMock.editInstance).toHaveBeenCalledWith(
      INSTANCE_A.id,
      'https://forgejo.example.com/alpha-edited',
      '',
      true,
      '16.0.2',
    );

    // The reply the composable stamps with the request intent.
    state.saveInstanceResult.value = { success: true, target: { kind: 'instance', instanceId: INSTANCE_A.id } };
    await nextTick();

    expect(list(wrapper).exists()).toBe(true);
    expect(editor(wrapper).exists()).toBe(false);
    expect(wrapper.text()).toContain('Instance saved successfully');
    // Nothing was discarded, so nothing was asked.
    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('asks before discarding fields typed into an existing instance', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/alpha-edited');

    stateMock.showConfirm.mockImplementation(async () => false);
    await clickBack(wrapper);

    // Declined: the editor stays, with what was typed.
    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(editor(wrapper).exists()).toBe(true);
    expect(fieldValue(wrapper, '#forgejo-url')).toBe('https://forgejo.example.com/alpha-edited');

    // Accepted: the editor closes and nothing was saved.
    stateMock.showConfirm.mockImplementation(async () => true);
    await clickBack(wrapper);
    expect(editor(wrapper).exists()).toBe(false);
    expect(list(wrapper).exists()).toBe(true);
    expect(stateMock.editInstance).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('does not ask when an untouched editor closes', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    await clickBack(wrapper);

    // An unchanged instance editor has nothing to lose; prompting would be
    // noise on the ordinary way out.
    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    expect(list(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it('asks before discarding a half-typed new instance', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickButton(wrapper, 'Add Instance');
    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/new');

    stateMock.showConfirm.mockImplementation(async () => false);
    await clickBack(wrapper);

    expect(stateMock.showConfirm).toHaveBeenCalledTimes(1);
    expect(editor(wrapper).exists()).toBe(true);

    // An empty new-instance editor prompts for nothing.
    stateMock.showConfirm.mockClear();
    await typeInto(wrapper, '#forgejo-url', '');
    await clickBack(wrapper);
    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    expect(list(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it('gives focus to the editor on open and back to the row on close', async () => {
    const wrapper = mountView({ attach: true });
    await nextTick();

    await clickEdit(wrapper, 1);

    // The view drives the handoff (see the `editorOpen` watcher in
    // Settings.vue). This environment cannot move focus onto a container, so the
    // assertion is on the element the view asked to focus rather than on
    // `document.activeElement`.
    expect(focusedElements).toContain(editor(wrapper).element);

    focusedElements.length = 0;
    await clickBack(wrapper);
    await flushFocusHandoff();

    // Back to the row the editor was opened from — not to the body, and not to
    // the Add Instance button.
    expect(focusedElements).toContain(wrapper.findAll('.saved-item')[1].find('vscode-button').element);
    expect(focusedElements).not.toContain(buttonByLabel(wrapper, 'Add Instance').element);
    wrapper.unmount();
  });

  it('gives focus back to Add Instance when a new-instance editor closes', async () => {
    const wrapper = mountView({ attach: true });
    await nextTick();

    await clickButton(wrapper, 'Add Instance');
    expect(focusedElements).toContain(editor(wrapper).element);

    focusedElements.length = 0;
    await clickBack(wrapper);
    await flushFocusHandoff();
    expect(focusedElements).toContain(buttonByLabel(wrapper, 'Add Instance').element);
    wrapper.unmount();
  });

  it('moves focus only once the row it returns to is on screen', async () => {
    const wrapper = mountView({ attach: true });
    await nextTick();

    await clickEdit(wrapper, 1);
    focusedElements.length = 0;

    await clickBack(wrapper);
    // The list is back on screen, and nothing has been asked to focus yet: the
    // handoff waits for the frame in which a re-mounted control is focusable.
    expect(list(wrapper).exists()).toBe(true);
    expect(focusedElements).toHaveLength(0);
    await runAnimationFrames();

    const target = wrapper.findAll('.saved-item')[1].find('vscode-button').element;
    // The target the handoff reached is the row's own Edit button (`Beta`'s, the
    // row the editor was opened from), inside the list that is on screen now:
    // document order puts it in the re-mounted row, not in the one it replaced.
    expect(target.textContent?.trim()).toBe('Edit Instance');
    expect(target.closest('.saved-item')?.firstElementChild?.textContent).toContain(INSTANCE_B.name);
    // …and the handoff asked after that frame, once the row existed. Asking
    // before this point is what left focus on `<body>` on the real host: the
    // element the list held at the state change was the previous row's, already
    // replaced and not yet laid out.
    expect(focusedElements).toContain(target);
    wrapper.unmount();
  });

  it('names the editor with exactly one heading and states the name once', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);

    // One heading for the editor. The identity that is kept on screen while the
    // fields scroll is that same heading block — not a second, repeated strip —
    // so nothing inside the editor is a second heading to announce.
    expect(editor(wrapper).findAll('h1, h2, h3, h4, h5, h6')).toHaveLength(1);
    expect(editor(wrapper).find('h2').text()).toBe('Edit Instance');

    // …and the name is stated exactly once, as the subject the heading block
    // introduces. A second copy would be read twice wherever the two are
    // announced together.
    expect(editor(wrapper).findAll('.editor-subject-name')).toHaveLength(1);
    expect(wrapper.text().match(/Alpha/g)).toHaveLength(1);
    wrapper.unmount();
  });

  it('drops a pending focus handoff when the editor is reopened', async () => {
    const wrapper = mountView({ attach: true });
    await nextTick();

    await clickEdit(wrapper, 0);
    await clickBack(wrapper);
    // The editor is opened again before the deferred handoff runs: the focus
    // belongs to the editor now, not to the row the previous editor came from.
    await clickEdit(wrapper, 1);
    focusedElements.length = 0;
    await flushFocusHandoff();

    expect(focusedElements).toHaveLength(0);
    expect(editor(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it('offers the instance URL as a copyable value beside the name', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    const copy = wrapper.find('.editor-copy-url');
    expect(copy.attributes('aria-label')).toBe('Copy instance URL');

    await copy.trigger('click');
    expect(stateMock.copyToClipboard).toHaveBeenCalledWith(INSTANCE_A.url);
    wrapper.unmount();
  });

  it('keeps back and save keyboard reachable in the editor', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);

    // The return path is a real `<button>` in the light DOM, so it is in the tab
    // order and Enter/Space activate it without a pointer. The save and cancel
    // are `vscode-button`s: they render a label, and the component (registered
    // by the webview entry point) is what makes them focusable controls — a
    // `vscode-*` tag is an inert custom element in this test environment, so
    // that half is asserted on what the view passes, not on the runtime.
    const back = wrapper.find('.editor-back');
    expect(back.element.tagName).toBe('BUTTON');
    expect(back.attributes('type')).toBe('button');
    for (const label of ['Update Instance', 'Cancel Edit']) {
      expect(buttonByLabel(wrapper, label).text(), label).toBe(label);
    }

    // The editor is the programmatic focus target on open, not an extra tab stop
    // — and, being a destination rather than a control, it paints no focus ring
    // (the stylesheet guard for that lives in `Settings.instanceEditorLayout`).
    expect(editor(wrapper).attributes('tabindex')).toBe('-1');
    wrapper.unmount();
  });
});
