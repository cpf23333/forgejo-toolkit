import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, onMounted } from 'vue';
import PullReviewCommentPanel from '../PullReviewCommentPanel.vue';
import type { PullReviewCommentContext } from '../types/config';

const mountedContexts: PullReviewCommentContext[] = [];

const EditorStub = defineComponent({
  name: 'PullReviewCommentEditor',
  props: { context: { type: Object, required: true } },
  setup(props) {
    onMounted(() => mountedContexts.push(props.context as PullReviewCommentContext));
    return () => h('div', { 'data-stub': 'pull-review-comment-editor' });
  },
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
    mode: 'review',
    ...overrides,
  };
}

function dispatchContext(context: PullReviewCommentContext) {
  window.dispatchEvent(new MessageEvent('message', { data: { command: 'openPullReviewCommentEditor', ...context } }));
}

describe('PullReviewCommentPanel', () => {
  beforeEach(() => {
    mountedContexts.length = 0;
    window.__FORGEJO_TOOLKIT_CONFIG__ = { pullReviewComment: createContext() };
  });

  it('rebuilds the editor when the panel is reused for another line', async () => {
    const wrapper = mount(PullReviewCommentPanel, {
      global: { stubs: { PullReviewCommentEditor: EditorStub } },
    });
    expect(mountedContexts).toHaveLength(1);

    dispatchContext(createContext({ lineNumber: 9, position: 10 }));
    await nextTick();

    // A new editor instance must be created so the draft and pendingReviewId
    // of the previous line cannot leak into this one.
    expect(mountedContexts).toHaveLength(2);
    expect(mountedContexts[1].lineNumber).toBe(9);
    wrapper.unmount();
  });

  it('rebuilds the editor when the pending review id changes for the same line', async () => {
    const wrapper = mount(PullReviewCommentPanel, {
      global: { stubs: { PullReviewCommentEditor: EditorStub } },
    });

    dispatchContext(createContext({ pendingReviewId: 7 }));
    await nextTick();

    expect(mountedContexts).toHaveLength(2);
    wrapper.unmount();
  });

  it('keeps the editor instance when an identical context is re-sent', async () => {
    const wrapper = mount(PullReviewCommentPanel, {
      global: { stubs: { PullReviewCommentEditor: EditorStub } },
    });

    dispatchContext(createContext());
    await nextTick();

    expect(mountedContexts).toHaveLength(1);
    wrapper.unmount();
  });
});
