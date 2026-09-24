import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';

const COMMENT_REACTIONS_KEY = 'inst-1:owner/repo:comment:7:reactions';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    commentReactions: { value: new Map<string, unknown[]>() },
    instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
    loadCommentReactions: vi.fn(),
    changeCommentReaction: vi.fn(),
    renderMarkdown: vi.fn(async () => '<p>body</p>'),
    openExternal: vi.fn(),
    deleteIssueComment: vi.fn(),
    editIssueComment: vi.fn(),
    uploadIssueCommentAttachment: vi.fn(),
    deleteIssueCommentAttachment: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    commentReactionsKey: (instanceId: string, owner: string, repo: string, commentId: number) =>
      `${instanceId}:${owner}/${repo}:comment:${commentId}:reactions`,
    issueCommentEditFormKey: (instanceId: string, owner: string, repo: string, commentId: number) =>
      `${instanceId}:${owner}/${repo}:comment-${commentId}:edit`,
    issueCommentDeleteFormKey: (instanceId: string, owner: string, repo: string, commentId: number) =>
      `${instanceId}:${owner}/${repo}:comment-${commentId}:delete-form`,
  };
});

import CommentTimeline from '../CommentTimeline.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoTimelineComment } from '../../types/api';

// The mocked composable returns the reactive wrapper; mutating through it is what
// a real host reply does, and is what the component's computeds track.
const state = useAppState() as unknown as typeof stateMock;

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" :value="modelValue" />',
});

const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: { open: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
  template: '<div class="modal-dialog-stub"><slot /></div>',
});

/**
 * A comment's reaction bar is the third `ReactionBar` call site, and it was the
 * one that never received the `error` prop. The composable writes a failed
 * comment-reaction load *and* a failed toggle to this comment's
 * `commentReactionsKey`, and the host sends no toast, so the failure was read by
 * nothing: the row the user tried to react to kept its previous state and the
 * reason was invisible. The other two bars (`IssueDetail`, `PullRequestDetail`)
 * already passed it.
 */
describe('CommentTimeline comment reaction errors', () => {
  const comment: ForgejoTimelineComment = {
    id: 7,
    type: 'comment',
    body: 'a comment',
    created_at: '2026-01-01T00:00:00Z',
    user: {
      id: 1,
      login: 'demo-user',
      full_name: 'Demo User',
      email: 'demo-user@forgejo.example.com',
      avatar_url: 'https://forgejo.example.com/avatars/demo-user',
    },
  };

  function mountTimeline() {
    return mount(CommentTimeline, {
      props: {
        comments: [comment],
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 1,
      },
      global: {
        plugins: [createTestI18n('en')],
        stubs: { EasyMdeEditor: EasyMdeEditorStub, ModalDialog: ModalDialogStub },
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    state.errors.clear();
    state.loading.clear();
    state.commentReactions.value.clear();
  });

  it('shows the reason a comment-reaction load failed', async () => {
    const wrapper = mountTimeline();
    await nextTick();

    // The host answers the load with a failure on this comment's reactions key.
    state.errors.set(COMMENT_REACTIONS_KEY, 'network down');
    await nextTick();

    const error = wrapper.find('.reaction-error');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('Reactions failed: network down');

    wrapper.unmount();
  });

  it('shows the reason a comment-reaction toggle failed', async () => {
    const wrapper = mountTimeline();
    await nextTick();

    // The user adds a reaction from the picker; the host rejects the change.
    await wrapper.find('.reaction-picker-item').trigger('click');
    expect(state.changeCommentReaction).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 7, '+1', true);

    state.errors.set(COMMENT_REACTIONS_KEY, 'forbidden');
    await nextTick();

    expect(wrapper.find('.reaction-error').text()).toContain('Reactions failed: forbidden');

    wrapper.unmount();
  });

  it('stays silent while the reaction requests succeed', async () => {
    state.commentReactions.value.set(COMMENT_REACTIONS_KEY, [{ content: '+1', user: { login: 'other' } }]);

    const wrapper = mountTimeline();
    await nextTick();

    expect(wrapper.find('.reaction-error').exists()).toBe(false);
    expect(wrapper.text()).toContain('👍');

    wrapper.unmount();
  });
});
