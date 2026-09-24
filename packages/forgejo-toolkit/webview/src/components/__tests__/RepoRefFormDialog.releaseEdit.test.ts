import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import RepoRefFormDialog from '../RepoRefFormDialog.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    uploadReleaseAttachment: vi.fn(),
    deleteReleaseAttachment: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', () => ({ useAppState: () => stateMock }));

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" :value="modelValue" />',
});

// jsdom's <dialog> has no showModal/close.
const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: { open: { type: Boolean, default: false } },
  template: '<div class="modal-stub"><slot /></div>',
});

const release = {
  id: 5,
  tag_name: 'v1.2.0',
  name: 'Release 1.2.0',
  body: 'notes',
  target_commitish: 'develop',
  hide_archive_links: true,
};

/**
 * The fields are seeded when the dialog opens, so it is mounted closed and
 * opened like RepoRefs does.
 */
async function mountDialog() {
  const wrapper = mount(RepoRefFormDialog, {
    props: {
      mode: 'release' as const,
      open: false,
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      defaultBranch: 'main',
      branches: ['main', 'develop'],
      tags: [],
      release,
    },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub, ModalDialog: ModalDialogStub },
    },
  });
  await wrapper.setProps({ open: true });
  await nextTick();
  return wrapper;
}

/**
 * Editing a release always emits `targetCommitish` and `hideArchiveLinks`, and
 * the host applies whatever it receives. Seeding them from the default branch
 * and `false` therefore repointed `target_commitish` and re-enabled the archive
 * links on an edit that only touched the notes.
 */
describe('RepoRefFormDialog release edit seeds its own target and archive-link flag', () => {
  it('sends back the target and flag the release is being edited with', async () => {
    const wrapper = await mountDialog();

    await wrapper.get('form').trigger('submit');
    await nextTick();

    const payload = wrapper.emitted('submit')?.[0]?.[0] as Record<string, unknown>;
    expect(payload.tagName).toBe('v1.2.0');
    expect(payload.body).toBe('notes');
    expect(payload.targetCommitish).toBe('develop');
    expect(payload.hideArchiveLinks).toBe(true);
    wrapper.unmount();
  });

  it('keeps the user explicit choice over the seeded value', async () => {
    const wrapper = await mountDialog();

    const target = wrapper.get('.target-input');
    (target.element as HTMLInputElement).value = 'main';
    await target.trigger('input');
    const hideArchive = wrapper.findAll('.checkbox-field vscode-checkbox')[1];
    (hideArchive.element as HTMLInputElement).checked = false;
    await hideArchive.trigger('change');

    await wrapper.get('form').trigger('submit');
    await nextTick();

    const payload = wrapper.emitted('submit')?.[0]?.[0] as Record<string, unknown>;
    expect(payload.targetCommitish).toBe('main');
    expect(payload.hideArchiveLinks).toBe(false);
    wrapper.unmount();
  });
});
