import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const INSTANCE_A = { id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha' };
const INSTANCE_B = { id: 'inst-b', name: 'Beta', url: 'https://forgejo.example.com/beta' };

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
    // The supported floor the host pushes with `initialState`; the form's
    // description interpolates it.
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
    previewImportInstances: vi.fn(),
    exportInstances: vi.fn(),
    copyInstancesToClipboard: vi.fn(),
    // The AI pre-review model row loads its list on mount; this file is about a
    // removed instance, so the row stays empty here.
    loadAiPreReviewChatModels: vi.fn(async () => ({ models: [], configured: '' })),
    saveAiPreReviewChatModel: vi.fn(async (value: string) => ({ value })),
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

type TestInstance = { id: string; name: string; url: string };

/**
 * Writes must go through the reactive proxy the view reads: mutating the raw
 * mock would not notify its watchers. `vi.mock` replaces `useAppState` with
 * `reactive(stateMock)`, which is the same proxy on every call.
 */
function state() {
  return useAppState() as unknown as { instances: { value: TestInstance[] } };
}

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

function fieldValue(wrapper: VueWrapper, selector: string): string {
  const field = wrapper.find(selector);
  const property = (field.element as unknown as { value?: string }).value;
  if (property !== undefined) {
    return String(property);
  }
  return field.attributes('value') ?? '';
}

function headings(wrapper: VueWrapper): string[] {
  return wrapper.findAll('h2').map((heading) => heading.text());
}

async function clickEdit(wrapper: VueWrapper, index: number) {
  const item: DOMWrapper<Element> | undefined = wrapper.findAll('.saved-item')[index];
  expect(item, `saved instance ${index}`).toBeTruthy();
  await item!.find('vscode-button').trigger('click');
  await nextTick();
}

/**
 * The edit form is bound to an instance record. Removing that instance from the
 * list (the host re-sends `instances` after a removal) left the form open on a
 * record that no longer exists, so Update/Test answered "Instance not found"
 * (see the host's `editInstance` handler). The form closes with its record.
 */
describe('Settings edit form for a removed instance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.instances.value = [{ ...INSTANCE_A }, { ...INSTANCE_B }];
  });

  it('closes the edit form when its instance disappears from the list', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    expect(headings(wrapper)).toContain('Edit Instance');
    expect(fieldValue(wrapper, '#forgejo-url')).toBe(INSTANCE_A.url);

    // The user removes Alpha (confirmed host-side); the refreshed list no
    // longer carries it.
    state().instances.value = [{ ...INSTANCE_B }];
    await nextTick();

    expect(headings(wrapper)).toContain('Add Forgejo Instance');
    expect(fieldValue(wrapper, '#forgejo-url')).toBe('');
    expect(fieldValue(wrapper, '#forgejo-token')).toBe('');
    wrapper.unmount();
  });

  it('keeps the edit form open when its instance is still listed', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);

    // An unrelated refresh (another instance was added/edited) must not close
    // the form the user is working in.
    state().instances.value = [{ ...INSTANCE_A }, { ...INSTANCE_B }];
    await nextTick();

    expect(headings(wrapper)).toContain('Edit Instance');
    expect(fieldValue(wrapper, '#forgejo-url')).toBe(INSTANCE_A.url);
    wrapper.unmount();
  });
});
