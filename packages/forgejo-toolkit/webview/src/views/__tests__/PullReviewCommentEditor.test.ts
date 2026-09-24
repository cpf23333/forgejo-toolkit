import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import PullReviewCommentEditor from '../PullReviewCommentEditor.vue';
import type { PullReviewCommentContext } from '../../types/config';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { postMessageMock, stateMock } = vi.hoisted(() => ({
  postMessageMock: vi.fn(),
  stateMock: {
    uploadIssueAttachment: vi.fn(),
  },
}));

vi.mock('../../composables/vscode', () => ({
  postMessage: postMessageMock,
}));

vi.mock('../../composables/useAppState', () => ({
  useAppState: () => stateMock,
}));

// Stand in for the heavy markdown editor with a plain v-model textarea.
const EasyMdeStub = defineComponent({
  name: 'EasyMdeEditor',
  props: {
    modelValue: { type: String, default: '' },
    uploadImage: { type: Function, default: undefined },
  },
  emits: ['update:modelValue'],
  template:
    '<textarea data-stub="easymde" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

function createContext(overrides?: Partial<PullReviewCommentContext>): PullReviewCommentContext {
  return {
    instanceId: 'inst-1',
    owner: 'owner',
    repo: 'repo',
    index: 2,
    path: 'src/index.ts',
    position: 2,
    isBase: false,
    lineNumber: 1,
    mode: 'single',
    ...overrides,
  };
}

function mountEditor(context: PullReviewCommentContext) {
  return mount(PullReviewCommentEditor, {
    props: { context },
    global: {
      plugins: [createTestI18n('en')],
      // vscode-* elements compile to native custom elements, so they cannot be
      // stubbed by name; select the rendered <vscode-button> tags directly.
      stubs: { EasyMdeEditor: EasyMdeStub },
    },
  });
}

function dispatchHostReply(command: string) {
  window.dispatchEvent(new MessageEvent('message', { data: { command } }));
}

describe('PullReviewCommentEditor submit guard', () => {
  beforeEach(() => {
    postMessageMock.mockClear();
  });

  it('sends the comment only once until the host answers', async () => {
    const wrapper = mountEditor(createContext());
    await wrapper.find('[data-stub="easymde"]').setValue('hello');

    const submitButton = wrapper.findAll('vscode-button')[0];
    await submitButton.trigger('click');
    await submitButton.trigger('click');

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'submitPullReviewComment' }));

    dispatchHostReply('pullReviewCommentSubmitted');
    await nextTick();
    await submitButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(2);
  });

  it('guards submitReview until the host answers', async () => {
    const wrapper = mountEditor(createContext({ mode: 'review', pendingReviewId: 5 }));

    // Buttons: addToReview, submitReview, cancelReview, close.
    const submitReviewButton = wrapper.findAll('vscode-button')[1];
    await submitReviewButton.trigger('click');
    await submitReviewButton.trigger('click');

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'submitPullReview', reviewId: 5 }));

    dispatchHostReply('pullReviewSubmitted');
    await nextTick();
    await submitReviewButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(2);
  });

  it('guards cancelReview and resets when the host reports a declined confirm', async () => {
    const wrapper = mountEditor(createContext({ mode: 'review', pendingReviewId: 5 }));

    const cancelButton = wrapper.findAll('vscode-button')[2];
    await cancelButton.trigger('click');
    await cancelButton.trigger('click');

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'deletePullReview', reviewId: 5 }));

    dispatchHostReply('pullReviewDeleted');
    await nextTick();
    await cancelButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(2);
  });
});

describe('PullReviewCommentEditor draft-state query', () => {
  beforeEach(() => {
    postMessageMock.mockClear();
  });

  it('answers clean when the body is empty or whitespace', async () => {
    mountEditor(createContext());

    dispatchHostReply('queryPullReviewCommentDraft');
    await nextTick();

    expect(postMessageMock).toHaveBeenCalledWith({ command: 'pullReviewCommentDraftState', dirty: false });
  });

  it('answers dirty when the editor holds an unsubmitted draft', async () => {
    const wrapper = mountEditor(createContext());
    await wrapper.find('[data-stub="easymde"]').setValue('work in progress');

    dispatchHostReply('queryPullReviewCommentDraft');
    await nextTick();

    expect(postMessageMock).toHaveBeenCalledWith({ command: 'pullReviewCommentDraftState', dirty: true });
  });
});

describe('PullReviewCommentEditor review conclusion label', () => {
  /**
   * The conclusion radio group's label was a sibling `<span>`, so the group
   * itself was announced unnamed. The element exposes no `label` prop (unlike the
   * selects elsewhere in the webview), so the span is associated by id.
   */
  it('associates the visible label with the review conclusion group', () => {
    const wrapper = mountEditor(createContext({ mode: 'review', pendingReviewId: 5 }));

    const group = wrapper.get('vscode-radio-group');
    const labelledBy = group.attributes('aria-labelledby');
    expect(labelledBy).toBe('pull-review-event-label');
    expect(wrapper.get(`#${labelledBy}`).text()).toBe('Review conclusion');
    wrapper.unmount();
  });

  it('leaves the group unrendered outside review mode', () => {
    const wrapper = mountEditor(createContext({ mode: 'single' }));

    expect(wrapper.find('vscode-radio-group').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('PullReviewCommentEditor line label', () => {
  it('shows a single line for single-line comments', () => {
    const wrapper = mountEditor(createContext({ lineNumber: 4 }));
    expect(wrapper.find('.context-line').text()).toBe('Line 5');
  });

  it('shows the line range for multi-line comments', () => {
    const wrapper = mountEditor(createContext({ lineNumber: 4, extraLinesCount: 3 }));
    expect(wrapper.find('.context-line').text()).toBe('Lines 5–8');
  });
});

/**
 * The editor uploads an image and inserts `![image](url)` into the body only
 * when the request returns: two independent round-trips. Submitting the review
 * comment while the upload is still in flight would send a body that predates
 * the image, and the markdown the user just inserted would never reach the
 * host. The submit must wait for the upload (the same tracker the edit forms
 * use).
 */
describe('PullReviewCommentEditor submit waits for an in-flight image upload', () => {
  beforeEach(() => {
    postMessageMock.mockClear();
    stateMock.uploadIssueAttachment.mockReset();
  });

  it('sends the body the editor holds once the upload has inserted its image', async () => {
    let resolveUpload!: (attachment: { browser_download_url?: string; uuid: string }) => void;
    stateMock.uploadIssueAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const wrapper = mountEditor(createContext());
    await wrapper.find('[data-stub="easymde"]').setValue('see this');

    const uploadImage = wrapper.findComponent(EasyMdeStub).props('uploadImage') as (
      file: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => void;
    uploadImage(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      (url) => {
        // What EasyMdeEditor's imageUploadFunction does on success.
        void wrapper.find('[data-stub="easymde"]').setValue(`see this\n\n![image](${url})`);
      },
      () => {},
    );
    await nextTick();

    // The submit is issued while the upload is running.
    await wrapper.findAll('vscode-button')[0].trigger('click');
    await nextTick();

    expect(postMessageMock).not.toHaveBeenCalled();

    resolveUpload({ uuid: 'uuid-1' });
    await flushPromises();

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'submitPullReviewComment',
        body: 'see this\n\n![image](/attachments/uuid-1)',
      }),
    );
    wrapper.unmount();
  });

  it('sends immediately when no upload is in flight', async () => {
    const wrapper = mountEditor(createContext());
    await wrapper.find('[data-stub="easymde"]').setValue('plain comment');

    await wrapper.findAll('vscode-button')[0].trigger('click');

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'submitPullReviewComment', body: 'plain comment' }),
    );
    wrapper.unmount();
  });
});
