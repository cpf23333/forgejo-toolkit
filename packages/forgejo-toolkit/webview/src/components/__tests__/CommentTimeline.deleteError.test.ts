import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

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
      `${instanceId}:${owner}/${repo}:comment-${commentId}:edit-form`,
    issueCommentDeleteFormKey: (instanceId: string, owner: string, repo: string, commentId: number) =>
      `${instanceId}:${owner}/${repo}:comment-${commentId}:delete-form`,
  };
});

import CommentTimeline from '../CommentTimeline.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import { useAppState } from '../../composables/useAppState';
import type { ForgejoTimelineComment } from '../../types/api';

/**
 * A rejected delete (403/404/offline) leaves the comment on screen: the host
 * answers `issueCommentDeleted` with an error and useAppState stores it in
 * `errors` under `issueCommentDeleteFormKey(instanceId, owner, repo, commentId)`
 * (see handleIssueCommentDeleted). Nothing read that key, so the user saw a
 * comment that simply refused to disappear, with no reason given.
 */
describe('CommentTimeline delete failure feedback', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    // The failure implementation is per test; clearAllMocks keeps it otherwise.
    stateMock.deleteIssueComment.mockReset();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.commentReactions.value.clear();
  });

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
        // The real editor loads EasyMDE (and needs IntersectionObserver), which
        // this test does not exercise.
        stubs: { EasyMdeEditor: true },
      },
    });
  }

  /** Picks an entry of the comment's kebab menu, as the user does. */
  async function selectMenuAction(wrapper: ReturnType<typeof mountTimeline>, value: string) {
    await wrapper.find('.comment-menu-wrapper button').trigger('click');
    await nextTick();
    const menu = wrapper.find('vscode-context-menu').element as HTMLElement & { data?: { value: string }[] };
    const entry = (menu.data ?? []).find((item) => item.value === value);
    menu.dispatchEvent(new CustomEvent('vsc-context-menu-select', { detail: { value: entry?.value } }));
    await nextTick();
  }

  it('shows the failure message when the delete is rejected', async () => {
    stateMock.deleteIssueComment.mockImplementation(
      (instanceId: string, owner: string, repo: string, commentId: number) => {
        // What the host reply (`issueCommentDeleted` with an error) does to the
        // shared errors map; the key format is issueCommentDeleteFormKey's. The
        // write goes through the reactive store, like the real handler's does.
        useAppState().errors.set(`${instanceId}:${owner}/${repo}:comment-${commentId}:delete-form`, 'Forbidden');
      },
    );

    const wrapper = mountTimeline();
    await nextTick();
    expect(wrapper.text()).not.toContain('Forbidden');

    await selectMenuAction(wrapper, 'delete');
    await flushPromises();

    expect(stateMock.deleteIssueComment).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 7);
    // The comment stays on screen, so the reason it survived has to be shown.
    expect(wrapper.findAll('.timeline-item')).toHaveLength(1);
    expect(wrapper.find('.comment-delete-error').exists()).toBe(true);
    expect(wrapper.text()).toContain('Forbidden');

    wrapper.unmount();
  });

  it('shows no delete error when nothing failed', async () => {
    const wrapper = mountTimeline();
    await nextTick();

    await selectMenuAction(wrapper, 'delete');
    await flushPromises();

    expect(stateMock.deleteIssueComment).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.comment-delete-error').exists()).toBe(false);

    wrapper.unmount();
  });
});
