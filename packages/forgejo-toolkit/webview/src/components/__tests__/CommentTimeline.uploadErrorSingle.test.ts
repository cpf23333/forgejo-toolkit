import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    showConfirm: vi.fn(async () => true),
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
  props: {
    modelValue: { type: String, default: '' },
    uploadImage: { type: Function, default: undefined },
  },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" :value="modelValue" />',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: { assets: { type: Array, default: () => [] } },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

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
    props: { comments: [comment], instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 1 },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub, AttachmentList: AttachmentListStub, ModalDialog: ModalDialogStub },
    },
  });
}

async function openEdit(wrapper: ReturnType<typeof mountTimeline>) {
  await wrapper.find('.comment-menu-wrapper button').trigger('click');
  await nextTick();
  const menu = wrapper.find('vscode-context-menu').element as HTMLElement & { data?: { value: string }[] };
  const edit = (menu.data ?? []).find((entry) => entry.value === 'edit');
  menu.dispatchEvent(new CustomEvent('vsc-context-menu-select', { detail: { value: edit?.value } }));
  await nextTick();
}

/**
 * A failed editor upload used to be reported twice, and the two reports said
 * different things: the editor's own line rendered `common.imageUploadFailed`
 * ("Image upload failed: Failed to upload image") while the per-comment notice
 * rendered the host's real reason. The editor's line is the one next to the image
 * picker, so the real cause belongs there - once.
 */
describe('CommentTimeline failed image upload is reported once', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.uploadIssueCommentAttachment.mockRejectedValue(new Error('Forbidden'));
  });

  it('reports the host reason in the editor and drops the duplicate notice', async () => {
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);

    const uploadImage = wrapper.findComponent(EasyMdeEditorStub).props('uploadImage') as (
      file: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => void;
    expect(uploadImage, 'editor upload handler').toBeTypeOf('function');

    const reported: string[] = [];
    uploadImage(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      () => {},
      (error: string) => reported.push(error),
    );
    await flushPromises();

    expect(stateMock.uploadIssueCommentAttachment).toHaveBeenCalledTimes(1);
    // The real cause reaches the message the user reads.
    expect(reported).toEqual(['Forbidden']);
    // ...and it is not repeated by the per-comment notice.
    expect(wrapper.find('.upload-error').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Failed to upload image');
    wrapper.unmount();
  });

  it('still reports a failure the host sent no reason for', async () => {
    stateMock.uploadIssueCommentAttachment.mockResolvedValue({});
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);

    const uploadImage = wrapper.findComponent(EasyMdeEditorStub).props('uploadImage') as (
      file: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => void;
    const reported: string[] = [];
    uploadImage(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      () => {},
      (error: string) => reported.push(error),
    );
    await flushPromises();

    // An attachment without a usable URL is a failure too: it still gets one
    // message instead of an empty one.
    expect(reported).toEqual(['Failed to upload image']);
    expect(wrapper.find('.upload-error').exists()).toBe(false);
    wrapper.unmount();
  });
});
