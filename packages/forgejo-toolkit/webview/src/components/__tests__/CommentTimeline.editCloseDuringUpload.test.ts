import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';

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
import ModalDialog from '../ModalDialog.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoTimelineComment } from '../../types/api';

// Keeps the editor's upload handler reachable from the test and records what the
// upload's success callback would insert into the body, so a late reply can be
// checked against a closed editor.
const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: {
    modelValue: { type: String, default: '' },
    uploadImage: { type: Function, default: undefined },
  },
  emits: ['update:modelValue'],
  setup(props) {
    const successes = ref<string[]>([]);
    function pickImage() {
      props.uploadImage?.(
        new File(['x'], 'shot.png', { type: 'image/png' }),
        (url: string) => successes.value.push(url),
        () => {},
      );
    }
    return { successes, pickImage };
  },
  template: '<div class="editor-stub"><button type="button" class="pick-image" @click="pickImage">pick</button></div>',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: { assets: { type: Array, default: () => [] } },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
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
      // The real modal is mounted on purpose: the X button it hides while
      // `loading` is what left the user stuck in the dialog.
      stubs: { EasyMdeEditor: EasyMdeEditorStub, AttachmentList: AttachmentListStub },
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
 * A `vscode-button` is a custom element, so Vue writes `disabled` as an
 * attribute: `"true"`/`"false"` rather than present/absent.
 */
function isDisabled(button: { attributes: (name: string) => string | undefined }): boolean {
  const value = button.attributes('disabled');
  return value !== undefined && value !== 'false';
}

/**
 * The edit dialog used to pass the whole busy state (including an image upload
 * still in flight) to ModalDialog as `loading`, which hides the X and swallows
 * Esc, and its Cancel button was disabled by the same flag. With an upload on the
 * wire the user could not close the dialog at all until the request timed out (up
 * to 60 s), while the upload's own failure left the body unchanged.
 */
describe('CommentTimeline edit dialog close during an upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.showConfirm.mockResolvedValue(true);
    if (typeof HTMLDialogElement !== 'undefined') {
      HTMLDialogElement.prototype.showModal = vi.fn();
      HTMLDialogElement.prototype.close = vi.fn();
    }
  });

  function startUpload(): { resolve: (attachment: { id: number; uuid: string }) => void } {
    let resolveUpload!: (attachment: { id: number; uuid: string }) => void;
    stateMock.uploadIssueCommentAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    return { resolve: (attachment) => resolveUpload(attachment) };
  }

  it('keeps the dialog closable while an upload runs, after a confirmation', async () => {
    const upload = startUpload();
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);

    await wrapper.find('.edit-comment-form .pick-image').trigger('click');
    await nextTick();
    expect(stateMock.uploadIssueCommentAttachment).toHaveBeenCalledTimes(1);

    // The dialog is not in its "submit in flight" state, so the X is there and
    // the dialog reports itself as dirty (the upload is unsaved work).
    const dialog = wrapper.findComponent(ModalDialog);
    expect(dialog.props('loading')).toBe(false);
    expect(dialog.props('isDirty')).toBe(true);
    expect(wrapper.find('.modal-close').exists()).toBe(true);
    expect(isDisabled(wrapper.findAll('.edit-comment-actions vscode-button')[1])).toBe(false);

    await wrapper.find('.modal-close').trigger('click');
    await flushPromises();

    expect(stateMock.showConfirm).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(ModalDialog).props('open')).toBe(false);

    upload.resolve({ id: 1, uuid: 'uuid-1' });
    await flushPromises();
    wrapper.unmount();
  });

  it('drops a late upload reply after the dialog was closed', async () => {
    const upload = startUpload();
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);

    await wrapper.find('.edit-comment-form .pick-image').trigger('click');
    await nextTick();

    // The user closes the dialog while the upload is still running.
    await wrapper.find('.modal-close').trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(ModalDialog).props('open')).toBe(false);

    // The upload answers afterwards. Its success callback inserts markdown into
    // the editor, so it must not run once the editor no longer shows that
    // comment; the attachment itself still belongs to the comment and is listed
    // on it.
    upload.resolve({ id: 1, uuid: 'uuid-1' });
    await flushPromises();

    const editor = wrapper.findComponent({ name: 'EasyMdeEditor' });
    expect(editor.vm.successes).toEqual([]);
    expect(stateMock.editIssueComment).not.toHaveBeenCalled();
    expect(wrapper.findComponent(ModalDialog).props('open')).toBe(false);
    wrapper.unmount();
  });

  it('asks before the Cancel button abandons a running upload', async () => {
    stateMock.showConfirm.mockResolvedValue(false);
    const upload = startUpload();
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);

    await wrapper.find('.edit-comment-form .pick-image').trigger('click');
    await nextTick();

    await wrapper.findAll('.edit-comment-actions vscode-button')[1].trigger('click');
    await flushPromises();

    // Declining keeps the dialog (and the upload) open.
    expect(stateMock.showConfirm).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(ModalDialog).props('open')).toBe(true);

    stateMock.showConfirm.mockResolvedValue(true);
    await wrapper.findAll('.edit-comment-actions vscode-button')[1].trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(ModalDialog).props('open')).toBe(false);

    upload.resolve({ id: 1, uuid: 'uuid-1' });
    await flushPromises();
    wrapper.unmount();
  });
});
