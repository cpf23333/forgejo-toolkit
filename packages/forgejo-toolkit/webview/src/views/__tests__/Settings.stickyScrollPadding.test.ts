import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The scroll container's padding above a focused field.
 *
 * The sticky identity block covers the strip it occupies, so a field the browser
 * scrolls into view stopped at the scrollport's own top edge and could land
 * behind the block — at 358×300 the declared-version field sat under it and only
 * scrolling up about 54 px recovered it. The container now carries
 * `scroll-padding-top` with the block's measured height, which moves that edge
 * down.
 *
 * What is checked here is the wiring: the container publishes the height, the
 * block is measured when it mounts and re-measured when its size changes, and the
 * list state reserves nothing. jsdom lays nothing out, so the measured number is
 * whatever this test makes `getBoundingClientRect` return — the real height, the
 * real sticky offset and the real scroll behaviour are properties of a render.
 */
const INSTANCE_A = {
  id: 'inst-a',
  name: 'Alpha',
  url: 'https://forgejo.example.com/alpha',
  declaredServerVersion: '16.0.2',
};

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
    aiProviderSettings: { value: undefined },
    loadAiProviderSettings: vi.fn(async () => ({
      providers: [],
      rejected: [],
      enabled: false,
      transport: 'auto' as const,
      localOnly: false,
      requestTimeoutMs: 30000,
      bindings: [],
      features: ['aiPreReview'],
      capability: { available: true } as const,
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
    setAiModelPolicy: vi.fn(async () => ({
      enabled: false,
      transport: 'auto',
      localOnly: false,
      requestTimeoutMs: 30000,
    })),
    setAiModelBinding: vi.fn(async () => ({ feature: 'aiPreReview', providerId: '', modelId: '' })),
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
    // The settings page reads its own surface on mount and renders the host's
    // reading rather than a value of its own; the defaults below are the
    // manifest's, so a test that does not care about those sections still mounts
    // a page with the values a fresh install has.
    settingsSurface: {
      value: {
        notificationPollingEnabled: true,
        mcpEnabled: true,
        mcpWriteTools: { createIssueComment: false, submitPullReview: false, cancelActionRun: false },
        mcpWriteAuditToFile: false,
        multiWindowLease: true,
        aiPreReview: false,
        aiPreReviewPromptScope: 'ask',
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

/**
 * The observer the view builds. jsdom ships no `ResizeObserver`, so the view has
 * to find one (`typeof ResizeObserver === 'function'`); this records both what it
 * was asked to watch and the callback a later size change would run.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  readonly observed: Array<{ target: Element; box: string | undefined }> = [];

  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element, options?: { box?: string }): void {
    this.observed.push({ target, box: options?.box });
  }

  disconnect(): void {
    this.observed.length = 0;
  }

  /** What a real resize would do: run the callback the view handed in. */
  trigger(): void {
    this.callback();
  }
}

const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
let headingHeight = 0;

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

const scrollContainer = (wrapper: VueWrapper) => wrapper.find('.settings');
const publishedHeight = (wrapper: VueWrapper) =>
  (scrollContainer(wrapper).element as HTMLElement).style.getPropertyValue('--editor-sticky-height');

async function openEditor(wrapper: VueWrapper) {
  const edit = wrapper.findAll('.saved-item')[0].find('vscode-button');
  await edit.trigger('click');
  await nextTick();
}

beforeEach(() => {
  vi.clearAllMocks();
  stateMock.instances.value = [{ ...INSTANCE_A }];
  stateMock.saveInstanceResult.value = undefined;
  stateMock.testConnectionResult.value = undefined;
  FakeResizeObserver.instances = [];
  headingHeight = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  // jsdom lays nothing out, so every rect is zero. The view reads one number,
  // and the test decides it.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const height = this.classList?.contains('editor-heading') ? headingHeight : 0;
    return { width: 300, height, top: 0, left: 0, right: 300, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
  } as typeof Element.prototype.getBoundingClientRect;
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
});

describe('Settings sticky block scroll padding', () => {
  it('reserves the block’s measured height while the editor is open', async () => {
    headingHeight = 118;
    const wrapper = mountView();
    await nextTick();

    // The list has no sticky block: the container reserves nothing.
    expect(publishedHeight(wrapper)).toBe('0px');

    await openEditor(wrapper);

    // The measured height, published for `scroll-padding-top` to read.
    expect(publishedHeight(wrapper)).toBe('118px');
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer, 'a ResizeObserver watching the block').toBeTruthy();
    // The sticky offset is the block's border box, so that is the box measured.
    expect(observer!.observed).toHaveLength(1);
    expect(observer!.observed[0].box).toBe('border-box');
    expect((observer!.observed[0].target as HTMLElement).classList.contains('editor-heading')).toBe(true);
    wrapper.unmount();
  });

  it('follows a size change of the block', async () => {
    headingHeight = 90;
    const wrapper = mountView();
    await nextTick();
    await openEditor(wrapper);
    expect(publishedHeight(wrapper)).toBe('90px');

    // A narrower panel wraps the subject URL: the block grows, and a constant
    // would now be too small to keep the last field clear of it.
    headingHeight = 140;
    FakeResizeObserver.instances.at(-1)!.trigger();
    await nextTick();

    expect(publishedHeight(wrapper)).toBe('140px');
    wrapper.unmount();
  });

  it('releases the reservation when the editor closes', async () => {
    headingHeight = 118;
    const wrapper = mountView();
    await nextTick();
    await openEditor(wrapper);
    expect(publishedHeight(wrapper)).toBe('118px');

    await wrapper.find('.editor-back').trigger('click');
    await nextTick();

    // The list is back and it has no sticky block.
    expect(wrapper.find('.settings-list').exists()).toBe(true);
    expect(publishedHeight(wrapper)).toBe('0px');
    wrapper.unmount();
  });

  it('survives an environment without ResizeObserver', async () => {
    // The webview is Chromium and has it; a test environment or an older host
    // may not, and the height is still read once from the mounted block.
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    headingHeight = 118;
    const wrapper = mountView();
    await nextTick();
    await openEditor(wrapper);

    expect(publishedHeight(wrapper)).toBe('118px');
    wrapper.unmount();
  });

  it('keeps the block, the fields and the status region in one order in the DOM', async () => {
    // The compaction rule hides the URL group with `display: none` rather than
    // removing it, so the editor has one shape in the DOM at every panel height
    // and the copy control never keeps a slot in the tab order where it is not
    // drawn. What a render has to confirm is the visual result; what this pins is
    // that the block is still the first thing in the editor, that the fields
    // follow it, and that the status region is last — the order the sticky
    // block's `z-index` and the scroll padding are written against.
    const wrapper = mountView();
    await nextTick();
    await openEditor(wrapper);

    const editor = wrapper.find('.instance-editor');
    // `status` carries its own type class (`status idle`), so the first class is
    // what the element is.
    const order = [...editor.element.querySelectorAll('.editor-heading, .editor-fields, .status')].map(
      (element) => element.className.split(' ')[0],
    );
    expect(order).toEqual(['editor-heading', 'editor-fields', 'status']);
    // One heading, and the hidden group is still the only place carrying the URL.
    expect(editor.findAll('h1, h2, h3, h4, h5, h6')).toHaveLength(1);
    expect(editor.findAll('.editor-subject-url-group')).toHaveLength(1);
    wrapper.unmount();
  });
});
