import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import EasyMdeEditor from '../EasyMdeEditor.vue';
import en from '../../i18n/en.json';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

// jsdom has no IntersectionObserver; EasyMdeEditor uses one to refresh
// CodeMirror when the wrapper scrolls into view.
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

// jsdom's Range does not implement getBoundingClientRect/getClientRects, which
// CodeMirror 5 calls while measuring.
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

type UploadHandler = (file: File, onSuccess: (url: string) => void, onError: (error: string) => void) => void;

/**
 * A failed image upload used to leave no trace at all: EasyMDE's status bar is
 * turned off (`status: false`), and its `errorCallback` - the only surface left -
 * was overridden with an empty body on the belief that the host toasts permission
 * errors. The host does not: it answers `issueAttachmentCreated` with `error`.
 * Picking an image with a token lacking `write:issue` (or on any transient
 * failure) inserted nothing and said nothing.
 */
describe('EasyMdeEditor image upload failures', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
    Range.prototype.getBoundingClientRect = () => EMPTY_RECT;
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mountEditor(uploadImage: UploadHandler) {
    return mount(EasyMdeEditor, {
      props: { modelValue: '', uploadImage },
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
    // The `upload-image` toolbar action opens the browse-file window, which is
    // what wires the hidden input's change handler.
    const button = wrapper.find('.editor-toolbar button.upload-image');
    expect(button.exists(), 'upload-image toolbar button').toBe(true);
    await button.trigger('click');

    const input = wrapper.find('input.imageInput').element as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await nextTick();
  }

  it('says the upload failed instead of silently inserting nothing', async () => {
    const uploadImage = vi.fn<UploadHandler>((_file, _onSuccess, onError) => {
      onError('403: token is missing the write:issue scope');
    });
    const wrapper = mountEditor(uploadImage);

    await pickImage(wrapper, new File(['x'], 'shot.png', { type: 'image/png' }));
    await flushPromises();

    expect(uploadImage).toHaveBeenCalledTimes(1);
    const line = wrapper.find('.image-upload-error');
    expect(line.exists()).toBe(true);
    expect(line.text()).toContain('403: token is missing the write:issue scope');

    wrapper.unmount();
  });

  it('reports the editor’s own rejection of a non-image file', async () => {
    const uploadImage = vi.fn<UploadHandler>();
    const wrapper = mountEditor(uploadImage);

    await pickImage(wrapper, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    await flushPromises();

    // The upload handler is never reached; the type check's own rejection is what
    // used to be swallowed.
    expect(uploadImage).not.toHaveBeenCalled();
    expect(wrapper.find('.image-upload-error').text()).toContain('Only image files can be uploaded');

    wrapper.unmount();
  });

  it('clears the failure once a later upload succeeds', async () => {
    let attempt = 0;
    const uploadImage = vi.fn<UploadHandler>((_file, onSuccess, onError) => {
      attempt += 1;
      if (attempt === 1) {
        onError('upload failed');
        return;
      }
      onSuccess('/attachments/uuid-1');
    });
    const wrapper = mountEditor(uploadImage);

    await pickImage(wrapper, new File(['x'], 'shot.png', { type: 'image/png' }));
    await flushPromises();
    expect(wrapper.find('.image-upload-error').exists()).toBe(true);

    await pickImage(wrapper, new File(['x'], 'shot.png', { type: 'image/png' }));
    await flushPromises();

    expect(wrapper.find('.image-upload-error').exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toContain('![image](/attachments/uuid-1)');

    wrapper.unmount();
  });

  /**
   * The line the user reads is the editor's own, and it has to state the failure
   * once. The guard tests around the call sites only assert the reason the view
   * hands over, so these render the real editor.
   */
  it('shows an Error-derived reason once, after the banner prefix', async () => {
    const uploadImage = vi.fn<UploadHandler>((_file, _onSuccess, onError) => {
      const failure = new Error('403: token is missing the write:issue scope');
      onError(failure instanceof Error ? failure.message : String(failure));
    });
    const wrapper = mountEditor(uploadImage);

    await pickImage(wrapper, new File(['x'], 'shot.png', { type: 'image/png' }));
    await flushPromises();

    expect(wrapper.get('.image-upload-error').text()).toBe(
      'Image upload failed: 403: token is missing the write:issue scope',
    );
    wrapper.unmount();
  });

  it('states a failure with no reason of its own once, instead of doubling it', async () => {
    // The no-URL path hands over `common.imageUploadFailed` ("Failed to upload
    // image"), which the banner's own prefix turned into "Image upload failed:
    // Failed to upload image".
    const generic = en.common.imageUploadFailed;
    const uploadImage = vi.fn<UploadHandler>((_file, _onSuccess, onError) => {
      onError(generic);
    });
    const wrapper = mountEditor(uploadImage);

    await pickImage(wrapper, new File(['x'], 'shot.png', { type: 'image/png' }));
    await flushPromises();

    const text = wrapper.get('.image-upload-error').text();
    expect(text).toBe(generic);
    expect(text).not.toContain('Image upload failed:');
    wrapper.unmount();
  });
});
