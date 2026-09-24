import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';

const { showConfirmMock } = vi.hoisted(() => ({
  showConfirmMock: vi.fn(),
}));

vi.mock('../../composables/useAppState', () => ({
  useAppState: () => ({ showConfirm: showConfirmMock }),
}));

import ModalDialog from '../ModalDialog.vue';
import PullRequestForm from '../PullRequestForm.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

// The form hands this handler to the editor, so the test can start an upload and
// leave it in flight (which is what the real attachment upload does for seconds).
const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" :value="modelValue" />',
});

interface PendingUpload {
  file: File;
  resolve: (url: string) => void;
  reject: (error: string) => void;
}

/**
 * The real form inside the real modal, wired the way the pull request views wire
 * them: the form's `dirty` output feeds the dialog's `is-dirty` guard, which is
 * what decides whether closing asks first.
 */
function mountDialog() {
  const uploads: PendingUpload[] = [];
  function uploadImage(file: File, onSuccess: (url: string) => void, onError: (error: string) => void): void {
    uploads.push({ file, resolve: onSuccess, reject: onError });
  }

  const Harness = defineComponent({
    name: 'PullRequestDialogHarness',
    components: { ModalDialog, PullRequestForm },
    setup() {
      const open = ref(true);
      const dirty = ref(false);
      return { open, dirty, uploadImage };
    },
    template: `
      <ModalDialog
        :open="open"
        title="Edit pull request"
        :confirm-close-if-dirty="true"
        :is-dirty="dirty"
        @close="open = false"
      >
        <PullRequestForm
          mode="edit"
          initial-title="a title"
          initial-body="a body"
          initial-base="main"
          submit-label="Save"
          :upload-image="uploadImage"
          @dirty="dirty = $event"
        />
      </ModalDialog>
    `,
  });

  const wrapper = mount(Harness, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub, DateTimePicker: true },
    },
  });

  /** Picks an image in the editor and leaves its upload in flight. */
  function startUpload(): PendingUpload {
    const handler = wrapper.findComponent({ name: 'EasyMdeEditor' }).props('uploadImage') as (
      file: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => void;
    expect(handler, 'tracked upload handler').toBeTypeOf('function');
    handler(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      () => {},
      () => {},
    );
    const upload = uploads.at(-1);
    expect(upload, 'started upload').toBeTruthy();
    return upload!;
  }

  return { wrapper, startUpload };
}

/**
 * `PullRequestForm` tracks in-flight image uploads for its submit button, but its
 * `dirty` output only looked at the fields: an upload still running did not make
 * the form dirty, so the pull request create/edit dialog closed without asking
 * and threw away an image whose markdown the editor inserts only when the request
 * returns. The edit dialog mirrored the upload count in the view as a workaround;
 * the form itself is where the state belongs (as `IssueForm` already does).
 */
describe('PullRequestForm dirty while an image upload is in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showConfirmMock.mockReset();
    showConfirmMock.mockResolvedValue(true);
    if (typeof HTMLDialogElement !== 'undefined') {
      HTMLDialogElement.prototype.showModal = vi.fn();
      HTMLDialogElement.prototype.close = vi.fn();
    }
  });

  it('reports the dialog dirty while an upload runs and clean again once it lands', async () => {
    const { wrapper, startUpload } = mountDialog();
    await nextTick();
    expect(wrapper.findComponent(ModalDialog).props('isDirty')).toBe(false);

    const upload = startUpload();
    await nextTick();
    expect(wrapper.findComponent(ModalDialog).props('isDirty')).toBe(true);

    // The upload's markdown is inserted when it answers: only then is there
    // nothing left to lose.
    upload.resolve('/attachments/uuid-1');
    await flushPromises();
    await nextTick();

    expect(wrapper.findComponent(ModalDialog).props('isDirty')).toBe(false);
    wrapper.unmount();
  });

  it('asks before closing while an image upload runs and stays open when declined', async () => {
    showConfirmMock.mockResolvedValue(false);
    const { wrapper, startUpload } = mountDialog();
    await nextTick();
    const upload = startUpload();
    await nextTick();

    await wrapper.find('.modal-close').trigger('click');
    await flushPromises();

    // Declining the discard prompt keeps the dialog (and the upload) open.
    expect(showConfirmMock).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(ModalDialog).props('open')).toBe(true);

    // Confirming the prompt is the way out that keeps the promise the prompt made.
    showConfirmMock.mockResolvedValue(true);
    await wrapper.find('.modal-close').trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(ModalDialog).props('open')).toBe(false);

    upload.resolve('/attachments/uuid-1');
    await flushPromises();
    wrapper.unmount();
  });

  it('closes a clean dialog immediately without asking', async () => {
    const { wrapper } = mountDialog();
    await nextTick();

    await wrapper.find('.modal-close').trigger('click');
    await flushPromises();

    expect(showConfirmMock).not.toHaveBeenCalled();
    expect(wrapper.findComponent(ModalDialog).props('open')).toBe(false);
    wrapper.unmount();
  });
});
