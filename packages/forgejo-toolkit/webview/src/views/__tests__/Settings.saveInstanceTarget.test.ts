import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const INSTANCE_A = { id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha' };

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: {
      value: [
        { id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha' },
        { id: 'inst-b', name: 'Beta', url: 'https://forgejo.example.com/beta' },
      ],
    },
    importPreview: { value: undefined },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
    worktreeOpenMode: { value: 'ask' },
    changeWorktreeOpenMode: vi.fn(),
    worktreeCacheDirectory: { value: '' },
    worktreeCacheDirectoryDefault: { value: '' },
    setWorktreeCacheDirectory: vi.fn(),
    browseWorktreeCacheDirectory: vi.fn(),
    worktrees: { value: [] },
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
  },
}));

// Only `useAppState` is replaced: the real `saveInstanceTargetKey` is kept so
// the guard under test is compared against the helper the app actually uses.
vi.mock('../../composables/useAppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useAppState')>();
  const { reactive: makeReactive } = await import('vue');
  // The view must read the reactive proxy, or mutating the raw mock would not
  // notify its watchers.
  return {
    ...actual,
    useAppState: () => makeReactive(stateMock),
  };
});

import Settings from '../Settings.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

type SaveResult = { success: boolean; error?: string; target?: { kind: 'instance' | 'new'; instanceId?: string } };
type TestResult = {
  success: boolean;
  username?: string;
  error?: string;
  target?: { kind: 'instance' | 'new'; instanceId?: string };
};

const state = useAppState() as unknown as {
  saveInstanceResult: { value: SaveResult | undefined };
  testConnectionResult: { value: TestResult | undefined };
  editInstance: ReturnType<typeof vi.fn>;
  saveInstance: ReturnType<typeof vi.fn>;
  testConnection: ReturnType<typeof vi.fn>;
};

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

function buttonByLabel(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  return button!;
}

async function clickButton(wrapper: VueWrapper, label: string) {
  await buttonByLabel(wrapper, label).trigger('click');
}

/** The Edit button of the nth saved instance. */
async function clickEdit(wrapper: VueWrapper, index: number) {
  const item = wrapper.findAll('.saved-item')[index];
  expect(item, `saved instance ${index}`).toBeTruthy();
  await item.find('vscode-button').trigger('click');
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string) {
  const field = wrapper.find(selector);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
}

/**
 * `<vscode-*>` tags are custom elements, so their bound `value` may land as
 * either a DOM property (once something assigned one, e.g. a simulated
 * keystroke) or as an attribute (the initial Vue patch). Prefer the property:
 * an attribute left over from an earlier render would otherwise go stale.
 */
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

function savedStatus(wrapper: VueWrapper): boolean {
  return wrapper.text().includes('Instance saved successfully');
}

/**
 * Whether a submit button is showing its busy label. `<vscode-button>` is a
 * custom element the test setup replaces with a stub, so its `disabled` prop
 * (not a DOM attribute) and the label Vue renders into it are what `saving`
 * shows up as. A form left on "Saving..." forever is the state this pins down.
 */
function hasBusySubmitButton(wrapper: VueWrapper): boolean {
  return wrapper.findAll('vscode-button').some((entry) => entry.text().trim() === 'Saving...');
}

describe('Settings saveInstanceResult target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.saveInstanceResult.value = undefined;
    stateMock.testConnectionResult.value = undefined;
  });

  it('ignores a successful reply for an instance other than the one being edited', async () => {
    const wrapper = mountView();
    await nextTick();

    // The user edits instance A and submits the update.
    await clickEdit(wrapper, 0);
    await clickButton(wrapper, 'Update Instance');
    expect(state.editInstance).toHaveBeenCalledWith(INSTANCE_A.id, INSTANCE_A.url, '', true);

    // …then opens instance B before A's reply lands and types into B's form.
    await clickEdit(wrapper, 1);
    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/beta-edited');
    await typeInto(wrapper, '#forgejo-token', 'typed-token');

    // A's reply answers the form the user has left (the host does not echo
    // identity: the composable stamps the reply with the target it was sent
    // for). It must not touch B's form.
    state.saveInstanceResult.value = { success: true, target: { kind: 'instance', instanceId: INSTANCE_A.id } };
    await nextTick();

    expect(fieldValue(wrapper, '#forgejo-url')).toBe('https://forgejo.example.com/beta-edited');
    expect(fieldValue(wrapper, '#forgejo-token')).toBe('typed-token');
    // B's edit is still open and nothing claims B was saved.
    expect(headings(wrapper)).toContain('Edit Instance');
    expect(savedStatus(wrapper)).toBe(false);
    // The reply arrives exactly once, so the guard above must not swallow the
    // busy-state reset: B's form has to be submittable again instead of sitting
    // on "Saving..." with its submit button disabled forever.
    expect(hasBusySubmitButton(wrapper)).toBe(false);
    wrapper.unmount();
  });

  it('applies a successful reply that matches the edited instance', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickEdit(wrapper, 0);
    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/alpha-edited');
    await clickButton(wrapper, 'Update Instance');

    state.saveInstanceResult.value = { success: true, target: { kind: 'instance', instanceId: INSTANCE_A.id } };
    await nextTick();

    // The happy path is unchanged: the fields are cleared and the edit ends.
    expect(fieldValue(wrapper, '#forgejo-url')).toBe('');
    expect(fieldValue(wrapper, '#forgejo-token')).toBe('');
    expect(headings(wrapper)).toContain('Add Forgejo Instance');
    expect(savedStatus(wrapper)).toBe(true);
    wrapper.unmount();
  });

  it('applies a successful reply for the add form it was submitted from', async () => {
    const wrapper = mountView();
    await nextTick();

    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/new');
    await typeInto(wrapper, '#forgejo-token', 'new-token');
    await clickButton(wrapper, 'Add Instance');
    expect(state.saveInstance).toHaveBeenCalledWith('https://forgejo.example.com/new', 'new-token', true);

    state.saveInstanceResult.value = { success: true, target: { kind: 'new' } };
    await nextTick();

    expect(fieldValue(wrapper, '#forgejo-url')).toBe('');
    expect(fieldValue(wrapper, '#forgejo-token')).toBe('');
    expect(savedStatus(wrapper)).toBe(true);
    wrapper.unmount();
  });

  it('still applies an unstamped reply, as replies without a target always did', async () => {
    // Older hosts (and queued replies) carry no target: the guard must not
    // turn those into a regression.
    const wrapper = mountView();
    await nextTick();

    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com/legacy');
    await typeInto(wrapper, '#forgejo-token', 'legacy-token');

    state.saveInstanceResult.value = { success: true };
    await nextTick();

    expect(fieldValue(wrapper, '#forgejo-url')).toBe('');
    expect(fieldValue(wrapper, '#forgejo-token')).toBe('');
    expect(savedStatus(wrapper)).toBe(true);
    wrapper.unmount();
  });
});

describe('Settings testConnectionResult target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.saveInstanceResult.value = undefined;
    state.testConnectionResult.value = undefined;
  });

  it('ignores a connection result for a form other than the one on screen', async () => {
    const wrapper = mountView();
    await nextTick();

    // The user tests instance A's connection…
    await clickEdit(wrapper, 0);
    await clickButton(wrapper, 'Test Connection');
    expect(state.testConnection).toHaveBeenCalledWith(INSTANCE_A.url, '', INSTANCE_A.id);
    expect(wrapper.text()).toContain('Testing...');

    // …then opens instance B before A's reply lands.
    await clickEdit(wrapper, 1);

    // The composable stamps the reply with the form it was sent for, so the
    // form on screen must not report A's user as its own connection status.
    state.testConnectionResult.value = {
      success: true,
      username: 'alpha-user',
      target: { kind: 'instance', instanceId: INSTANCE_A.id },
    };
    await nextTick();

    expect(wrapper.text()).not.toContain('alpha-user');
    // The busy state is reset on every path: the reply arrives once, so a
    // dropped result must not leave the button on "Testing..." forever.
    expect(wrapper.findAll('vscode-button').some((entry) => entry.text().trim() === 'Testing...')).toBe(false);
    wrapper.unmount();
  });

  it('still applies an unstamped connection result', async () => {
    const wrapper = mountView();
    await nextTick();

    await clickButton(wrapper, 'Test Connection');
    state.testConnectionResult.value = { success: true, username: 'demo-user' };
    await nextTick();

    expect(wrapper.text()).toContain('demo-user');
    wrapper.unmount();
  });
});
