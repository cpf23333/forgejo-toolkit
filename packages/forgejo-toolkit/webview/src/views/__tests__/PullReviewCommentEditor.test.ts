import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import PullReviewCommentEditor from '../PullReviewCommentEditor.vue';
import type { PullReviewCommentContext } from '../../types/config';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { postMessageMock } = vi.hoisted(() => ({
  postMessageMock: vi.fn(),
}));

vi.mock('../../composables/vscode', () => ({
  postMessage: postMessageMock,
}));

vi.mock('../../composables/useAppState', () => ({
  useAppState: () => ({}),
}));

// Stand in for the heavy markdown editor with a plain v-model textarea.
const EasyMdeStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' } },
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
