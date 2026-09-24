import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    repoRefs: {
      value: new Map<string, unknown>([['inst-1:owner/repoA:refs', { branches: [], tags: [], releases: [] }]]),
    },
    // `loading`/`errors` are the *inputs* to the view's computeds, so they must
    // be reactive maps: mutating a plain Map inside a reactive state object does
    // not notify a computed that read it, and the view's watchers would never
    // fire. `vi.mock` below wraps them (the factory can await `vue`).
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

// jsdom's <dialog> has no showModal/close; the dialog's own state is what these
// tests exercise.
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

function mountRepoRefs(props: Record<string, unknown> = {}) {
  return mount(RepoRefs, {
    props: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', ...props },
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

async function openDialog(wrapper: ReturnType<typeof mountRepoRefs>, label: string) {
  const tab = wrapper.findAll('.tab-button').find((entry) => entry.text().trim() === 'Releases');
  // The create buttons live inside the active tab's pane; "New release" is only
  // rendered on the releases tab.
  if (label === 'New release') {
    expect(tab, 'Releases tab').toBeTruthy();
    await tab!.trigger('click');
    await nextTick();
  }
  const button = wrapper.findAll('.ref-action-button').find((entry) => entry.text().includes(label));
  expect(button, `${label} button`).toBeTruthy();
  await button!.trigger('click');
  await nextTick();
}

describe('RepoRefs tab labels', () => {
  it('follows a runtime locale change', async () => {
    const i18n = createTestI18n('en');
    const wrapper = mount(RepoRefs, {
      props: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA' },
      global: { plugins: [i18n], stubs: { ModalDialog: ModalDialogStub, EasyMdeEditor: EasyMdeStub } },
    });
    await nextTick();
    expect(wrapper.findAll('.tab-button').map((tab) => tab.text())).toEqual(['Branches', 'Tags', 'Releases']);

    // A locale change is what `useAppState().changeLocale` does to the i18n
    // instance; the tabs captured their labels at setup, so they used to stay in
    // the old language while the rest of the view re-rendered.
    i18n.global.locale.value = 'zh';
    await nextTick();

    const labels = wrapper.findAll('.tab-button').map((tab) => tab.text());
    // Same keys, the other language: the zh file translates "Releases" with the
    // English word, so the branches/tags labels are what prove the switch.
    expect(labels).not.toEqual(['Branches', 'Tags', 'Releases']);
    expect(labels).toEqual(['分支', '标签', 'Release']);
    wrapper.unmount();
  });
});

describe('RepoRefs dialog cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.showConfirm.mockResolvedValue(true);
  });

  it('asks before discarding typed input and keeps the dialog open when declined', async () => {
    // `clearAllMocks` also drops implementations, so this has to be set after it.
    stateMock.showConfirm.mockResolvedValue(false);
    const wrapper = mountRepoRefs();
    await nextTick();
    await openDialog(wrapper, 'New branch');
    const dialog = dialogOf(wrapper);
    expect(dialog.props('open')).toBe(true);

    // The user typed a branch name: the dialog reports itself dirty.
    dialog.vm.$emit('dirty', true);
    await nextTick();
    dialog.vm.$emit('cancel');
    await flushPromises();

    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(dialog.props('open')).toBe(true);
    wrapper.unmount();
  });

  it('closes once the discard is confirmed', async () => {
    const wrapper = mountRepoRefs();
    await nextTick();
    await openDialog(wrapper, 'New branch');
    const dialog = dialogOf(wrapper);

    dialog.vm.$emit('dirty', true);
    await nextTick();
    dialog.vm.$emit('cancel');
    await flushPromises();

    expect(dialog.props('open')).toBe(false);
    wrapper.unmount();
  });

  it('closes a clean dialog immediately', async () => {
    const wrapper = mountRepoRefs();
    await nextTick();
    await openDialog(wrapper, 'New branch');
    const dialog = dialogOf(wrapper);

    dialog.vm.$emit('cancel');
    await flushPromises();

    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    expect(dialog.props('open')).toBe(false);
    wrapper.unmount();
  });
});

/**
 * A failed create only calls `setError`; it never reloads the refs, so the
 * loading flag never flipped and `isSubmitting` stayed true. The next refs load
 * then hit the `!loading && isSubmitting && !error` branch and closed a dialog
 * the user still had open.
 */
describe('RepoRefs submit flag lifetime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.errors.clear();
    stateMock.loading.clear();
    stateMock.repoRefs.value.set(REFS_KEY, { branches: [], tags: [], releases: [] });
  });

  it('does not close an open dialog when a later refs reload finishes', async () => {
    const wrapper = mountRepoRefs();
    await nextTick();
    await openDialog(wrapper, 'New branch');
    const dialog = dialogOf(wrapper);

    dialog.vm.$emit('submit', { newBranchName: 'feature/x' });
    await nextTick();
    expect(stateMock.createRepoBranch).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 'feature/x', undefined);

    // The host rejects the create. A failure only calls `setError`: it never
    // reloads the refs, so the loading flag never flips and the submit flag used
    // to stay true.
    stateMock.errors.set(REFS_KEY, 'branch already exists');
    await nextTick();
    dialog.vm.$emit('close');
    await nextTick();
    await openDialog(wrapper, 'New branch');
    expect(dialog.props('open')).toBe(true);

    // The error was resolved while the dialog stayed open (the user edited the
    // name, the host retried): the list then reloads from a healthy state.
    stateMock.errors.delete(REFS_KEY);
    await nextTick();
    stateMock.loading.set(REFS_KEY, true);
    await nextTick();
    stateMock.loading.set(REFS_KEY, false);
    await flushPromises();

    // With the stale submit flag this reload hit the `!loading && isSubmitting
    // && !error` branch and closed a dialog the user still had open.
    expect(dialog.props('open')).toBe(true);
    wrapper.unmount();
  });
});

/**
 * Creating a release and uploading its attachments are separate round-trips, and
 * the view's props follow whatever repository the user navigated to. Reading
 * `props.owner`/`props.repo` again after the await posted the remaining
 * attachments to the new repository, together with the old release id.
 */
describe('RepoRefs release attachment target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.errors.clear();
    stateMock.loading.clear();
  });

  it('uploads the queued attachments to the release that was created', async () => {
    stateMock.createRepoRelease.mockResolvedValue({ id: 7 });
    stateMock.uploadReleaseAttachment.mockResolvedValue({});

    const wrapper = mountRepoRefs();
    await nextTick();
    await openDialog(wrapper, 'New release');
    const dialog = dialogOf(wrapper);

    dialog.vm.$emit('upload-pending', new File(['good'], 'good.txt'));
    dialog.vm.$emit('upload-pending', new File(['more'], 'more.txt'));
    await nextTick();

    // The user navigates to another repository while the release is being
    // created; the view is re-used with the new props.
    stateMock.createRepoRelease.mockImplementation(async () => {
      await wrapper.setProps({ repo: 'repoB' });
      return { id: 7 };
    });

    dialog.vm.$emit('submit', { tagName: 'v1.0.0' });
    await flushPromises();

    expect(stateMock.uploadReleaseAttachment.mock.calls[0].slice(0, 5)).toEqual([
      'inst-1',
      'owner',
      'repoA',
      7,
      'good.txt',
    ]);
    wrapper.unmount();
  });
});
