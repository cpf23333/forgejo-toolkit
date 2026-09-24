import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as Record<string, unknown>[] },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    worktreeOpenMode: { value: 'ask' },
    changeWorktreeOpenMode: vi.fn(),
    worktreeCacheDirectory: { value: '' },
    worktreeCacheDirectoryDefault: { value: '/host/default' },
    setWorktreeCacheDirectory: vi.fn(),
    browseWorktreeCacheDirectory: vi.fn(),
    importPreview: { value: undefined },
    importInstancesResult: { value: undefined },
    testConnectionResult: { value: undefined },
    saveInstanceResult: { value: undefined },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    testConnection: vi.fn(),
    saveInstance: vi.fn(),
    loadRepositories: vi.fn(),
    removeInstance: vi.fn(),
    openExternal: vi.fn(),
    previewImportInstances: vi.fn(),
  },
}));

// The view and the test must read the same reactive proxy: a watcher only tracks
// `.value` reads through one, so the state is wrapped in `reactive` exactly like
// the other Onboarding tests do.
vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return { useAppState: () => state };
});

import Onboarding from '../Onboarding.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

const FIELD = '#onboarding-worktree-cache-directory';

const state = useAppState() as unknown as {
  worktreeCacheDirectory: { value: string };
  instances: { value: Record<string, unknown>[] };
};

function mountView() {
  return mount(Onboarding, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { TokenScopeList: true, ImportPreview: true },
    },
  });
}

/**
 * `vscode-textfield` compiles to a custom element whose stub is a plain
 * `<input>`; read the DOM property (what the user sees) and fall back to the
 * attribute a test's property write would otherwise shadow.
 */
function fieldValue(wrapper: VueWrapper): string {
  const field = wrapper.find(FIELD);
  const property = (field.element as unknown as { value?: string }).value;
  if (property !== undefined) {
    return String(property);
  }
  return field.attributes('value') ?? '';
}

async function typeInto(wrapper: VueWrapper, value: string) {
  const field = wrapper.find(FIELD);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
}

/** Advances the wizard by `steps` Next clicks. */
async function goToStep(wrapper: VueWrapper, steps: number) {
  for (let step = 0; step < steps; step++) {
    const next = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Next');
    expect(next, 'Next button').toBeTruthy();
    await next!.trigger('click');
    await nextTick();
  }
}

/** The worktree fields live on step 2, the Complete summary on step 3. */
async function openWorktreeStep(wrapper: VueWrapper) {
  await goToStep(wrapper, 2);
}

/**
 * The host validates the cache directory: an unusable path gets a native error
 * and *no* reply, while an accepted one is answered with the directory now in
 * use. The field and the closing summary used to keep showing the typed path, so
 * a rejected directory looked applied while new worktrees still went to the
 * previous (or default) one.
 */
describe('Onboarding worktree cache directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.worktreeCacheDirectory.value = '/host/current';
    stateMock.worktreeCacheDirectoryDefault.value = '/host/default';
    stateMock.instances.value = [];
  });

  it('does not present a rejected path as applied', async () => {
    // A rejected path is answered with a native error and nothing else, so the
    // store keeps the directory that is really in use.
    stateMock.setWorktreeCacheDirectory.mockImplementation(() => {});
    const wrapper = mountView();
    await nextTick();
    await openWorktreeStep(wrapper);
    expect(fieldValue(wrapper)).toBe('/host/current');

    await typeInto(wrapper, '/rejected/path');
    await wrapper.find(FIELD).trigger('change');
    await nextTick();

    expect(stateMock.setWorktreeCacheDirectory).toHaveBeenCalledWith('/rejected/path');
    expect(fieldValue(wrapper)).toBe('/host/current');
    wrapper.unmount();
  });

  it('shows a confirmed path once the host replies with it', async () => {
    // The host reply carries the directory that is now in use.
    stateMock.setWorktreeCacheDirectory.mockImplementation((directory: string) => {
      state.worktreeCacheDirectory.value = directory;
    });
    const wrapper = mountView();
    await nextTick();
    await openWorktreeStep(wrapper);

    await typeInto(wrapper, '/accepted/path');
    await wrapper.find(FIELD).trigger('change');
    await nextTick();

    expect(fieldValue(wrapper)).toBe('/accepted/path');
    wrapper.unmount();
  });

  it('reports the directory in use in the Complete summary, not a rejected one', async () => {
    stateMock.setWorktreeCacheDirectory.mockImplementation(() => {});
    const wrapper = mountView();
    await nextTick();
    await openWorktreeStep(wrapper);

    await typeInto(wrapper, '/rejected/path');
    await wrapper.find(FIELD).trigger('change');
    await nextTick();

    await goToStep(wrapper, 1);

    const summary = wrapper.find('.summary').text();
    expect(summary).toContain('/host/current');
    expect(summary).not.toContain('/rejected/path');
    wrapper.unmount();
  });
});
