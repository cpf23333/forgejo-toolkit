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
  props: {
    assets: { type: Array, default: () => [] },
    allowUpload: { type: Boolean, default: false },
  },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

// Captures the busy state and the close guard the modal is given, so a test can
// see whether the X and Escape are inert - and whether closing would ask first -
// while an upload runs.
const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: {
    open: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    isDirty: { type: Boolean, default: false },
  },
  template: '<div class="modal-dialog-stub"><slot /></div>',
});

function comment(id: number, body: string, createdAt: string): ForgejoTimelineComment {
  return {
    id,
    type: 'comment',
    body,
    created_at: createdAt,
    user: {
      id: 1,
      login: 'demo-user',
      full_name: 'Demo User',
      email: 'demo-user@forgejo.example.com',
      avatar_url: 'https://forgejo.example.com/avatars/demo-user',
    },
  };
}

const commentA = comment(7, 'A body', '2026-01-01T00:00:00Z');
const commentB = comment(8, 'B body', '2026-01-02T00:00:00Z');

function mountTimeline() {
  return mount(CommentTimeline, {
    props: {
      comments: [commentA, commentB],
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

/** Opens one row's edit modal through the kebab menu the user clicks. */
async function openEdit(wrapper: ReturnType<typeof mountTimeline>, rowIndex: number) {
  const row = wrapper.findAll('.timeline-item')[rowIndex];
  await row.find('.comment-menu-wrapper button').trigger('click');
  await nextTick();
  const menu = row.find('vscode-context-menu').element as HTMLElement & { data?: { value: string }[] };
  const edit = (menu.data ?? []).find((entry) => entry.value === 'edit');
  menu.dispatchEvent(new CustomEvent('vsc-context-menu-select', { detail: { value: edit?.value } }));
  await nextTick();
}

function editAttachmentList(wrapper: ReturnType<typeof mountTimeline>) {
  return wrapper.find('.edit-comment-form').findComponent({ name: 'AttachmentList' });
}

function editEditor(wrapper: ReturnType<typeof mountTimeline>) {
  return wrapper.find('.edit-comment-form').findComponent({ name: 'EasyMdeEditor' });
}

/**
 * A comment's edit form is one shared editor, and its attachment list uploads
 * through the same state call. An upload that returns after the user has opened
 * another comment's form used to be appended to that other comment (and its
 * image markdown inserted into the other comment's body), because both read
 * `editingComment` at completion time instead of the comment the upload started
 * from.
 */
describe('CommentTimeline edit uploads stay on the comment they started from', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    commentA.assets = [];
    commentB.assets = [];
  });

  it('does not write an edit upload that finished late into the comment on screen', async () => {
    let resolveUpload!: (attachment: { id: number; uuid: string }) => void;
    stateMock.uploadIssueCommentAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper, 0);
    expect(wrapper.find('.edit-comment-form').exists()).toBe(true);

    // The user uploads an attachment on A, then opens B before it resolves.
    editAttachmentList(wrapper).vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();
    await openEdit(wrapper, 1);

    resolveUpload({ id: 1, uuid: 'uuid-a' });
    await flushPromises();

    // Nothing of A lands in the form now on screen...
    expect(editAttachmentList(wrapper).props('assets')).toEqual([]);
    expect((editEditor(wrapper).element as HTMLTextAreaElement).value).toBe('B body');

    // ...and A's own edit still receives the upload.
    await openEdit(wrapper, 0);
    expect(editAttachmentList(wrapper).props('assets')).toEqual([{ id: 1, uuid: 'uuid-a' }]);
    wrapper.unmount();
  });

  it('does not insert an image into the other comment body when the editor upload returns late', async () => {
    let resolveUpload!: (attachment: { id: number; uuid: string }) => void;
    stateMock.uploadIssueCommentAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper, 0);

    const editor = editEditor(wrapper);
    const onSuccess = vi.fn();
    const upload = (editor.vm as unknown as { uploadImage: (f: File, s: () => void, e: () => void) => Promise<void> })
      .uploadImage;
    const pending = upload(new File(['x'], 'shot.png', { type: 'image/png' }), onSuccess, vi.fn());

    await openEdit(wrapper, 1);
    resolveUpload({ id: 2, uuid: 'uuid-b' });
    await pending;
    await flushPromises();

    expect(onSuccess).not.toHaveBeenCalled();
    expect((editEditor(wrapper).element as HTMLTextAreaElement).value).toBe('B body');
    wrapper.unmount();
  });

  it('keeps the dialog closable - with a confirmation - while the upload is in flight', async () => {
    let resolveUpload!: (attachment: { id: number; uuid: string }) => void;
    stateMock.uploadIssueCommentAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper, 0);
    const modal = wrapper.findComponent({ name: 'ModalDialog' });
    expect(modal.props('loading')).toBe(false);

    editAttachmentList(wrapper).vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();

    // An upload in flight must not put the modal into its submit state: `loading`
    // hides the X and swallows Esc, which left the user with no way out of the
    // dialog until the request timed out (up to 60 s). It is unsaved work all the
    // same - its markdown is inserted when it answers - so closing asks first.
    expect(modal.props('loading')).toBe(false);
    expect(modal.props('isDirty')).toBe(true);

    resolveUpload({ id: 3, uuid: 'uuid-c' });
    await flushPromises();
    expect(modal.props('loading')).toBe(false);
    expect(modal.props('isDirty')).toBe(false);
    wrapper.unmount();
  });
});
