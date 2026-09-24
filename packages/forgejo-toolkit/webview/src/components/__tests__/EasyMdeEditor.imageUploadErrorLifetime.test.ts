import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import EasyMdeEditor from '../EasyMdeEditor.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

type UploadHandler = (file: File, onSuccess: (url: string) => void, onError: (message: string) => void) => void;

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const EMPTY_RECT = {
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as unknown as DOMRect;

/**
 * The edit-comment dialog keeps one editor instance and re-seeds it with the body
 * of the comment currently being edited. `imageUploadError` was cleared only by a
 * new attempt or a success, so after one failed upload the "Image upload failed:
 * …" line was still shown when the dialog was reopened for a different comment —
 * the failure belonged to a comment the user had already left.
 */
describe('EasyMdeEditor image upload error lifetime', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
    Range.prototype.getBoundingClientRect = () => EMPTY_RECT;
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mountEditor(modelValue: string, uploadImage: UploadHandler) {
    return mount(EasyMdeEditor, {
      props: { modelValue, uploadImage },
      global: { plugins: [createTestI18n('en')] },
    });
  }

  /** Waits for the lazily imported EasyMDE to build the toolbar. */
  async function toolbar(wrapper: ReturnType<typeof mountEditor>) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = wrapper.find('.editor-toolbar');
      if (found.exists()) {
        return found;
      }
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('EasyMDE did not initialise');
  }

  /** Picks one file through the toolbar's own upload-image input. */
  async function pickImage(wrapper: ReturnType<typeof mountEditor>, file: File) {
    await toolbar(wrapper);
    const button = wrapper.find('.editor-toolbar button.upload-image');
    expect(button.exists(), 'upload-image toolbar button').toBe(true);
    await button.trigger('click');

    const input = wrapper.find('input.imageInput').element as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await nextTick();
  }

  it('clears a failed upload’s error when the editor is re-seeded for another comment', async () => {
    const uploadImage = vi.fn<UploadHandler>((_file, _onSuccess, onError) => {
      onError('403: token is missing the write:issue scope');
    });
    const wrapper = mountEditor('comment A body', uploadImage);

    await pickImage(wrapper, new File(['x'], 'shot.png', { type: 'image/png' }));
    await flushPromises();
    expect(wrapper.get('.image-upload-error').text()).toContain('403: token is missing the write:issue scope');

    // The dialog is reopened for a different comment: the shared instance is
    // re-seeded with its body, so the previous comment's failure is stale.
    await wrapper.setProps({ modelValue: 'comment B body' });
    await nextTick();

    expect(wrapper.find('.image-upload-error').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps the error for the comment it belongs to', async () => {
    // The lifetime fix must not hide the failure from the comment still open: no
    // re-seed happens until the bound value changes from the outside.
    const uploadImage = vi.fn<UploadHandler>((_file, _onSuccess, onError) => {
      onError('upload failed');
    });
    const wrapper = mountEditor('comment A body', uploadImage);

    await pickImage(wrapper, new File(['x'], 'shot.png', { type: 'image/png' }));
    await flushPromises();

    expect(wrapper.find('.image-upload-error').exists()).toBe(true);
    wrapper.unmount();
  });
});
