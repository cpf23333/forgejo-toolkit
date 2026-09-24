import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    repoRefs: {
      value: new Map<string, unknown>([['inst-1:owner/repoA:refs', { branches: [], tags: [], releases: [] }]]),
    },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    locale: { value: 'en' },
    showConfirm: vi.fn(async () => true),
    loadRepoRefs: vi.fn(),
    createRepoBranch: vi.fn(),
    createRepoTag: vi.fn(),
    editRepoRelease: vi.fn(),
    deleteRepoBranch: vi.fn(),
    deleteRepoTag: vi.fn(),
    deleteRepoRelease: vi.fn(),
    createRepoRelease: vi.fn(),
    uploadReleaseAttachment: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive: makeReactive } = await import('vue');
  stateMock.loading = makeReactive(stateMock.loading) as unknown as Map<string, boolean>;
  stateMock.errors = makeReactive(stateMock.errors) as unknown as Map<string, string>;
  return {
    useAppState: () => stateMock,
    repoRefsKey: (instanceId: string, owner: string, repo: string) => `${instanceId}:${owner}/${repo}:refs`,
  };
});

const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: { open: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
  emits: ['close'],
  template: '<div class="modal-dialog-stub"><slot /></div>',
});

const EasyMdeStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" :value="modelValue" />',
});

import RepoRefs from '../RepoRefs.vue';
import RepoRefFormDialog from '../RepoRefFormDialog.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const REFS_KEY = 'inst-1:owner/repoA:refs';

function mountRepoRefs() {
  return mount(RepoRefs, {
    props: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA' },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { ModalDialog: ModalDialogStub, EasyMdeEditor: EasyMdeStub },
    },
  });
}

function dialogOf(wrapper: ReturnType<typeof mountRepoRefs>) {
  const dialog = wrapper.findComponent(RepoRefFormDialog);
  expect(dialog.exists(), 'RepoRefFormDialog').toBe(true);
  return dialog;
}

async function openBranchDialog(wrapper: ReturnType<typeof mountRepoRefs>) {
  const button = wrapper.findAll('.ref-action-button').find((entry) => entry.text().includes('New branch'));
  expect(button, 'New branch button').toBeTruthy();
  await button!.trigger('click');
  await nextTick();
}

/**
 * Branch and tag creates are fire-and-forget commands: neither sets a loading key
 * of its own, so the dialog's `loading` prop stayed false until the refs reload
 * that follows a success - and `handleSubmit` had no re-entry guard. A double
 * click in that window posted a second create; its "already exists" reply then
 * replaced the success of the first, so the branch was created but the dialog
 * reported a failure.
 */
describe('RepoRefs create submitted twice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.errors.clear();
    stateMock.loading.clear();
    stateMock.repoRefs.value.set(REFS_KEY, { branches: [], tags: [], releases: [] });
  });

  it('posts one create for a double click on Create', async () => {
    const wrapper = mountRepoRefs();
    await nextTick();
    await openBranchDialog(wrapper);
    const dialog = dialogOf(wrapper);

    dialog.vm.$emit('submit', { newBranchName: 'feature/x' });
    dialog.vm.$emit('submit', { newBranchName: 'feature/x' });
    await flushPromises();

    expect(stateMock.createRepoBranch).toHaveBeenCalledTimes(1);
    expect(stateMock.createRepoBranch).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 'feature/x', undefined);
    wrapper.unmount();
  });

  it('reports the create as in flight so the dialog cannot be submitted again', async () => {
    const wrapper = mountRepoRefs();
    await nextTick();
    await openBranchDialog(wrapper);
    const dialog = dialogOf(wrapper);
    // No refs request is running: only the create itself can make the dialog busy.
    stateMock.loading.set(REFS_KEY, false);
    await nextTick();
    expect(dialog.props('loading')).toBe(false);

    dialog.vm.$emit('submit', { newBranchName: 'feature/x' });
    await nextTick();

    expect(dialog.props('loading')).toBe(true);
    wrapper.unmount();
  });

  it('accepts a later create once the finished one has closed the dialog', async () => {
    const wrapper = mountRepoRefs();
    await nextTick();
    await openBranchDialog(wrapper);
    const dialog = dialogOf(wrapper);

    dialog.vm.$emit('submit', { newBranchName: 'feature/x' });
    await nextTick();
    // The host created the branch and reloaded the refs: the reload finishing is
    // what ends the submit (and closes the dialog).
    stateMock.loading.set(REFS_KEY, true);
    await nextTick();
    stateMock.loading.set(REFS_KEY, false);
    await flushPromises();
    expect(dialog.props('open')).toBe(false);

    // The next session must not be blocked by the previous one's guard.
    await openBranchDialog(wrapper);
    dialog.vm.$emit('submit', { newBranchName: 'feature/y' });
    await flushPromises();

    expect(stateMock.createRepoBranch).toHaveBeenCalledTimes(2);
    expect(stateMock.createRepoBranch.mock.calls[1]).toEqual(['inst-1', 'owner', 'repoA', 'feature/y', undefined]);
    wrapper.unmount();
  });
});
