import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const WORKTREE = {
  id: 'wt-1',
  instanceId: 'inst-a',
  owner: 'owner',
  repo: 'repo',
  prIndex: 7,
  prTitle: 'Fix the thing',
  headBranch: 'feature',
  baseBranch: 'main',
  worktreePath: '/tmp/worktrees/wt-1',
};

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [{ id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha' }] },
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
    // The AI pre-review model row loads its list on mount; this file is about
    // the worktree removal error, so the row stays empty here.
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

type WorktreeError = {
  error: string;
  operation?: 'open' | 'remove';
  instanceId?: string;
  owner?: string;
  repo?: string;
  index?: number;
};

/**
 * Writes must go through the reactive proxy the view reads: mutating the raw
 * mock would not notify its watchers. `vi.mock` replaces `useAppState` with
 * `reactive(stateMock)`, which is the same proxy on every call.
 */
function state() {
  return useAppState() as unknown as {
    worktrees: { value: Array<typeof WORKTREE> };
    lastWorktreeError: { value: WorktreeError | undefined };
  };
}

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

/**
 * `lastWorktreeError` is a one-way notification: the host answers a failed
 * removal with it (and keeps the record so the user can retry), but a later
 * successful removal only sends `worktreeRemoved`/`worktreesList`. The message
 * therefore stayed on screen under a list that no longer contained the row. It
 * belongs to the record it failed on, so it goes away with that record.
 */
describe('Settings worktree removal error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.worktrees.value = [{ ...WORKTREE }];
    stateMock.lastWorktreeError.value = undefined;
  });

  function failRemoval() {
    state().lastWorktreeError.value = {
      error: 'Could not delete the worktree directory',
      operation: 'remove',
      instanceId: WORKTREE.instanceId,
      owner: WORKTREE.owner,
      repo: WORKTREE.repo,
      index: WORKTREE.prIndex,
    };
  }

  it('shows a failed removal and keeps it while the record stays listed', async () => {
    const wrapper = mountView();
    await nextTick();

    failRemoval();
    await nextTick();
    expect(wrapper.text()).toContain('Could not delete the worktree directory');

    // The host re-sends the list after a failure, with the record still in it
    // (the retry target). A refreshed list is not a successful removal.
    state().worktrees.value = state().worktrees.value.map((worktree) => ({ ...worktree }));
    await nextTick();
    expect(wrapper.text()).toContain('Could not delete the worktree directory');
    wrapper.unmount();
  });

  it('drops the message once that worktree is removed successfully', async () => {
    const wrapper = mountView();
    await nextTick();

    failRemoval();
    await nextTick();
    expect(wrapper.text()).toContain('Could not delete the worktree directory');

    // A successful removal drops the record: the error it failed on is gone.
    state().worktrees.value = [];
    await nextTick();

    expect(wrapper.text()).not.toContain('Could not delete the worktree directory');
    wrapper.unmount();
  });
});
