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
import ModalDialog from '../ModalDialog.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoTimelineComment } from '../../types/api';

// Keeps `update:modelValue` flowing back into the modal's body, which is what
// makes a typed edit mark the dialog dirty.
const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  template:
    '<textarea class="editor-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
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
    props: { comments: [comment], instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 1 },
    global: {
      plugins: [createTestI18n('en')],
      // The real modal is mounted on purpose: it is what Esc and × go through.
      stubs: { EasyMdeEditor: EasyMdeEditorStub, AttachmentList: AttachmentListStub },
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

function cancelButton(wrapper: ReturnType<typeof mountTimeline>) {
  return wrapper.findAll('.edit-comment-actions vscode-button')[1];
}

function dialog(wrapper: ReturnType<typeof mountTimeline>) {
  return wrapper.findComponent(ModalDialog);
}

/**
 * Esc and × already asked before discarding a typed comment body - the dialog
 * publishes its dirty state to the modal through `is-dirty` - but Cancel went
 * straight to `closeEdit`: it only confirmed while an upload was in flight, so an
 * edited body disappeared without a word. Cancel now routes through the same
 * check, and declining keeps the dialog (and the edit) open.
 */
describe('CommentTimeline edit dialog Cancel discard confirmation', () => {
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

  async function typeBody(wrapper: ReturnType<typeof mountTimeline>, value: string) {
    const editor = wrapper.find('.editor-stub');
    (editor.element as unknown as { value: string }).value = value;
    await editor.trigger('input');
    await nextTick();
  }

  it('asks before Cancel discards a typed edit and stays open when declined', async () => {
    stateMock.showConfirm.mockResolvedValue(false);
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);
    await typeBody(wrapper, 'a rewritten comment');
    expect(dialog(wrapper).props('isDirty')).toBe(true);

    await cancelButton(wrapper).trigger('click');
    await flushPromises();

    expect(stateMock.showConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
    expect(dialog(wrapper).props('open')).toBe(true);
    // The typed body is still there: nothing was saved, and nothing was lost.
    expect((wrapper.find('.editor-stub').element as unknown as { value: string }).value).toBe('a rewritten comment');
    wrapper.unmount();
  });

  it('closes once the discard is confirmed', async () => {
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);
    await typeBody(wrapper, 'a rewritten comment');

    await cancelButton(wrapper).trigger('click');
    await flushPromises();

    expect(stateMock.showConfirm).toHaveBeenCalledTimes(1);
    expect(dialog(wrapper).props('open')).toBe(false);
    wrapper.unmount();
  });

  it('closes a clean dialog without asking', async () => {
    const wrapper = mountTimeline();
    await nextTick();
    await openEdit(wrapper);

    await cancelButton(wrapper).trigger('click');
    await flushPromises();

    expect(stateMock.showConfirm).not.toHaveBeenCalled();
    expect(dialog(wrapper).props('open')).toBe(false);
    wrapper.unmount();
  });
});
