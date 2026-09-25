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

/**
 * A completion reply carries the context its request was started with
 * (`instanceId`/`owner`/`repo`/`index`), which is how the editor tells its own
 * answer from one meant for the line/PR the singleton panel showed before.
 */
const OWN_IDENTITY = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 2 };

function dispatchHostReply(command: string, data: Record<string, unknown> = OWN_IDENTITY) {
  window.dispatchEvent(new MessageEvent('message', { data: { command, ...data } }));
}

/** A command that carries no identity at all (`queryPullReviewCommentDraft`). */
function dispatchBareReply(command: string) {
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

    dispatchBareReply('queryPullReviewCommentDraft');
    await nextTick();

    expect(postMessageMock).toHaveBeenCalledWith({ command: 'pullReviewCommentDraftState', dirty: false });
  });

  it('answers dirty when the editor holds an unsubmitted draft', async () => {
    const wrapper = mountEditor(createContext());
    await wrapper.find('[data-stub="easymde"]').setValue('work in progress');

    dispatchBareReply('queryPullReviewCommentDraft');
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

/**
 * The panel is a singleton: the host reuses it for another line or pull request,
 * and a request posted for the *previous* context can still answer after the
 * switch. Resetting `submitting` on the command name alone therefore released the
 * guard of the editor now on screen, whose next click posted a second comment or
 * review — the duplicate the guard exists to prevent. The reply has to carry the
 * context it was started for, and the editor has to compare it with its own.
 */
describe('PullReviewCommentEditor completion-reply attribution', () => {
  beforeEach(() => {
    postMessageMock.mockClear();
  });

  it('does not release the guard for a comment reply from another context', async () => {
    const wrapper = mountEditor(createContext());
    await wrapper.find('[data-stub="easymde"]').setValue('hello');
    const submitButton = wrapper.findAll('vscode-button')[0];

    await submitButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(1);

    // The reply answers the editor the host had open before this one (a
    // different line of the same pull request).
    dispatchHostReply('pullReviewCommentSubmitted', { ...OWN_IDENTITY, index: 3 });
    await nextTick();
    await submitButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(1);

    // Its own reply is what releases the guard.
    dispatchHostReply('pullReviewCommentSubmitted');
    await nextTick();
    await submitButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('does not release the guard for a review-submit reply from another instance', async () => {
    const wrapper = mountEditor(createContext({ mode: 'review', pendingReviewId: 5 }));

    // Buttons: addToReview, submitReview, cancelReview, close.
    const submitReviewButton = wrapper.findAll('vscode-button')[1];
    await submitReviewButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(1);

    dispatchHostReply('pullReviewSubmitted', { ...OWN_IDENTITY, instanceId: 'inst-2' });
    await nextTick();
    await submitReviewButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(1);

    dispatchHostReply('pullReviewSubmitted');
    await nextTick();
    await submitReviewButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('does not release the guard for a review-delete reply from another repository', async () => {
    const wrapper = mountEditor(createContext({ mode: 'review', pendingReviewId: 5 }));

    const cancelButton = wrapper.findAll('vscode-button')[2];
    await cancelButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(1);

    dispatchHostReply('pullReviewDeleted', { ...OWN_IDENTITY, repo: 'other-repo' });
    await nextTick();
    await cancelButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(1);

    // A declined confirm is this editor's own answer: it releases the guard.
    dispatchHostReply('pullReviewDeleted', { ...OWN_IDENTITY, cancelled: true });
    await nextTick();
    await cancelButton.trigger('click');
    expect(postMessageMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});

/**
 * The completion message is the only thing that releases `submitting`, and this
 * panel posts with `postMessage` directly — it is not covered by the main
 * panel's `registerPending` timeout. A host that never answers would leave the
 * buttons disabled for the rest of the session, so the editor arms its own
 * one-minute fallback.
 */
describe('PullReviewCommentEditor submit timeout', () => {
  beforeEach(() => {
    postMessageMock.mockClear();
  });

  it('releases the guard when the host never answers', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountEditor(createContext());
      await wrapper.find('[data-stub="easymde"]').setValue('hello');
      const submitButton = wrapper.findAll('vscode-button')[0];

      await submitButton.trigger('click');
      expect(postMessageMock).toHaveBeenCalledTimes(1);

      // A click inside the timeout window is still guarded.
      await vi.advanceTimersByTimeAsync(59_000);
      await submitButton.trigger('click');
      expect(postMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await submitButton.trigger('click');
      expect(postMessageMock).toHaveBeenCalledTimes(2);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release the guard a second time after a real answer cleared the timer', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountEditor(createContext({ mode: 'review', pendingReviewId: 5 }));

      // Buttons: addToReview, submitReview, cancelReview, close.
      const cancelButton = wrapper.findAll('vscode-button')[2];
      await cancelButton.trigger('click');
      expect(postMessageMock).toHaveBeenCalledTimes(1);

      dispatchHostReply('pullReviewDeleted');
      await nextTick();

      // The answer cleared the fallback timer: a new request posted after the
      // original window must stay guarded by its own timer, not be released
      // early by the previous one's.
      await vi.advanceTimersByTimeAsync(30_000);
      await cancelButton.trigger('click');
      expect(postMessageMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(31_000);
      await cancelButton.trigger('click');
      expect(postMessageMock).toHaveBeenCalledTimes(2);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
