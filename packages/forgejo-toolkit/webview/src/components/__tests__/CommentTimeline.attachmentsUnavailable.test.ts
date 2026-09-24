import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    commentReactions: { value: new Map<string, unknown[]>() },
    instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
    loadCommentReactions: vi.fn(),
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
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoTimelineComment } from '../../types/api';

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
 * A comment whose attachment list failed to load. The host looks the attachments
 * up per comment (`pullRequestCommentsAndTimeline` items may carry
 * `attachmentsUnavailable`), and a failed lookup leaves `assets` empty — which is
 * exactly what a comment with no attachments looks like. The row used to render
 * nothing at all, so the user concluded their attachment had been deleted.
 *
 * The host's own half may not be wired yet, so these tests put the exact contract
 * field (`attachmentsUnavailable`) on the comment they pass in and assert on what
 * the timeline renders.
 */
describe('CommentTimeline unavailable attachments', () => {
  const comment: ForgejoTimelineComment = {
    id: 7,
    type: 'comment',
    body: 'has an attachment',
    created_at: '2026-01-01T00:00:00Z',
    assets: [],
    user: {
      id: 1,
      login: 'demo-user',
      full_name: 'Demo User',
      email: 'demo-user@forgejo.example.com',
      avatar_url: 'https://forgejo.example.com/avatars/demo-user',
    },
  };

  function mountTimeline(commentToRender: ForgejoTimelineComment) {
    return mount(CommentTimeline, {
      props: {
        comments: [commentToRender],
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

  it('says the attachment list could not be loaded instead of staying silent', async () => {
    const wrapper = mountTimeline({ ...comment, attachmentsUnavailable: true });
    await nextTick();

    const notice = wrapper.find('.comment-attachments-unavailable');
    expect(notice.exists()).toBe(true);
    // The text must not claim the attachment is gone: only the listing failed.
    expect(notice.text()).toContain('could not be loaded');
    expect(notice.text()).not.toContain('deleted');
    expect(notice.text()).not.toContain('no attachments');
    // The comment brought no assets, so the notice is the only attachment row:
    // there is no list to render alongside it.
    expect(wrapper.find('attachment-list-stub').exists()).toBe(false);

    wrapper.unmount();
  });

  it('says nothing about a loading failure when the reply does not flag one', async () => {
    const wrapper = mountTimeline({ ...comment });
    await nextTick();

    expect(wrapper.find('.comment-attachments-unavailable').exists()).toBe(false);

    wrapper.unmount();
  });

  it('still renders the attachments when the list loaded', async () => {
    const wrapper = mountTimeline({ ...comment, assets: [{ id: 9, name: 'shot.png' }] });
    await nextTick();

    expect(wrapper.find('.comment-attachments-unavailable').exists()).toBe(false);
    expect(wrapper.find('.comment-attachments').exists()).toBe(true);
    expect(wrapper.find('.comment-attachments').text()).toContain('shot.png');

    wrapper.unmount();
  });
});
