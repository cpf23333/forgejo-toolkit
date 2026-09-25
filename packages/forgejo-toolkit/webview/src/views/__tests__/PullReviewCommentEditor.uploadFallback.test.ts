import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import PullReviewCommentEditor from '../PullReviewCommentEditor.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n, createTestRouter } from '../../__tests__/helpers/test-utils';
import type { PullReviewCommentContext } from '../../types/config';
import type { ForgejoIssueAttachment } from '../../types/api';

type UploadFn = (file: File, onSuccess: (url: string) => void, onError: (error: string) => void) => void;

let capturedUpload: UploadFn | undefined;

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  setup(props) {
    capturedUpload = props.uploadImage as UploadFn | undefined;
    return () => h('textarea');
  },
});

const context: PullReviewCommentContext = {
  instanceId: 'inst-1',
  owner: 'owner',
  repo: 'repo',
  index: 2,
  path: 'src/index.ts',
  position: 2,
  isBase: false,
  lineNumber: 1,
  mode: 'review',
};

function mountEditor() {
  return mount(PullReviewCommentEditor, {
    props: { context },
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub },
    },
  });
}

/**
 * The upload reply's relative uuid path is preferred over the absolute
 * `browser_download_url`: the host rewrites `/attachments/<uuid>` against the
 * current instance at render time, while an absolute URL stored in the comment
 * body dies when the instance's domain changes. And a reply with neither
 * identifier cannot be linked: inserting `/attachments/undefined` would leave
 * a dead image in the body, so it reports a failure instead (the same fallback
 * IssueDetail's upload handler takes).
 */
describe('PullReviewCommentEditor uploadImage URL fallback', () => {
  beforeEach(() => {
    capturedUpload = undefined;
  });

  function mockUploadReply(attachment: Partial<ForgejoIssueAttachment>) {
    const state = useAppState();
    state.uploadIssueAttachment = vi.fn(() =>
      Promise.resolve(attachment as ForgejoIssueAttachment),
    ) as typeof state.uploadIssueAttachment;
  }

  it('reports a failure instead of inserting /attachments/undefined', async () => {
    const wrapper = mountEditor();
    mockUploadReply({});

    const onSuccess = vi.fn();
    const onError = vi.fn();
    capturedUpload!(new File(['x'], 'shot.png', { type: 'image/png' }), onSuccess, onError);
    await flushPromises();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Failed to upload image');
    wrapper.unmount();
  });

  it('prefers the relative uuid path when the reply carries both identifiers', async () => {
    const wrapper = mountEditor();
    mockUploadReply({ uuid: 'abc-123', browser_download_url: 'https://forgejo.example.com/dl/1' });

    const onSuccess = vi.fn();
    const onError = vi.fn();
    capturedUpload!(new File(['x'], 'shot.png', { type: 'image/png' }), onSuccess, onError);
    await flushPromises();

    expect(onSuccess).toHaveBeenCalledWith('/attachments/abc-123');
    expect(onError).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('falls back to browser_download_url when the uuid is absent', async () => {
    const wrapper = mountEditor();
    mockUploadReply({ browser_download_url: 'https://forgejo.example.com/dl/1' });

    const onSuccess = vi.fn();
    const onError = vi.fn();
    capturedUpload!(new File(['x'], 'shot.png', { type: 'image/png' }), onSuccess, onError);
    await flushPromises();

    expect(onSuccess).toHaveBeenCalledWith('https://forgejo.example.com/dl/1');
    expect(onError).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
