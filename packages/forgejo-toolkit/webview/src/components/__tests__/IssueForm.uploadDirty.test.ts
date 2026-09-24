import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import IssueForm from '../IssueForm.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

// The form hands this handler to the editor through `trackedUploadImage`, so the
// test can start an upload and leave it in flight (which is what the real
// `uploadIssueAttachment` call does for seconds).
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

function mountForm() {
  const uploads: PendingUpload[] = [];
  const wrapper = mount(IssueForm, {
    props: {
      mode: 'edit',
      initialTitle: 'a title',
      initialBody: 'a body',
      submitLabel: 'Save',
      uploadImage: (file: File, onSuccess: (url: string) => void, onError: (error: string) => void): void => {
        uploads.push({ file, resolve: onSuccess, reject: onError });
      },
    },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub, DateTimePicker: true },
    },
  });

  /** Picks an image in the editor and leaves its upload in flight. */
  function startUpload(): PendingUpload {
    const uploadImage = wrapper.findComponent(EasyMdeEditorStub).props('uploadImage') as (
      file: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => void;
    expect(uploadImage, 'tracked upload handler').toBeTypeOf('function');
    uploadImage(
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
 * The dialog's `loading` no longer covers an image upload (it used to block
 * closing for the whole request), and `isDirty` only looked at the fields: an
 * upload in flight did not mark the form dirty, so closing the create/edit dialog
 * during one threw away an image whose markdown the editor inserts only when the
 * request returns. `CommentTimeline`'s edit dialog has the same shape
 * (`editCloseNeedsConfirm`).
 */
describe('IssueForm dirty while an image upload is in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a freshly opened form as clean', async () => {
    const { wrapper } = mountForm();
    await nextTick();

    expect(wrapper.emitted('dirty')).toEqual([[false]]);
    wrapper.unmount();
  });

  it('reports dirty while an upload runs and clean again once it lands', async () => {
    const { wrapper, startUpload } = mountForm();
    await nextTick();
    const upload = startUpload();
    await nextTick();

    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([true]);

    // The upload's markdown is inserted when it answers: only then is there
    // nothing left to lose.
    upload.resolve('/attachments/uuid-1');
    await flushPromises();
    await nextTick();

    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([false]);
    wrapper.unmount();
  });

  it('reports clean again when the upload fails', async () => {
    const { wrapper, startUpload } = mountForm();
    await nextTick();
    const upload = startUpload();
    await nextTick();
    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([true]);

    upload.reject('boom');
    await flushPromises();
    await nextTick();

    // A failed upload has nothing left to insert, so the form is not holding
    // unsaved work.
    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([false]);
    wrapper.unmount();
  });
});
