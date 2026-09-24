import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
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

// Keeps the editor's upload handler reachable from the test while still feeding
// `update:modelValue` back into the modal's body.
const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: {
    modelValue: { type: String, default: '' },
    uploadImage: { type: Function, default: undefined },
  },
  emits: ['update:modelValue'],
  template:
    '<textarea class="editor-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

// The attachment list's own upload path: the stub emits the same event the real
// component does, so the test drives `uploadAttachmentForEdit`.
const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: {
    assets: { type: Array, default: () => [] },
    allowUpload: { type: Boolean, default: false },
  },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

// jsdom's <dialog> has no showModal/close, and the real modal's open watcher
// throws on them; the edit form itself is what this test exercises.
const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: { open: { type: Boolean, default: false } },
  template: '<div class="modal-dialog-stub"><slot /></div>',
});

const comment: ForgejoTimelineComment = {
  id: 7,
  type: 'comment',
  body: 'original',
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
      stubs: {
        EasyMdeEditor: EasyMdeEditorStub,
        AttachmentList: AttachmentListStub,
        ModalDialog: ModalDialogStub,
      },
    },
  });
}

/** Opens the comment's edit modal through the kebab menu the user clicks. */
async function openEdit(wrapper: ReturnType<typeof mountTimeline>) {
  await wrapper.find('.comment-menu-wrapper button').trigger('click');
  await nextTick();
  const menu = wrapper.find('vscode-context-menu').element as HTMLElement & { data?: { value: string }[] };
  const edit = (menu.data ?? []).find((entry) => entry.value === 'edit');
  menu.dispatchEvent(new CustomEvent('vsc-context-menu-select', { detail: { value: edit?.value } }));
  await nextTick();
}

/**
 * Editing a comment spans two round-trips (the save, then the attachment
 * upload). The attachment list uploads into the same comment the edit form is
 * showing, and its reply is what the form lists; a save issued while the upload
 * is in flight would send the comment without the attachment the user just
 * added. The save must wait for it (the same tracker the edit forms use).
 */
describe('CommentTimeline edit save waits for an in-flight upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
  });

  it('saves after the attachment upload it was issued during has finished', async () => {
    let resolveUpload!: () => void;
    stateMock.uploadIssueCommentAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = () => resolve({ id: 1, uuid: 'uuid-1' });
        }),
    );

    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);

    const editForm = wrapper.find('.edit-comment-form');
    expect(editForm.exists()).toBe(true);

    // The user adds an attachment; its upload is still in flight when the save
    // is clicked.
    const attachmentList = editForm.findComponent({ name: 'AttachmentList' });
    expect(attachmentList.exists()).toBe(true);
    attachmentList.vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();
    await editForm.find('.edit-comment-actions vscode-button').trigger('click');
    await nextTick();

    expect(stateMock.editIssueComment).not.toHaveBeenCalled();

    resolveUpload();
    await flushPromises();

    expect(stateMock.editIssueComment).toHaveBeenCalledTimes(1);
    // The save carries the body the user edited, after the upload has landed.
    expect(stateMock.editIssueComment.mock.calls[0][4]).toBe('original');
    wrapper.unmount();
  });

  it('saves immediately when no upload is in flight', async () => {
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);

    await wrapper.find('.edit-comment-form .edit-comment-actions vscode-button').trigger('click');
    await flushPromises();

    expect(stateMock.editIssueComment).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
